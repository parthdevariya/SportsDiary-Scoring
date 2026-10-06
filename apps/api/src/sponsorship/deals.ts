/**
 * Non-fixed-price selling: auctions (proxy bidding with anti-sniping), RFPs, offers and
 * negotiation threads. Every path ends in a normal order, so payment, activation and
 * invoicing are identical to a fixed-price checkout.
 */
import type { AuthUser } from '../auth.ts';
import { HttpError, id, type Ctx } from '../context.ts';
import type { DB } from '../db.ts';
import { J, P, now, tx } from '../db.ts';
import type { Marketplace } from './marketplace.ts';
import { format, toMinor } from './money.ts';
import type { Notifier } from './notify.ts';
import type { OrderService } from './orders.ts';

const SNIPE_WINDOW_MS = 2 * 60_000;
const WIN_HOLD_HOURS = 48;

export class Deals {
  constructor(private db: DB, private ctx: Ctx, private notify: Notifier, private market: Marketplace, private orders: OrderService) {}

  // ------------------------------------------------------------------ auctions
  private auctionPackage(packageId: string) {
    const p = this.db.prepare('SELECT p.*, o.org_id, o.title, o.status AS opp_status, o.currency AS opp_currency FROM sp_packages p JOIN sp_opportunities o ON o.id = p.opportunity_id WHERE p.id = ?').get(packageId) as any;
    if (!p || p.opp_status !== 'published' || !p.active) throw new HttpError(404, 'Auction not found', 'NOT_FOUND');
    if ((p.sale_model ?? '') !== 'auction' || !p.auction) throw new HttpError(409, 'This package is not sold by auction', 'WRONG_SALE_MODEL');
    return p;
  }

  /** Proxy bid: the sponsor states a maximum; the visible price rises only as needed to lead. */
  bid(user: AuthUser, sponsorId: string, packageId: string, maxAmount: number | string) {
    return tx(this.db, () => {
      const p = this.auctionPackage(packageId);
      const a = P<any>(p.auction);
      if (a.status !== 'open' || Date.parse(a.endsAt) <= Date.now()) throw new HttpError(409, 'Bidding has closed', 'AUCTION_CLOSED');
      let max: number;
      try {
        max = toMinor(maxAmount, p.currency);
      } catch {
        throw new HttpError(400, 'Enter a valid amount', 'VALIDATION');
      }
      const before = this.market.packageView(p).auction!;
      const leader = this.db.prepare('SELECT sponsor_id, max_minor FROM sp_bids WHERE package_id = ? AND withdrawn_at IS NULL ORDER BY max_minor DESC, created_at ASC LIMIT 1').get(p.id) as any;
      const mine = this.db.prepare('SELECT max_minor FROM sp_bids WHERE package_id = ? AND sponsor_id = ? AND withdrawn_at IS NULL').get(p.id, sponsorId) as any;
      const minimum = leader?.sponsor_id === sponsorId ? (mine?.max_minor ?? 0) + 1 : before.nextMinimumMinor;
      if (max < minimum) throw new HttpError(400, `Your maximum must be at least ${format(minimum, p.currency)}`, 'BID_TOO_LOW', { minimumMinor: minimum });
      this.db.prepare('UPDATE sp_bids SET withdrawn_at = ? WHERE package_id = ? AND sponsor_id = ? AND withdrawn_at IS NULL').run(now(), p.id, sponsorId);
      this.db.prepare('INSERT INTO sp_bids (id, package_id, sponsor_id, max_minor, created_by, created_at) VALUES (?,?,?,?,?,?)').run(id(), p.id, sponsorId, max, user.id, now());
      // anti-sniping: a bid in the final minutes extends the auction
      if (Date.parse(a.endsAt) - Date.now() < SNIPE_WINDOW_MS) {
        a.endsAt = new Date(Date.now() + SNIPE_WINDOW_MS).toISOString();
        this.db.prepare('UPDATE sp_packages SET auction = ? WHERE id = ?').run(J(a), p.id);
      }
      const after = this.market.packageView(this.db.prepare('SELECT * FROM sp_packages WHERE id = ?').get(p.id) as any).auction!;
      const newLeader = this.db.prepare('SELECT sponsor_id FROM sp_bids WHERE package_id = ? AND withdrawn_at IS NULL ORDER BY max_minor DESC, created_at ASC LIMIT 1').get(p.id) as any;
      this.ctx.audit(p.org_id, user.id, 'auction.bid', 'sp_package', p.id, { sponsorId, max });
      if (leader && leader.sponsor_id !== sponsorId && newLeader.sponsor_id === sponsorId) {
        void this.notify.event({ event: 'auction.outbid', sponsorId: leader.sponsor_id, title: `You've been outbid · ${p.name}`, body: `The price for ${p.name} (${p.title}) is now ${after.current}. Raise your maximum before ${a.endsAt.slice(0, 16).replace('T', ' ')} UTC.`, link: `/sponsorships/${p.opportunity_id}` });
      }
      return { leading: newLeader.sponsor_id === sponsorId, auction: after };
    });
  }

  /** Close every auction past its end time. Winner pays the visible (second-price + increment) amount. */
  closeAuctions(at = new Date()) {
    let closed = 0;
    for (const p of this.db.prepare("SELECT * FROM sp_packages WHERE sale_model = 'auction' AND auction IS NOT NULL").all() as any[]) {
      const a = P<any>(p.auction);
      if (a.status !== 'open' || Date.parse(a.endsAt) > at.getTime()) continue;
      const view = this.market.packageView(p).auction!;
      const top = this.db.prepare('SELECT * FROM sp_bids WHERE package_id = ? AND withdrawn_at IS NULL ORDER BY max_minor DESC, created_at ASC LIMIT 1').get(p.id) as any;
      const opp = this.db.prepare('SELECT * FROM sp_opportunities WHERE id = ?').get(p.opportunity_id) as any;
      a.status = top && view.reserveMet ? 'won' : 'unsold';
      a.closedAt = at.toISOString();
      if (a.status === 'won') {
        a.winner = top.sponsor_id;
        a.priceMinor = view.currentMinor;
      }
      this.db.prepare('UPDATE sp_packages SET auction = ? WHERE id = ?').run(J(a), p.id);
      closed++;
      if (a.status !== 'won') {
        void this.notify.event({ event: 'auction.unsold', orgId: opp.org_id, title: `Auction closed without a winner · ${p.name}`, body: top ? 'The reserve price was not met.' : 'No bids were placed.' });
        continue;
      }
      const user = this.db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(top.created_by) as any;
      try {
        const order = this.orders.createOrder({ id: user.id, orgId: '', email: user.email, name: user.name, role: 'member' }, top.sponsor_id, { opportunityId: opp.id, packageId: p.id, idempotencyKey: `auction:${p.id}` }, 'auction', {
          subtotalOverride: view.currentMinor, holdUntil: new Date(at.getTime() + WIN_HOLD_HOURS * 3600e3).toISOString(),
        });
        a.orderId = order.id;
        this.db.prepare('UPDATE sp_packages SET auction = ? WHERE id = ?').run(J(a), p.id);
        void this.notify.event({ event: 'auction.won', sponsorId: top.sponsor_id, orgId: opp.org_id, title: `You won ${p.name}!`, body: `Winning price ${view.current} (+ taxes). Complete payment within ${WIN_HOLD_HOURS} hours to secure it.`, link: `/sponsor#order=${order.id}`, channels: ['email', 'whatsapp'] });
      } catch (e: any) {
        this.ctx.audit(opp.org_id, null, 'auction.order_failed', 'sp_package', p.id, { error: String(e?.message ?? e) });
      }
      for (const loser of this.db.prepare('SELECT DISTINCT sponsor_id FROM sp_bids WHERE package_id = ? AND sponsor_id != ? AND withdrawn_at IS NULL').all(p.id, top.sponsor_id) as any[]) {
        void this.notify.event({ event: 'auction.lost', sponsorId: loser.sponsor_id, title: `Auction ended · ${p.name}`, body: `Another sponsor won at ${view.current}.` });
      }
    }
    return closed;
  }

  myBids(sponsorId: string) {
    return (this.db.prepare('SELECT b.package_id, b.max_minor, b.created_at, p.name, p.currency, p.opportunity_id, p.auction FROM sp_bids b JOIN sp_packages p ON p.id = b.package_id WHERE b.sponsor_id = ? AND b.withdrawn_at IS NULL ORDER BY b.created_at DESC').all(sponsorId) as any[]).map((b) => {
      const p = this.db.prepare('SELECT * FROM sp_packages WHERE id = ?').get(b.package_id) as any;
      const a = this.market.packageView(p).auction!;
      const top = this.db.prepare('SELECT sponsor_id FROM sp_bids WHERE package_id = ? AND withdrawn_at IS NULL ORDER BY max_minor DESC, created_at ASC LIMIT 1').get(p.id) as any;
      return { packageId: b.package_id, package: b.name, opportunityId: b.opportunity_id, yourMax: format(b.max_minor, b.currency), leading: top?.sponsor_id === sponsorId, auction: a, result: P<any>(b.auction).status };
    });
  }

  // ------------------------------------------------------------------ RFP, offers, negotiation
  startThread(user: AuthUser, sponsorId: string, b: any) {
    const opp = this.db.prepare("SELECT * FROM sp_opportunities WHERE id = ? AND status = 'published'").get(b.opportunityId) as any;
    if (!opp) throw new HttpError(404, 'Opportunity not found', 'NOT_FOUND');
    const pkg = b.packageId ? (this.db.prepare('SELECT * FROM sp_packages WHERE id = ? AND opportunity_id = ? AND active = 1').get(b.packageId, opp.id) as any) : null;
    if (b.packageId && !pkg) throw new HttpError(404, 'Package not found', 'NOT_FOUND');
    const body = String(b.message ?? '').trim();
    if (body.length < 5) throw new HttpError(400, 'Write a short message to the organizer', 'VALIDATION');
    const offer = b.offer != null && b.offer !== '' ? toMinor(b.offer, opp.currency) : null;
    if (offer != null && offer <= 0) throw new HttpError(400, 'Offer must be positive', 'VALIDATION');
    if (offer != null && !pkg) throw new HttpError(400, 'Choose the package your offer is for', 'VALIDATION');
    const open = (this.db.prepare("SELECT COUNT(*) AS n FROM sp_threads WHERE sponsor_id = ? AND status = 'open'").get(sponsorId) as any).n;
    if (open >= 50) throw new HttpError(429, 'You have too many open conversations', 'RATE_LIMIT');
    const tid = id();
    const kind = offer != null ? 'offer' : (pkg?.sale_model ?? opp.sale_model) === 'rfp' ? 'rfp' : 'enquiry';
    tx(this.db, () => {
      this.db.prepare('INSERT INTO sp_threads (id, org_id, sponsor_id, opportunity_id, package_id, kind, status, offer_minor, currency, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(tid, opp.org_id, sponsorId, opp.id, pkg?.id ?? null, kind, 'open', offer, opp.currency, now(), now());
      this.db.prepare('INSERT INTO sp_messages (id, thread_id, author_id, author_side, body, offer_minor, created_at) VALUES (?,?,?,?,?,?,?)').run(id(), tid, user.id, 'sponsor', body.slice(0, 4000), offer, now());
    });
    const sp = this.db.prepare('SELECT name FROM sponsor_accounts WHERE id = ?').get(sponsorId) as any;
    void this.notify.event({ event: 'deal.enquiry', orgId: opp.org_id, title: `${kind === 'offer' ? 'New offer' : 'New enquiry'} from ${sp.name}`, body: `${opp.title}${offer != null ? ` · offer ${format(offer, opp.currency)}` : ''}: "${body.slice(0, 140)}"`, link: `/console#deals/${tid}` });
    return this.thread(tid, { sponsorId });
  }

  private loadThread(tid: string, viewer: { sponsorId?: string; orgId?: string }) {
    const t = this.db.prepare('SELECT * FROM sp_threads WHERE id = ?').get(tid) as any;
    if (!t || (viewer.sponsorId && t.sponsor_id !== viewer.sponsorId) || (viewer.orgId && t.org_id !== viewer.orgId) || (!viewer.sponsorId && !viewer.orgId)) throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
    return t;
  }

  thread(tid: string, viewer: { sponsorId?: string; orgId?: string }) {
    const t = this.loadThread(tid, viewer);
    const opp = this.db.prepare('SELECT title, slug FROM sp_opportunities WHERE id = ?').get(t.opportunity_id) as any;
    const pkg = t.package_id ? (this.db.prepare('SELECT name, price_minor FROM sp_packages WHERE id = ?').get(t.package_id) as any) : null;
    const sp = this.db.prepare('SELECT name, slug FROM sponsor_accounts WHERE id = ?').get(t.sponsor_id) as any;
    const msgs = (this.db.prepare('SELECT m.*, u.name AS author FROM sp_messages m LEFT JOIN users u ON u.id = m.author_id WHERE thread_id = ? ORDER BY created_at').all(t.id) as any[]).map((m) => ({
      id: m.id, side: m.author_side, author: m.author, body: m.body, offerMinor: m.offer_minor, offer: m.offer_minor != null ? format(m.offer_minor, t.currency) : null, at: m.created_at,
    }));
    const lastOffer = [...msgs].reverse().find((m) => m.offerMinor != null);
    return {
      id: t.id, kind: t.kind, status: t.status, opportunity: opp?.title, opportunityId: t.opportunity_id, package: pkg?.name ?? null, packageId: t.package_id,
      listPrice: pkg?.price_minor != null ? format(pkg.price_minor, t.currency) : null, sponsor: sp?.name, sponsorSlug: sp?.slug, currency: t.currency,
      currentOffer: lastOffer ? { side: lastOffer.side, amountMinor: lastOffer.offerMinor, amount: lastOffer.offer } : null, orderId: t.order_id, messages: msgs, updatedAt: t.updated_at,
    };
  }

  list(viewer: { sponsorId?: string; orgId?: string }) {
    const rows = this.db.prepare(`SELECT id FROM sp_threads WHERE ${viewer.sponsorId ? 'sponsor_id' : 'org_id'} = ? ORDER BY updated_at DESC LIMIT 200`).all(viewer.sponsorId ?? viewer.orgId!) as any[];
    return rows.map((r) => {
      const t = this.thread(r.id, viewer);
      return { ...t, messages: undefined, lastMessage: t.messages.at(-1) ?? null };
    });
  }

  reply(user: AuthUser, tid: string, side: 'sponsor' | 'organizer', viewer: { sponsorId?: string; orgId?: string }, b: any) {
    const t = this.loadThread(tid, viewer);
    if (t.status !== 'open') throw new HttpError(409, 'This conversation is closed', 'INVALID_STATE');
    const body = String(b.message ?? '').trim();
    const offer = b.offer != null && b.offer !== '' ? toMinor(b.offer, t.currency) : null;
    if (!body && offer == null) throw new HttpError(400, 'Write a message or make an offer', 'VALIDATION');
    if (offer != null && !t.package_id) throw new HttpError(400, 'Offers need a package. Start a new conversation for a specific package.', 'VALIDATION');
    this.db.prepare('INSERT INTO sp_messages (id, thread_id, author_id, author_side, body, offer_minor, created_at) VALUES (?,?,?,?,?,?,?)').run(id(), t.id, user.id, side, (body || (offer != null ? 'New offer' : '')).slice(0, 4000), offer, now());
    this.db.prepare(`UPDATE sp_threads SET updated_at = ?, offer_minor = COALESCE(?, offer_minor), kind = CASE WHEN ? IS NOT NULL THEN 'offer' ELSE kind END WHERE id = ?`).run(now(), offer, offer, t.id);
    const opp = this.db.prepare('SELECT title FROM sp_opportunities WHERE id = ?').get(t.opportunity_id) as any;
    const msg = `${opp.title}${offer != null ? ` · ${side === 'organizer' ? 'proposal' : 'offer'} ${format(offer, t.currency)}` : ''}: "${body.slice(0, 140)}"`;
    if (side === 'organizer') void this.notify.event({ event: 'deal.reply', sponsorId: t.sponsor_id, title: offer != null ? 'New proposal from the organizer' : 'Organizer replied', body: msg, link: `/sponsor#deal=${t.id}` });
    else void this.notify.event({ event: 'deal.reply', orgId: t.org_id, title: offer != null ? 'Counter-offer from sponsor' : 'Sponsor replied', body: msg, link: `/console#deals/${t.id}` });
    return this.thread(t.id, viewer);
  }

  /** Accept the other side's latest offer → an order at that price, held for 72 h. */
  accept(user: AuthUser, tid: string, side: 'sponsor' | 'organizer', viewer: { sponsorId?: string; orgId?: string }) {
    const t = this.loadThread(tid, viewer);
    if (t.status !== 'open') throw new HttpError(409, 'This conversation is closed', 'INVALID_STATE');
    const last = this.db.prepare('SELECT * FROM sp_messages WHERE thread_id = ? AND offer_minor IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(t.id) as any;
    if (!last) throw new HttpError(409, 'There is no offer to accept yet', 'NO_OFFER');
    if (last.author_side === side) throw new HttpError(409, 'Wait for the other side to respond to your offer', 'OWN_OFFER');
    // the order belongs to the sponsor; when the organizer accepts, a billing member of the sponsor is recorded as creator
    const buyer = side === 'sponsor' ? user : (this.db.prepare("SELECT u.id, u.email, u.name FROM sponsor_members m JOIN users u ON u.id = m.user_id WHERE m.sponsor_id = ? AND m.role IN ('owner','admin','marketing') ORDER BY m.created_at LIMIT 1").get(t.sponsor_id) as any);
    const order = this.orders.createOrder({ id: buyer.id, orgId: '', email: buyer.email, name: buyer.name, role: 'member' }, t.sponsor_id, { opportunityId: t.opportunity_id, packageId: t.package_id, idempotencyKey: `deal:${t.id}` }, 'negotiated', {
      subtotalOverride: last.offer_minor, holdUntil: new Date(Date.now() + 72 * 3600e3).toISOString(),
    });
    this.db.prepare("UPDATE sp_threads SET status = 'accepted', order_id = ?, updated_at = ? WHERE id = ?").run(order.id, now(), t.id);
    this.db.prepare('INSERT INTO sp_messages (id, thread_id, author_id, author_side, body, created_at) VALUES (?,?,?,?,?,?)').run(id(), t.id, user.id, side, `Accepted ${format(last.offer_minor, t.currency)}. Order ${order.number} created.`, now());
    this.ctx.audit(t.org_id, user.id, 'deal.accepted', 'sp_thread', t.id, { orderId: order.id, amount: last.offer_minor });
    void this.notify.event({ event: 'deal.accepted', sponsorId: t.sponsor_id, orgId: t.org_id, title: `Deal agreed · ${order.number}`, body: `Agreed at ${format(last.offer_minor, t.currency)} (+ taxes). The sponsor has 72 hours to pay.`, link: `/sponsor#order=${order.id}`, channels: ['email', 'whatsapp'] });
    return { thread: this.thread(t.id, viewer), order };
  }

  decline(user: AuthUser, tid: string, side: 'sponsor' | 'organizer', viewer: { sponsorId?: string; orgId?: string }, reason?: string) {
    const t = this.loadThread(tid, viewer);
    if (t.status !== 'open') throw new HttpError(409, 'This conversation is closed', 'INVALID_STATE');
    this.db.prepare("UPDATE sp_threads SET status = 'declined', updated_at = ? WHERE id = ?").run(now(), t.id);
    this.db.prepare('INSERT INTO sp_messages (id, thread_id, author_id, author_side, body, created_at) VALUES (?,?,?,?,?,?)').run(id(), t.id, user.id, side, `Closed the conversation${reason ? `: ${reason}` : ''}.`, now());
    return this.thread(t.id, viewer);
  }
}
