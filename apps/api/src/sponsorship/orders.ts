/**
 * Sponsorship orders: checkout → payment → verification → activation → renewal/refund.
 *
 *   createOrder   price computed server-side; inventory held for the sponsor (holdMinutes)
 *   pay           agreement accepted (hashed), provider checkout opened
 *   webhook       signature verified over the raw body → idempotent (provider, event id)
 *                 → amount/currency reconciled → PAYMENT_RECEIVED + ledger + invoice + receipt
 *                 → approval mode: ACTIVE | PENDING_APPROVAL | ASSET_REVIEW
 *   confirm       same capture path, but verified by calling the provider API from the server
 *
 * The browser NEVER marks anything paid. Duplicate payments are refunded automatically;
 * a payment for a hold that lapsed revives the order if stock remains, otherwise refunds.
 */
import type { AuthUser } from '../auth.ts';
import { HttpError, id, type Ctx } from '../context.ts';
import type { DB } from '../db.ts';
import { J, P, now, tx } from '../db.ts';
import type { Branding } from './branding.ts';
import { today } from './branding.ts';
import { inventoryType } from './catalog.ts';
import { Documents, agreementModel, confirmationModel, financialYear, invoiceModel, money, nextNumber, noticeModel, receiptModel, type OrderDocContext } from './documents.ts';
import type { Marketplace } from './marketplace.ts';
import { bps, format, price } from './money.ts';
import type { Notifier } from './notify.ts';
import { PaymentRegistry, SignatureError, type PaymentProvider, type WebhookEvent } from './payments/index.ts';
import { getOrgSettings, getPlatformSettings } from './settings.ts';

export const ORDER_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['PENDING_PAYMENT', 'CANCELLED'],
  PENDING_PAYMENT: ['PAYMENT_RECEIVED', 'CANCELLED'],
  PAYMENT_RECEIVED: ['PENDING_APPROVAL', 'ASSET_REVIEW', 'ACTIVE', 'CANCELLED'],
  PENDING_APPROVAL: ['ASSET_REVIEW', 'ACTIVE', 'CANCELLED'],
  ASSET_REVIEW: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'EXPIRED', 'CANCELLED', 'REFUNDED'],
  PAUSED: ['ACTIVE', 'EXPIRED', 'CANCELLED', 'REFUNDED'],
  EXPIRED: ['REFUNDED'],
  CANCELLED: ['PAYMENT_RECEIVED', 'REFUNDED'], // late capture revives a lapsed hold
  REFUNDED: [],
};
/** States in which an order occupies a package slot. */
export const COMMITTED: OrderStatus[] = ['PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW', 'ACTIVE', 'PAUSED'];
const IN = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');

/** Which uploaded asset kinds can fill which creative role. */
const ROLE_KINDS: Record<string, string[]> = {
  logo: ['logo', 'logo_transparent', 'logo_white', 'logo_dark'],
  logo_dark: ['logo_dark', 'logo_white', 'logo_transparent', 'logo'],
  banner: ['banner', 'promo_image'],
  video: ['video'],
  copy: ['ad_copy'],
};
const URL_RE = /^https?:\/\/[^\s]+$/i;
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

export type Actor = { id: string | null; kind: 'sponsor' | 'organizer' | 'platform' | 'system' | 'provider' };

export interface OrderDeps {
  db: DB;
  ctx: Ctx;
  notify: Notifier;
  registry: PaymentRegistry;
  market: Marketplace;
  branding: Branding;
  docs: Documents;
  /** Called after anything that changes what is displayed for an organizer. */
  onBrandingChange(orgId: string): void;
  baseUrl(): string;
}

export class OrderService {
  private db: DB;
  constructor(private d: OrderDeps) {
    this.db = d.db;
  }

  // ------------------------------------------------------------------ helpers
  row(orderId: string) {
    const o = this.db.prepare('SELECT * FROM sp_orders WHERE id = ? OR number = ?').get(orderId, orderId) as any;
    if (!o) throw new HttpError(404, 'Sponsorship not found', 'NOT_FOUND');
    return o;
  }
  forSponsor(sponsorId: string, orderId: string) {
    const o = this.row(orderId);
    if (o.sponsor_id !== sponsorId) throw new HttpError(404, 'Sponsorship not found', 'NOT_FOUND');
    return o;
  }
  forOrg(orgId: string, orderId: string) {
    const o = this.row(orderId);
    if (o.org_id !== orgId) throw new HttpError(404, 'Sponsorship not found', 'NOT_FOUND');
    return o;
  }

  private transition(o: any, to: OrderStatus, actor: Actor, note?: string) {
    const from = o.status as OrderStatus;
    if (from === to) return o;
    if (!TRANSITIONS[from]?.includes(to)) throw new HttpError(409, `A ${from.replace(/_/g, ' ').toLowerCase()} sponsorship can't move to ${to.replace(/_/g, ' ').toLowerCase()}`, 'INVALID_STATE');
    // optimistic guard: only move if nobody else moved it meanwhile
    const r = this.db.prepare('UPDATE sp_orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, now(), o.id, from);
    if (!Number(r.changes)) throw new HttpError(409, 'This sponsorship was updated by someone else. Refresh and try again.', 'CONFLICT');
    this.db.prepare('INSERT INTO sp_order_events (order_id, from_status, to_status, actor_id, actor_kind, note, at) VALUES (?,?,?,?,?,?,?)').run(o.id, from, to, actor.id, actor.kind, note ?? null, now());
    this.d.ctx.audit(o.org_id, actor.id, `sponsorship.${to.toLowerCase()}`, 'sp_order', o.id, { from, note, actor: actor.kind });
    o.status = to;
    if (COMMITTED.includes(from) !== COMMITTED.includes(to) && o.package_id) this.recount(o.package_id);
    return o;
  }

  private note(o: any, actor: Actor, note: string) {
    this.db.prepare('INSERT INTO sp_order_events (order_id, from_status, to_status, actor_id, actor_kind, note, at) VALUES (?,?,?,?,?,?,?)').run(o.id, o.status, o.status, actor.id, actor.kind, note, now());
  }

  private addRisk(o: any, flag: string) {
    const risk = P<string[]>(o.risk, []);
    if (!risk.includes(flag)) risk.push(flag);
    this.db.prepare('UPDATE sp_orders SET risk = ? WHERE id = ?').run(J(risk), o.id);
    o.risk = J(risk);
  }

  /** Keep sp_packages.sold equal to the number of orders occupying a slot. */
  recount(packageId: string) {
    const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM sp_orders WHERE package_id = ? AND status IN (${IN(COMMITTED)})`).get(packageId) as any).n;
    this.db.prepare('UPDATE sp_packages SET sold = ? WHERE id = ?').run(n, packageId);
  }

  /** Throws SOLD_OUT unless the package (and every inventory line) has room for one more order. */
  private assertStock(pkg: any, items: { inventory_id: string; quantity: number }[], o: { id?: string; renewal_of?: string | null }) {
    const exclude = [o.id, o.renewal_of].filter(Boolean) as string[];
    const ex = exclude.length ? `AND id NOT IN (${exclude.map(() => '?').join(',')})` : '';
    const used = (this.db.prepare(`SELECT COUNT(*) AS n FROM sp_orders WHERE package_id = ? ${ex} AND (status IN (${IN(COMMITTED)}) OR (status = 'PENDING_PAYMENT' AND hold_expires_at > ?))`).get(pkg.id, ...exclude, now()) as any).n;
    if (used >= pkg.max_sponsors) throw new HttpError(409, `${pkg.name} is sold out`, 'SOLD_OUT');
    for (const it of items) {
      const inv = this.db.prepare('SELECT quantity, name FROM sp_inventory WHERE id = ?').get(it.inventory_id) as any;
      if (!inv) continue;
      const sold = (this.db.prepare(`SELECT COALESCE(SUM(oi.quantity),0) AS n FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id WHERE oi.inventory_id = ? ${exclude.length ? `AND o.id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
        AND (o.status IN (${IN(COMMITTED)}) OR (o.status = 'PENDING_PAYMENT' AND o.hold_expires_at > ?))`).get(it.inventory_id, ...exclude, now()) as any).n;
      if (sold + it.quantity > inv.quantity) throw new HttpError(409, `${inv.name} is no longer available`, 'SOLD_OUT');
    }
  }

  private docContext(o: any): OrderDocContext {
    const opp = this.db.prepare('SELECT * FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
    const pkg = o.package_id ? (this.db.prepare('SELECT name FROM sp_packages WHERE id = ?').get(o.package_id) as any) : null;
    const s = getOrgSettings(this.db, o.org_id);
    const a = this.db.prepare('SELECT * FROM sponsor_accounts WHERE id = ?').get(o.sponsor_id) as any;
    const billing = P<any>(o.billing, {});
    const items = (this.db.prepare('SELECT * FROM sp_order_items WHERE order_id = ?').all(o.id) as any[]).map((i) => ({
      label: inventoryType(i.type)?.label ?? i.name, quantity: i.quantity, scope: i.scope_type === 'org' ? 'All organizer events' : i.scope_type, deliverable: !!inventoryType(i.type)?.deliverable,
    }));
    return {
      order: o, opportunity: opp, packageName: pkg?.name ?? 'Custom sponsorship', items, approvalMode: opp.approval_mode,
      seller: { legalName: s.legalName, gstin: s.gstin, address: s.address, state: s.state },
      buyer: { name: a.name, legalName: billing.legalName ?? a.name, taxId: billing.taxId ?? a.tax_id, address: billing.address ?? a.address, state: billing.state ?? null, country: billing.country ?? a.country, email: billing.email ?? a.email },
    };
  }

  /** Validate {role: assetId} against the sponsor's library; fall back to the profile logo. */
  private resolveAssets(sponsorId: string, requested: Record<string, string> | undefined, needed: Set<string>) {
    const out: Record<string, string> = {};
    for (const [role, assetId] of Object.entries(requested ?? {})) {
      if (!ROLE_KINDS[role]) throw new HttpError(400, `Unknown creative role ${role}`, 'VALIDATION', { allowed: Object.keys(ROLE_KINDS) });
      if (!assetId) continue;
      const a = this.db.prepare('SELECT id, kind, status FROM sponsor_assets WHERE id = ? AND sponsor_id = ?').get(assetId, sponsorId) as any;
      if (!a || a.status === 'deleted') throw new HttpError(400, `Asset for ${role} not found in your library`, 'VALIDATION');
      if (a.status === 'blocked') throw new HttpError(422, `The ${role.replace('_', ' ')} you chose was blocked by moderation`, 'BLOCKED');
      if (!ROLE_KINDS[role].includes(a.kind)) throw new HttpError(400, `A ${a.kind.replace('_', ' ')} can't be used as ${role.replace('_', ' ')}`, 'VALIDATION');
      out[role] = a.id;
    }
    if (needed.has('logo') && !out.logo) {
      const acct = this.db.prepare("SELECT s.id FROM sponsor_accounts a JOIN sponsor_assets s ON s.id = a.logo_asset_id WHERE a.id = ? AND s.status IN ('ready','flagged')").get(sponsorId) as any;
      const any = acct ?? (this.db.prepare("SELECT id FROM sponsor_assets WHERE sponsor_id = ? AND kind IN ('logo','logo_transparent') AND status = 'ready' ORDER BY created_at DESC LIMIT 1").get(sponsorId) as any);
      if (!any) throw new HttpError(400, 'Upload your logo first — it is shown on screens and live pages', 'LOGO_REQUIRED');
      out.logo = any.id;
    }
    return out;
  }

  // ------------------------------------------------------------------ quote & create
  /** Server-side price for a package (also used for the public quote before sign-in). */
  quote(opportunityId: string, packageId: string, opts: { sponsorCountry?: string | null; currency?: string; subtotalOverride?: number } = {}) {
    const opp = this.db.prepare("SELECT * FROM sp_opportunities WHERE id = ? AND status = 'published'").get(opportunityId) as any;
    if (!opp) throw new HttpError(404, 'Opportunity not found', 'NOT_FOUND');
    const pkg = this.db.prepare('SELECT * FROM sp_packages WHERE id = ? AND opportunity_id = ? AND active = 1').get(packageId, opp.id) as any;
    if (!pkg) throw new HttpError(404, 'Package not found', 'NOT_FOUND');
    const subtotal = opts.subtotalOverride ?? pkg.price_minor;
    if (subtotal == null) throw new HttpError(409, 'This package is priced by proposal. Send an enquiry instead.', 'NO_PRICE');
    const s = getOrgSettings(this.db, opp.org_id);
    // Services exported outside India (or billed in foreign currency) are zero-rated.
    const zeroRated = opp.currency !== 'INR' || (opts.sponsorCountry && opts.sponsorCountry !== 'India');
    const feeMinor = opp.currency === 'INR' ? s.platformFeeMinor : 0;
    const p = price(subtotal, { platformFee: feeMinor, taxRateBps: zeroRated ? 0 : s.taxRateBps, commissionBps: s.commissionBps });
    return { opp, pkg, settings: s, breakdown: p, display: { subtotal: format(p.subtotal, opp.currency), platformFee: format(p.platformFee, opp.currency), tax: format(p.tax, opp.currency), total: format(p.total, opp.currency), taxLabel: zeroRated ? 'Tax (zero-rated)' : `GST ${p.taxRateBps / 100}%` } };
  }

  createOrder(user: AuthUser, sponsorId: string, b: any, source: 'checkout' | 'negotiated' | 'auction' | 'renewal' = 'checkout', extra: { subtotalOverride?: number; renewalOf?: string; holdUntil?: string } = {}) {
    const key = b.idempotencyKey ? String(b.idempotencyKey).slice(0, 80) : null;
    if (key) {
      const prior = this.db.prepare('SELECT * FROM sp_orders WHERE sponsor_id = ? AND idempotency_key = ?').get(sponsorId, key) as any;
      if (prior) return this.view(prior, 'sponsor');
    }
    if (!b.opportunityId || !b.packageId) throw new HttpError(400, 'opportunityId and packageId are required', 'VALIDATION');
    const acct = this.db.prepare('SELECT * FROM sponsor_accounts WHERE id = ?').get(sponsorId) as any;
    const settings = getPlatformSettings(this.db);
    const { opp, pkg, settings: orgS, breakdown } = this.quote(b.opportunityId, b.packageId, { sponsorCountry: P<any>(acct.billing, {}).country ?? acct.country, subtotalOverride: extra.subtotalOverride });
    if (!orgS.marketplaceEnabled) throw new HttpError(403, 'This organizer is not accepting sponsorships right now', 'MARKETPLACE_DISABLED');
    const model = pkg.sale_model ?? opp.sale_model;
    if (source === 'checkout' && (model === 'auction' || model === 'rfp')) throw new HttpError(409, model === 'auction' ? 'This package is sold by auction. Place a bid instead.' : 'This package is sold by proposal. Send an enquiry instead.', 'WRONG_SALE_MODEL');
    if (acct.industry && settings.prohibitedCategories.includes(acct.industry)) throw new HttpError(403, 'Sponsors in this category cannot advertise on the platform', 'PROHIBITED_CATEGORY');

    // fraud velocity: many orders in a short window from one sponsor is blocked and logged
    const recent = (this.db.prepare("SELECT COUNT(*) AS n FROM sp_orders WHERE sponsor_id = ? AND created_at > ? AND source = 'checkout'").get(sponsorId, new Date(Date.now() - 3600e3).toISOString()) as any).n;
    if (source === 'checkout' && recent >= settings.maxOrdersPerHour) {
      this.d.ctx.audit(opp.org_id, user.id, 'sponsorship.velocity_block', 'sponsor', sponsorId, { recent });
      throw new HttpError(429, 'Too many orders in the last hour. Try again later or contact support.', 'RATE_LIMIT');
    }

    // dates
    const startsOn = b.startsOn ?? (opp.starts_on && opp.starts_on > today() ? opp.starts_on : today());
    if (!isDate(startsOn)) throw new HttpError(400, 'startsOn must be YYYY-MM-DD', 'VALIDATION');
    if (startsOn < today() && source !== 'renewal') throw new HttpError(400, 'The start date is in the past', 'VALIDATION');
    if (source !== 'renewal' && opp.ends_on && startsOn > opp.ends_on) throw new HttpError(400, 'The start date is after this opportunity ends', 'VALIDATION');
    const endsOn = pkg.duration_days ? addDays(startsOn, pkg.duration_days - 1) : opp.ends_on && opp.ends_on >= startsOn ? opp.ends_on : addDays(startsOn, 29);

    const items = this.db.prepare('SELECT pi.inventory_id, pi.quantity, i.type, i.name, i.scope_type, i.scope_id, i.unit_price_minor FROM sp_package_items pi JOIN sp_inventory i ON i.id = pi.inventory_id WHERE pi.package_id = ?').all(pkg.id) as any[];
    const needed = new Set(items.flatMap((i) => inventoryType(i.type)?.assets ?? []));
    // checkout needs a logo up front; auction wins / agreed deals can supply creative after payment
    const assets = this.resolveAssets(sponsorId, b.assetIds, source === 'checkout' ? needed : new Set());
    if (b.clickUrl && !URL_RE.test(b.clickUrl)) throw new HttpError(400, 'The click-through link must start with http:// or https://', 'VALIDATION');
    const billing = { ...P<any>(acct.billing, {}), ...(b.billing ?? {}) };
    delete billing.providerCustomers;

    const draft = !!b.draft && source === 'checkout';
    const oid = id();
    const t = now();
    const holdUntil = extra.holdUntil ?? new Date(Date.now() + settings.holdMinutes * 60e3).toISOString();
    tx(this.db, () => {
      if (!draft) this.assertStock(pkg, items, { renewal_of: extra.renewalOf ?? null });
      const year = t.slice(0, 4);
      const number = `SP-${year}-${String(nextNumber(this.db, `order:${year}`)).padStart(6, '0')}`;
      this.db.prepare(`INSERT INTO sp_orders (id, number, org_id, sponsor_id, opportunity_id, package_id, status, currency, subtotal_minor, platform_fee_minor, tax_minor, total_minor, tax_rate_bps,
        commission_bps, starts_on, ends_on, auto_renew, renewal_of, source, billing, asset_ids, risk, hold_expires_at, idempotency_key, click_url, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        oid, number, opp.org_id, sponsorId, opp.id, pkg.id, draft ? 'DRAFT' : 'PENDING_PAYMENT', opp.currency, breakdown.subtotal, breakdown.platformFee, breakdown.tax, breakdown.total,
        breakdown.taxRateBps, breakdown.commissionBps, startsOn, endsOn, b.autoRenew ? 1 : 0, extra.renewalOf ?? null, source, J(billing), J(assets), '[]', draft ? null : holdUntil, key,
        b.clickUrl ?? null, user.id, t, t,
      );
      const insItem = this.db.prepare('INSERT INTO sp_order_items (order_id, inventory_id, type, name, scope_type, scope_id, quantity, unit_price_minor) VALUES (?,?,?,?,?,?,?,?)');
      for (const it of items) insItem.run(oid, it.inventory_id, it.type, it.name, it.scope_type, it.scope_id, it.quantity, it.unit_price_minor);
      const insAsset = this.db.prepare('INSERT INTO sp_order_assets (order_id, asset_id, role, status) VALUES (?,?,?,?)');
      for (const [role, aid] of Object.entries(assets)) insAsset.run(oid, aid, role, 'pending');
      this.db.prepare('INSERT INTO sp_order_events (order_id, from_status, to_status, actor_id, actor_kind, note, at) VALUES (?,?,?,?,?,?,?)').run(oid, null, draft ? 'DRAFT' : 'PENDING_PAYMENT', user.id, source === 'checkout' ? 'sponsor' : 'system', source, t);
      const o = this.row(oid);
      this.d.docs.store(oid, 'agreement', agreementModel(this.docContext(o)));
      if (source === 'renewal') this.d.docs.store(oid, 'renewal', noticeModel('Renewal', o.number, [`Renewal of ${this.row(extra.renewalOf!).number} for ${o.starts_on} to ${o.ends_on}.`, `Amount: ${money(o.total_minor, o.currency)}.`]));
    });
    this.d.ctx.audit(opp.org_id, user.id, 'sponsorship.order_created', 'sp_order', oid, { sponsorId, packageId: pkg.id, total: breakdown.total, source });
    return this.view(this.row(oid), 'sponsor');
  }

  // ------------------------------------------------------------------ paying
  async pay(user: AuthUser, sponsorId: string, orderId: string, b: any, ip: string) {
    let o = this.forSponsor(sponsorId, orderId);
    if (!['DRAFT', 'PENDING_PAYMENT'].includes(o.status)) throw new HttpError(409, o.status === 'CANCELLED' ? 'This order expired. Start a new one from the marketplace.' : 'This sponsorship is already paid', 'INVALID_STATE');
    if (b?.acceptAgreement !== true) throw new HttpError(400, 'Accept the sponsorship agreement to continue', 'AGREEMENT_REQUIRED');
    const attempts = (this.db.prepare('SELECT COUNT(*) AS n FROM sp_payments WHERE order_id = ?').get(o.id) as any).n;
    if (attempts >= 10) throw new HttpError(429, 'Too many payment attempts on this order. Contact support.', 'RATE_LIMIT');

    // (re)hold stock: drafts and lapsed holds are re-checked
    tx(this.db, () => {
      o = this.row(o.id);
      if (o.status === 'DRAFT' || !o.hold_expires_at || o.hold_expires_at <= now()) {
        const pkg = this.db.prepare('SELECT * FROM sp_packages WHERE id = ?').get(o.package_id) as any;
        if (!pkg?.active) throw new HttpError(409, 'This package is no longer offered', 'SOLD_OUT');
        const items = this.db.prepare('SELECT inventory_id, quantity FROM sp_order_items WHERE order_id = ?').all(o.id) as any[];
        this.assertStock(pkg, items, o);
        const hold = new Date(Date.now() + getPlatformSettings(this.db).holdMinutes * 60e3).toISOString();
        this.db.prepare('UPDATE sp_orders SET hold_expires_at = ? WHERE id = ?').run(hold, o.id);
        o.hold_expires_at = hold;
        if (o.status === 'DRAFT') this.transition(o, 'PENDING_PAYMENT', { id: user.id, kind: 'sponsor' }, 'checkout started');
      }
    });
    const acc = this.d.docs.accept(o.id, user.id, ip, b.agreementSha256);
    if (!acc.ok) throw new HttpError(409, acc.reason, 'AGREEMENT_CHANGED');
    this.db.prepare('UPDATE sp_orders SET agreement_accepted_at = COALESCE(agreement_accepted_at, ?) WHERE id = ?').run(now(), o.id);

    const { provider, scope } = this.d.registry.forOrg(o.org_id, o.currency);
    // A double-click must not open two gateway orders: reuse a fresh open checkout.
    const open = this.db.prepare("SELECT * FROM sp_payments WHERE order_id = ? AND provider = ? AND status = 'created' AND amount_minor = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
      .get(o.id, provider.id, o.total_minor, new Date(Date.now() - 15 * 60e3).toISOString()) as any;
    if (open) return { paymentId: open.id, provider: provider.id, live: provider.live, client: P<any>(open.raw, {}).client, order: this.view(o, 'sponsor') };

    const acct = this.db.prepare('SELECT name, email, phone FROM sponsor_accounts WHERE id = ?').get(sponsorId) as any;
    const opp = this.db.prepare('SELECT title FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
    const base = this.d.baseUrl();
    let session;
    try {
      session = await provider.createCheckout({
        orderId: o.id, number: o.number, amountMinor: o.total_minor, currency: o.currency, description: `${o.number} · ${opp.title}`,
        customer: { id: sponsorId, name: acct.name, email: P<any>(o.billing, {}).email ?? acct.email ?? user.email, phone: acct.phone },
        returnUrl: `${base}/sponsor#order=${o.id}`, cancelUrl: `${base}/sponsor#order=${o.id}&cancelled=1`,
        notifyUrl: `${base}/api/payments/webhook/${provider.id}${scope === 'org' ? `/${o.org_id}` : ''}`,
      });
    } catch (e: any) {
      this.d.ctx.audit(o.org_id, user.id, 'payment.checkout_failed', 'sp_order', o.id, { provider: provider.id, error: String(e?.message ?? e).slice(0, 300) });
      throw new HttpError(502, 'The payment provider could not start checkout. Please try again in a moment.', 'PROVIDER_ERROR');
    }
    const pid = id();
    this.db.prepare('INSERT INTO sp_payments (id, order_id, provider, provider_order_id, amount_minor, currency, status, raw, scope_org, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      pid, o.id, provider.id, session.providerOrderId, o.total_minor, o.currency, 'created', J({ client: session.client }), scope === 'org' ? o.org_id : null, now(), now(),
    );
    return { paymentId: pid, provider: provider.id, live: provider.live, client: session.client, order: this.view(this.row(o.id), 'sponsor') };
  }

  /** "I've paid" — the server asks the provider directly; nothing is taken from the browser. */
  async confirm(sponsorId: string, orderId: string) {
    const o = this.forSponsor(sponsorId, orderId);
    const pays = this.db.prepare("SELECT * FROM sp_payments WHERE order_id = ? AND status = 'created' ORDER BY created_at DESC LIMIT 3").all(o.id) as any[];
    for (const p of pays) {
      const provider = this.providerFor(p);
      let st;
      try {
        st = await provider.fetchStatus(p.provider_order_id);
      } catch {
        continue;
      }
      if (st.status === 'paid') {
        await this.capture(p.provider, { providerOrderId: p.provider_order_id, providerPaymentId: st.providerPaymentId, amountMinor: st.amountMinor ?? p.amount_minor, currency: st.currency ?? p.currency, method: st.method }, 'api');
      } else if (st.status === 'failed') this.db.prepare("UPDATE sp_payments SET status = 'failed', updated_at = ? WHERE id = ?").run(now(), p.id);
    }
    return this.view(this.row(o.id), 'sponsor');
  }

  private providerFor(p: { provider: string; scope_org: string | null }): PaymentProvider {
    return this.d.registry.forWebhook(p.provider, p.scope_org ?? undefined);
  }

  // ------------------------------------------------------------------ webhooks
  /**
   * Entry point for every provider webhook. Signature is verified over the exact raw bytes;
   * processing is idempotent per (provider, event id). Throwing makes the provider retry.
   */
  async webhook(providerName: string, orgId: string | null, rawBody: Buffer, headers: Record<string, any>) {
    let provider: PaymentProvider;
    try {
      provider = this.d.registry.forWebhook(providerName, orgId ?? undefined);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(404, 'Webhook endpoint not configured', 'NOT_FOUND');
    }
    let ev: WebhookEvent;
    try {
      ev = provider.verifyWebhook(rawBody, headers);
    } catch (e: any) {
      this.d.ctx.audit(orgId, null, 'payment.webhook_rejected', 'provider', providerName, { reason: e instanceof SignatureError ? e.message : 'unparseable', bytes: rawBody.length });
      throw new HttpError(400, e instanceof SignatureError ? 'Invalid signature' : 'Invalid payload', 'BAD_SIGNATURE');
    }
    const inserted = Number(this.db.prepare('INSERT OR IGNORE INTO sp_webhook_events (provider, event_id, type, received_at) VALUES (?,?,?,?)').run(providerName, ev.id, ev.type, now()).changes) > 0;
    if (!inserted) {
      const prev = this.db.prepare('SELECT processed_at, result FROM sp_webhook_events WHERE provider = ? AND event_id = ?').get(providerName, ev.id) as any;
      if (prev?.processed_at) return { ok: true, duplicate: true, result: prev.result };
    }
    try {
      const result = await this.dispatch(providerName, ev);
      this.db.prepare('UPDATE sp_webhook_events SET processed_at = ?, result = ? WHERE provider = ? AND event_id = ?').run(now(), result, providerName, ev.id);
      return { ok: true, result };
    } catch (e) {
      // un-claim so the provider's retry is processed
      this.db.prepare('DELETE FROM sp_webhook_events WHERE provider = ? AND event_id = ? AND processed_at IS NULL').run(providerName, ev.id);
      throw e;
    }
  }

  private async dispatch(providerName: string, ev: WebhookEvent): Promise<string> {
    switch (ev.type) {
      case 'payment.captured':
        return this.capture(providerName, ev, 'webhook');
      case 'payment.failed': {
        const p = this.db.prepare('SELECT * FROM sp_payments WHERE provider = ? AND provider_order_id = ?').get(providerName, ev.providerOrderId ?? '') as any;
        if (!p) return 'unknown_order';
        if (p.status === 'created') this.db.prepare("UPDATE sp_payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?").run(String(ev.reason ?? '').slice(0, 200), now(), p.id);
        const o = this.row(p.order_id);
        void this.d.notify.event({ event: 'payment.failed', sponsorId: o.sponsor_id, title: 'Payment not completed', body: `Your payment for ${o.number} did not go through${ev.reason ? ` (${ev.reason})` : ''}. Your hold stays until ${o.hold_expires_at?.slice(11, 16) ?? '—'} UTC — try again from your dashboard.`, link: `/sponsor#order=${o.id}` });
        return 'payment_failed';
      }
      case 'refund.processed':
        return this.refundSettled(providerName, ev, 'processed');
      case 'refund.failed':
        return this.refundSettled(providerName, ev, 'failed');
      default:
        return 'ignored';
    }
  }

  /** The one place an order becomes paid. */
  async capture(providerName: string, ev: { providerOrderId?: string; providerPaymentId?: string; amountMinor?: number; currency?: string; method?: string }, via: 'webhook' | 'api'): Promise<string> {
    const p = this.db.prepare('SELECT * FROM sp_payments WHERE provider = ? AND provider_order_id = ?').get(providerName, ev.providerOrderId ?? '') as any;
    if (!p) {
      this.d.ctx.audit(null, null, 'payment.unknown_order', 'provider', providerName, { providerOrderId: ev.providerOrderId, providerPaymentId: ev.providerPaymentId });
      return 'unknown_order';
    }
    const actor: Actor = { id: null, kind: 'provider' };
    let refundAfter: { amount: number; reason: string } | null = null;
    let result = 'captured';
    let proceed = false;
    tx(this.db, () => {
      const pay = this.db.prepare('SELECT * FROM sp_payments WHERE id = ?').get(p.id) as any;
      const o = this.row(pay.order_id);
      if (pay.status === 'captured' || pay.status === 'refunded') {
        if (ev.providerPaymentId && pay.provider_payment_id && ev.providerPaymentId !== pay.provider_payment_id) {
          // a second, different payment against the same gateway order
          const dup = id();
          this.db.prepare('INSERT INTO sp_payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_minor, currency, status, method, captured_at, scope_org, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            dup, o.id, providerName, `${pay.provider_order_id}#${ev.providerPaymentId}`, ev.providerPaymentId, ev.amountMinor ?? 0, ev.currency ?? pay.currency, 'captured', ev.method ?? null, now(), pay.scope_org, now(), now());
          this.addRisk(o, 'duplicate_payment');
          refundAfter = { amount: ev.amountMinor ?? 0, reason: 'Duplicate payment (automatic refund)' };
          (p as any).id = dup;
          result = 'duplicate_payment_refunded';
        } else result = 'already_captured';
        return;
      }
      this.db.prepare("UPDATE sp_payments SET status = 'captured', provider_payment_id = COALESCE(?, provider_payment_id), method = ?, captured_at = ?, updated_at = ? WHERE id = ?").run(ev.providerPaymentId ?? null, ev.method ?? null, now(), now(), pay.id);
      this.d.ctx.audit(o.org_id, null, 'payment.captured', 'sp_payment', pay.id, { via, provider: providerName, amount: ev.amountMinor, currency: ev.currency });

      if (ev.amountMinor !== pay.amount_minor || String(ev.currency ?? '').toUpperCase() !== pay.currency) {
        this.addRisk(o, 'amount_mismatch');
        this.ledger(o, 'charge_unreconciled', ev.amountMinor ?? 0, `expected ${pay.amount_minor} ${pay.currency}, got ${ev.amountMinor} ${ev.currency}`);
        this.note(o, actor, `Payment amount mismatch: expected ${money(pay.amount_minor, pay.currency)}, received ${ev.amountMinor} ${ev.currency}. Held for review.`);
        result = 'amount_mismatch';
        return;
      }
      const otherCaptured = this.db.prepare("SELECT 1 FROM sp_payments WHERE order_id = ? AND status = 'captured' AND id != ?").get(o.id, pay.id);
      if (otherCaptured) {
        this.addRisk(o, 'duplicate_payment');
        refundAfter = { amount: pay.amount_minor, reason: 'Duplicate payment (automatic refund)' };
        result = 'duplicate_payment_refunded';
        return;
      }
      if (o.status === 'CANCELLED') {
        // paid after the hold lapsed: honour it if the slot is still free
        const pkg = this.db.prepare('SELECT * FROM sp_packages WHERE id = ?').get(o.package_id) as any;
        try {
          this.assertStock(pkg, this.db.prepare('SELECT inventory_id, quantity FROM sp_order_items WHERE order_id = ?').all(o.id) as any[], o);
        } catch {
          refundAfter = { amount: pay.amount_minor, reason: 'Sold out before the payment completed (automatic refund)' };
          result = 'late_payment_refunded';
          return;
        }
      } else if (o.status !== 'PENDING_PAYMENT' && o.status !== 'DRAFT') {
        this.addRisk(o, 'unexpected_payment');
        refundAfter = { amount: pay.amount_minor, reason: 'Payment received for an order that was not awaiting payment (automatic refund)' };
        result = 'unexpected_payment_refunded';
        return;
      }
      if (o.status === 'DRAFT') this.transition(o, 'PENDING_PAYMENT', actor);
      this.transition(o, 'PAYMENT_RECEIVED', actor, `${providerName}${ev.method ? ` · ${ev.method}` : ''} · ${ev.providerPaymentId ?? ''} (${via})`);
      this.db.prepare('UPDATE sp_orders SET hold_expires_at = NULL WHERE id = ?').run(o.id);
      this.bookRevenue(o, pay.scope_org);
      this.db.prepare('UPDATE sp_payments SET booked = 1 WHERE id = ?').run(pay.id);
      this.issueInvoice(o, { provider: providerName, providerPaymentId: ev.providerPaymentId ?? null, method: ev.method ?? null, capturedAt: now() });
      proceed = true;
    });
    const o = this.row(p.order_id);
    if (refundAfter) {
      const r = refundAfter as { amount: number; reason: string };
      await this.refundPayment(o, p.id, r.amount, r.reason, { id: null, kind: 'system' }).catch((e) => this.d.ctx.audit(o.org_id, null, 'refund.auto_failed', 'sp_order', o.id, { error: String(e?.message ?? e) }));
      void this.d.notify.event({ event: 'payment.auto_refund', sponsorId: o.sponsor_id, orgId: o.org_id, title: 'Payment refunded automatically', body: `${money(r.amount, o.currency)} for ${o.number} is being refunded: ${r.reason}.`, link: `/sponsor#order=${o.id}` });
    }
    if (result === 'amount_mismatch') void this.d.notify.event({ event: 'payment.mismatch', orgId: o.org_id, title: `Payment needs review: ${o.number}`, body: 'The amount received did not match the order. The sponsorship is on hold until the platform team reviews it.' });
    if (proceed) {
      void this.d.notify.event({ event: 'payment.received', sponsorId: o.sponsor_id, orgId: o.org_id, title: `Payment received · ${o.number}`, body: `${money(o.total_minor, o.currency)} received. Invoice and receipt are in your dashboard.`, link: `/sponsor#order=${o.id}`, channels: ['email', 'whatsapp'] });
      this.afterPayment(o);
    }
    return result;
  }

  private ledger(o: any, kind: string, amount: number, note?: string) {
    if (!amount && kind !== 'charge') return;
    this.db.prepare('INSERT INTO sp_ledger (order_id, org_id, kind, amount_minor, currency, note, at) VALUES (?,?,?,?,?,?,?)').run(o.id, o.org_id, kind, amount, o.currency, note ?? null, now());
  }

  /** Split the money: organizer payable, platform commission/fee, tax on each side. */
  private bookRevenue(o: any, scopeOrg: string | null) {
    const taxOnSub = bps(o.subtotal_minor, o.tax_rate_bps);
    const taxOnFee = o.tax_minor - taxOnSub;
    const commission = bps(o.subtotal_minor, o.commission_bps);
    this.ledger(o, 'charge', o.total_minor);
    this.ledger(o, 'commission', commission);
    this.ledger(o, 'platform_fee', o.platform_fee_minor);
    this.ledger(o, 'tax_platform', taxOnFee);
    const organizerShare = o.subtotal_minor - commission + taxOnSub;
    if (scopeOrg) {
      // collected on the organizer's own gateway: they hold the money, the platform invoices them
      this.ledger(o, 'organizer_collected', o.total_minor);
      this.ledger(o, 'commission_receivable', o.total_minor - organizerShare);
    } else this.ledger(o, 'organizer_payable', organizerShare);
  }

  private issueInvoice(o: any, pay: { provider: string; providerPaymentId: string | null; method: string | null; capturedAt: string }) {
    const s = getOrgSettings(this.db, o.org_id);
    const fy = financialYear();
    const number = `${s.invoicePrefix}/${fy}/${String(nextNumber(this.db, `inv:${o.org_id}:${fy}`)).padStart(4, '0')}`;
    const ctx = this.docContext(o);
    const model = invoiceModel(ctx, number, pay);
    this.db.prepare('INSERT INTO sp_invoices (id, number, order_id, org_id, sponsor_id, kind, currency, total_minor, data, issued_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id(), number, o.id, o.org_id, o.sponsor_id, 'invoice', o.currency, o.total_minor, J(model), now());
    this.d.docs.store(o.id, 'invoice', model);
    this.d.docs.store(o.id, 'receipt', receiptModel(ctx, `RCPT-${o.number}`, pay));
  }

  /** Route a paid order by the opportunity's approval mode (risk flags always go to a human). */
  private afterPayment(o: any) {
    const opp = this.db.prepare('SELECT approval_mode, title FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
    const actor: Actor = { id: null, kind: 'system' };
    const risky = P<string[]>(o.risk, []).length > 0;
    const flagged = this.db.prepare("SELECT 1 FROM sp_order_assets oa JOIN sponsor_assets s ON s.id = oa.asset_id WHERE oa.order_id = ? AND s.status != 'ready'").get(o.id);
    const needsLogo = (this.db.prepare('SELECT type FROM sp_order_items WHERE order_id = ?').all(o.id) as any[]).some((i) => inventoryType(i.type)?.assets.includes('logo'));
    const missingLogo = needsLogo && !this.db.prepare("SELECT 1 FROM sp_order_assets WHERE order_id = ? AND role = 'logo'").get(o.id);
    if (risky || opp.approval_mode === 'manual') {
      this.transition(o, 'PENDING_APPROVAL', actor, risky ? 'risk review' : 'organizer approval required');
      void this.d.notify.event({ event: 'sponsorship.approval_needed', orgId: o.org_id, title: `Approve sponsorship ${o.number}`, body: `A paid sponsorship for "${opp.title}" is waiting for your approval.`, link: `/console#sponsorships/${o.id}` });
    } else if (opp.approval_mode === 'asset_review' || flagged || missingLogo) {
      this.transition(o, 'ASSET_REVIEW', actor, missingLogo ? 'waiting for the sponsor logo' : flagged ? 'creative needs review' : 'asset review required');
      void this.d.notify.event({ event: 'sponsorship.asset_review', orgId: o.org_id, title: `Review sponsor creative · ${o.number}`, body: `Check the logo/creative for "${opp.title}" before it goes live.`, link: `/console#sponsorships/${o.id}` });
    } else {
      this.db.prepare("UPDATE sp_order_assets SET status = 'approved', reviewed_at = ? WHERE order_id = ?").run(now(), o.id);
      this.activate(o, actor);
    }
  }

  activate(o: any, actor: Actor) {
    tx(this.db, () => {
      o = this.row(o.id);
      this.transition(o, 'ACTIVE', actor);
      const { placements, deliverables } = this.d.branding.activate(o.id);
      const ctx = this.docContext(o);
      this.d.docs.store(o.id, 'confirmation', confirmationModel(ctx, placements.map((p: any) => ({ surface: p.surface.replace(/_/g, ' '), scope: p.scope_type })), deliverables));
    });
    this.d.onBrandingChange(o.org_id);
    const opp = this.db.prepare('SELECT title FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
    void this.d.notify.event({ event: 'sponsorship.active', sponsorId: o.sponsor_id, orgId: o.org_id, title: `You're live · ${opp.title}`, body: `Sponsorship ${o.number} is active from ${o.starts_on} to ${o.ends_on}. Your branding now appears automatically on screens and live pages.`, link: `/sponsor#order=${o.id}`, channels: ['email', 'whatsapp'] });
  }

  // ------------------------------------------------------------------ organizer actions
  approve(user: AuthUser, orderId: string, b: any) {
    const o = this.forOrg(user.orgId, orderId);
    const actor: Actor = { id: user.id, kind: 'organizer' };
    if (b?.decision === 'reject') return this.reject(user, orderId, String(b.reason ?? b.note ?? 'Declined by organizer'));
    if (b?.assets) this.reviewAssets(user, o.id, b.assets);
    const fresh = this.row(o.id);
    if (P<string[]>(fresh.risk, []).includes('amount_mismatch')) throw new HttpError(409, 'This payment did not match the order amount; the platform team must resolve it first.', 'RISK_HOLD');
    const opp = this.db.prepare('SELECT approval_mode FROM sp_opportunities WHERE id = ?').get(fresh.opportunity_id) as any;
    if (fresh.status === 'PENDING_APPROVAL') {
      this.note(fresh, actor, b?.note ? `Approved: ${b.note}` : 'Approved');
      const pending = this.db.prepare("SELECT 1 FROM sp_order_assets WHERE order_id = ? AND status != 'approved'").get(fresh.id);
      if (opp.approval_mode === 'asset_review' && pending) return (this.transition(fresh, 'ASSET_REVIEW', actor), this.view(this.row(fresh.id), 'org'));
      this.db.prepare("UPDATE sp_order_assets SET status = 'approved', reviewed_by = COALESCE(reviewed_by, ?), reviewed_at = COALESCE(reviewed_at, ?) WHERE order_id = ? AND status = 'pending'").run(user.id, now(), fresh.id);
      if (this.db.prepare("SELECT 1 FROM sp_order_assets WHERE order_id = ? AND status = 'rejected'").get(fresh.id)) return (this.transition(fresh, 'ASSET_REVIEW', actor), this.view(this.row(fresh.id), 'org'));
      this.activate(fresh, actor);
    } else if (fresh.status === 'ASSET_REVIEW') {
      if (!b?.assets) this.db.prepare("UPDATE sp_order_assets SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE order_id = ? AND status = 'pending'").run(user.id, now(), fresh.id);
      // rejected creative waits for the sponsor's replacement; everything approved goes live
      if (!this.db.prepare("SELECT 1 FROM sp_order_assets WHERE order_id = ? AND status != 'approved'").get(fresh.id)) this.activate(fresh, actor);
    } else if (!['ACTIVE', 'PAUSED'].includes(fresh.status) || !b?.assets) throw new HttpError(409, `Nothing to approve on a ${fresh.status.toLowerCase().replace(/_/g, ' ')} sponsorship`, 'INVALID_STATE');
    return this.view(this.row(o.id), 'org');
  }

  /** Per-creative decisions: {role: 'approve' | 'reject' | {decision, note}}. Handles replacements on live orders too. */
  reviewAssets(user: AuthUser, orderId: string, decisions: Record<string, any>) {
    const o = this.forOrg(user.orgId, orderId);
    let changedLive = false;
    const rejected: string[] = [];
    tx(this.db, () => {
      for (const [role, d] of Object.entries(decisions ?? {})) {
        const decision = typeof d === 'string' ? d : d?.decision;
        const note = typeof d === 'object' ? d?.note ?? null : null;
        const row = this.db.prepare('SELECT * FROM sp_order_assets WHERE order_id = ? AND role = ?').get(o.id, role) as any;
        if (!row) throw new HttpError(404, `No ${role} on this sponsorship`, 'NOT_FOUND');
        if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision must be approve or reject', 'VALIDATION');
        if (row.proposed_asset_id) {
          if (decision === 'approve') (this.db.prepare("UPDATE sp_order_assets SET asset_id = proposed_asset_id, proposed_asset_id = NULL, status = 'approved', note = ?, reviewed_by = ?, reviewed_at = ? WHERE order_id = ? AND role = ?").run(note, user.id, now(), o.id, role), (changedLive = true));
          else this.db.prepare('UPDATE sp_order_assets SET proposed_asset_id = NULL, note = ?, reviewed_by = ?, reviewed_at = ? WHERE order_id = ? AND role = ?').run(note ?? 'Replacement rejected', user.id, now(), o.id, role);
        } else this.db.prepare('UPDATE sp_order_assets SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ? WHERE order_id = ? AND role = ?').run(decision === 'approve' ? 'approved' : 'rejected', note, user.id, now(), o.id, role);
        if (decision === 'reject') rejected.push(`${role.replace('_', ' ')}${note ? ` (${note})` : ''}`);
        this.db.prepare('INSERT INTO moderation_log (subject_type, subject_id, action, reason, note, actor_id, org_id, at) VALUES (?,?,?,?,?,?,?,?)').run('order_asset', `${o.id}:${role}`, decision, null, note, user.id, o.org_id, now());
      }
      if (!rejected.length && Object.values(decisions).length) {
        const ctx = this.docContext(o);
        this.d.docs.store(o.id, 'asset_approval', noticeModel('Asset Approval', o.number, [`Creative approved for ${ctx.packageName} — ${ctx.opportunity.title}: ${Object.keys(decisions).join(', ').replace(/_/g, ' ')}.`]));
      }
    });
    if (changedLive) (this.d.branding.invalidate(o.org_id), this.d.onBrandingChange(o.org_id));
    if (rejected.length) void this.d.notify.event({ event: 'sponsorship.asset_rejected', sponsorId: o.sponsor_id, title: `Please replace your creative · ${o.number}`, body: `The organizer asked for changes to: ${rejected.join('; ')}. Upload a new version from your dashboard.`, link: `/sponsor#order=${o.id}` });
    else void this.d.notify.event({ event: 'sponsorship.asset_approved', sponsorId: o.sponsor_id, title: `Creative approved · ${o.number}`, body: 'Your creative was approved.', link: `/sponsor#order=${o.id}` });
  }

  async reject(user: AuthUser, orderId: string, reason: string) {
    const o = this.forOrg(user.orgId, orderId);
    if (!['PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW'].includes(o.status)) throw new HttpError(409, 'Only sponsorships awaiting approval can be declined', 'INVALID_STATE');
    this.transition(o, 'CANCELLED', { id: user.id, kind: 'organizer' }, `Declined: ${reason}`);
    await this.refundAll(o, `Declined by organizer: ${reason}`, { id: user.id, kind: 'organizer' });
    void this.d.notify.event({ event: 'sponsorship.declined', sponsorId: o.sponsor_id, title: `Sponsorship declined · ${o.number}`, body: `The organizer declined this sponsorship (${reason}). A full refund of ${money(o.total_minor, o.currency)} has been started.`, link: `/sponsor#order=${o.id}` });
    return this.view(this.row(o.id), 'org');
  }

  setPaused(actor: Actor, o: any, paused: boolean, note?: string) {
    this.transition(o, paused ? 'PAUSED' : 'ACTIVE', actor, note);
    this.d.branding.setActive(o.id, !paused);
    this.d.onBrandingChange(o.org_id);
    void this.d.notify.event({ event: paused ? 'sponsorship.paused' : 'sponsorship.resumed', sponsorId: o.sponsor_id, title: `Sponsorship ${paused ? 'paused' : 'resumed'} · ${o.number}`, body: paused ? `Your branding is temporarily off screens${note ? `: ${note}` : '.'}` : 'Your branding is showing again.', link: `/sponsor#order=${o.id}` });
    return this.view(this.row(o.id), actor.kind === 'sponsor' ? 'sponsor' : 'org');
  }

  markDeliverable(user: AuthUser, deliverableId: string, b: any) {
    const d = this.db.prepare('SELECT d.*, o.org_id, o.sponsor_id, o.number, o.status AS order_status FROM sp_deliverables d JOIN sp_orders o ON o.id = d.order_id WHERE d.id = ?').get(deliverableId) as any;
    if (!d || d.org_id !== user.orgId) throw new HttpError(404, 'Deliverable not found', 'NOT_FOUND');
    const status = b.status ?? 'delivered';
    if (!['pending', 'scheduled', 'delivered', 'missed'].includes(status)) throw new HttpError(400, 'status must be pending, scheduled, delivered or missed', 'VALIDATION');
    if (status === 'delivered' && !b.proofUrl && !d.proof_url) throw new HttpError(400, 'Add a proof link (post URL or photo) when marking delivered', 'VALIDATION');
    if (b.proofUrl && !URL_RE.test(b.proofUrl)) throw new HttpError(400, 'Proof must be a full http(s) link', 'VALIDATION');
    this.db.prepare('UPDATE sp_deliverables SET status = ?, proof_url = COALESCE(?, proof_url), note = COALESCE(?, note), delivered_at = ?, delivered_by = ? WHERE id = ?').run(status, b.proofUrl ?? null, b.note ?? null, status === 'delivered' ? now() : null, user.id, d.id);
    this.d.ctx.audit(user.orgId, user.id, 'sponsorship.deliverable', 'sp_deliverable', d.id, { status });
    if (status === 'delivered') void this.d.notify.event({ event: 'sponsorship.delivered', sponsorId: d.sponsor_id, title: `Delivered: ${d.label}`, body: `${d.label} for ${d.number} was delivered.${b.proofUrl ? ` Proof: ${b.proofUrl}` : ''}`, link: `/sponsor#order=${d.order_id}` });
    return this.db.prepare('SELECT * FROM sp_deliverables WHERE id = ?').get(d.id);
  }

  transfer(actor: Actor, o: any, toSponsorId: string, note?: string) {
    const target = this.db.prepare('SELECT * FROM sponsor_accounts WHERE id = ? OR slug = ?').get(toSponsorId, toSponsorId) as any;
    if (!target || target.status !== 'active') throw new HttpError(400, 'Target sponsor account not found or not active', 'VALIDATION');
    if (target.id === o.sponsor_id) throw new HttpError(400, 'That is already the sponsor', 'VALIDATION');
    if (!['PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW', 'ACTIVE', 'PAUSED'].includes(o.status)) throw new HttpError(409, 'Only paid sponsorships can be transferred', 'INVALID_STATE');
    const from = o.sponsor_id;
    this.db.prepare('UPDATE sp_orders SET sponsor_id = ?, updated_at = ? WHERE id = ?').run(target.id, now(), o.id);
    this.db.prepare('UPDATE sp_placements SET sponsor_id = ? WHERE order_id = ?').run(target.id, o.id);
    this.db.prepare('UPDATE sp_qr_codes SET sponsor_id = ? WHERE order_id = ?').run(target.id, o.id);
    this.note(o, actor, `Transferred to ${target.name}${note ? `: ${note}` : ''}`);
    this.d.ctx.audit(o.org_id, actor.id, 'sponsorship.transfer', 'sp_order', o.id, { from, to: target.id });
    this.d.branding.invalidate(o.org_id);
    this.d.onBrandingChange(o.org_id);
    for (const sid of [from, target.id]) void this.d.notify.event({ event: 'sponsorship.transferred', sponsorId: sid, title: `Sponsorship transferred · ${o.number}`, body: `Sponsorship ${o.number} now belongs to ${target.name}.` });
    return this.view(this.row(o.id), 'org');
  }

  // ------------------------------------------------------------------ sponsor actions
  replaceAssets(sponsorId: string, orderId: string, b: any) {
    const o = this.forSponsor(sponsorId, orderId);
    if (['CANCELLED', 'REFUNDED', 'EXPIRED'].includes(o.status)) throw new HttpError(409, 'This sponsorship has ended', 'INVALID_STATE');
    const live = ['ACTIVE', 'PAUSED'].includes(o.status);
    const opp = this.db.prepare('SELECT approval_mode FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
    const assets = this.resolveAssets(sponsorId, b.assetIds ?? b.assets ?? {}, new Set());
    let changed = false;
    tx(this.db, () => {
      for (const [role, aid] of Object.entries(assets)) {
        const cur = this.db.prepare('SELECT * FROM sp_order_assets WHERE order_id = ? AND role = ?').get(o.id, role) as any;
        const ready = (this.db.prepare('SELECT status FROM sponsor_assets WHERE id = ?').get(aid) as any).status === 'ready';
        if (live && cur) {
          if (opp.approval_mode === 'auto' && ready) (this.db.prepare("UPDATE sp_order_assets SET asset_id = ?, proposed_asset_id = NULL, status = 'approved', reviewed_at = ? WHERE order_id = ? AND role = ?").run(aid, now(), o.id, role), (changed = true));
          else this.db.prepare('UPDATE sp_order_assets SET proposed_asset_id = ? WHERE order_id = ? AND role = ?').run(aid, o.id, role);
        } else if (cur) this.db.prepare("UPDATE sp_order_assets SET asset_id = ?, proposed_asset_id = NULL, status = 'pending', note = NULL WHERE order_id = ? AND role = ?").run(aid, o.id, role);
        else this.db.prepare('INSERT INTO sp_order_assets (order_id, asset_id, role, status) VALUES (?,?,?,?)').run(o.id, aid, role, live && opp.approval_mode === 'auto' && ready ? 'approved' : 'pending');
      }
      if (b.clickUrl !== undefined) {
        if (b.clickUrl && !URL_RE.test(b.clickUrl)) throw new HttpError(400, 'The click-through link must start with http:// or https://', 'VALIDATION');
        this.db.prepare('UPDATE sp_orders SET click_url = ?, updated_at = ? WHERE id = ?').run(b.clickUrl || null, now(), o.id);
        if (b.clickUrl) this.d.branding.updateTarget(o.id, b.clickUrl);
        changed = true;
      }
    });
    if (changed && live) (this.d.branding.invalidate(o.org_id), this.d.onBrandingChange(o.org_id));
    if (o.status === 'ASSET_REVIEW' || (live && !changed)) void this.d.notify.event({ event: 'sponsorship.asset_submitted', orgId: o.org_id, title: `New creative to review · ${o.number}`, body: 'The sponsor uploaded replacement creative.', link: `/console#sponsorships/${o.id}` });
    return this.view(this.row(o.id), 'sponsor');
  }

  async cancelBySponsor(user: AuthUser, sponsorId: string, orderId: string, reason?: string) {
    const o = this.forSponsor(sponsorId, orderId);
    const actor: Actor = { id: user.id, kind: 'sponsor' };
    if (['DRAFT', 'PENDING_PAYMENT'].includes(o.status)) {
      this.transition(o, 'CANCELLED', actor, reason ?? 'Cancelled by sponsor');
      return this.view(this.row(o.id), 'sponsor');
    }
    if (['PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW'].includes(o.status)) {
      this.transition(o, 'CANCELLED', actor, reason ?? 'Cancelled by sponsor before activation');
      await this.refundAll(o, 'Cancelled by sponsor before activation', actor);
      void this.d.notify.event({ event: 'sponsorship.cancelled', orgId: o.org_id, title: `Sponsorship cancelled · ${o.number}`, body: 'The sponsor cancelled before activation; a full refund was started.' });
      return this.view(this.row(o.id), 'sponsor');
    }
    throw new HttpError(409, 'Live sponsorships can be cancelled by the organizer. Message them from the sponsorship page.', 'INVALID_STATE');
  }

  async cancelByOrganizer(actor: Actor, o: any, b: { reason?: string; refundAmount?: number | string | null }) {
    if (['CANCELLED', 'REFUNDED', 'EXPIRED'].includes(o.status)) throw new HttpError(409, 'This sponsorship has already ended', 'INVALID_STATE');
    const wasLive = ['ACTIVE', 'PAUSED'].includes(o.status);
    const paid = !['DRAFT', 'PENDING_PAYMENT'].includes(o.status);
    this.transition(o, 'CANCELLED', actor, b.reason ?? 'Cancelled by organizer');
    if (wasLive) (this.d.branding.setActive(o.id, false), this.d.onBrandingChange(o.org_id));
    if (paid) {
      // default: full refund before activation; pro-rated for the unused days of a live sponsorship
      let amount: number;
      if (b.refundAmount != null && b.refundAmount !== '') amount = Math.round(Number(b.refundAmount) * 100);
      else if (wasLive) {
        const total = Math.max(1, daysBetween(o.starts_on, o.ends_on) + 1);
        const unused = Math.max(0, Math.min(total, daysBetween(today(), o.ends_on)));
        amount = Math.round((o.total_minor * unused) / total);
      } else amount = this.refundable(o.id);
      if (amount > 0) await this.refund(actor, o, { amountMinor: amount, reason: b.reason ?? 'Cancelled by organizer' });
    }
    void this.d.notify.event({ event: 'sponsorship.cancelled', sponsorId: o.sponsor_id, title: `Sponsorship cancelled · ${o.number}`, body: `The organizer cancelled this sponsorship${b.reason ? `: ${b.reason}` : ''}.`, link: `/sponsor#order=${o.id}` });
    return this.view(this.row(o.id), 'org');
  }

  setAutoRenew(sponsorId: string, orderId: string, on: boolean) {
    const o = this.forSponsor(sponsorId, orderId);
    this.db.prepare('UPDATE sp_orders SET auto_renew = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, now(), o.id);
    this.note(o, { id: null, kind: 'sponsor' }, `Auto-renew ${on ? 'on' : 'off'}`);
    return this.view(this.row(o.id), 'sponsor');
  }

  /** Renewal at the package's current price, starting the day after the current period. */
  renew(user: AuthUser, sponsorId: string | null, orderId: string, b: any = {}) {
    const o = sponsorId ? this.forSponsor(sponsorId, orderId) : this.row(orderId);
    if (!['ACTIVE', 'PAUSED', 'EXPIRED'].includes(o.status)) throw new HttpError(409, 'Only active or recently expired sponsorships can be renewed', 'INVALID_STATE');
    if (o.status === 'EXPIRED' && daysBetween(o.ends_on, today()) > 60) throw new HttpError(409, 'This sponsorship expired more than 60 days ago. Buy it again from the marketplace.', 'INVALID_STATE');
    const existing = this.db.prepare(`SELECT * FROM sp_orders WHERE renewal_of = ? AND status NOT IN ('CANCELLED','REFUNDED')`).get(o.id) as any;
    if (existing) return this.view(existing, 'sponsor');
    const startsOn = o.ends_on >= today() ? addDays(o.ends_on, 1) : today();
    const approved = Object.fromEntries((this.db.prepare("SELECT role, asset_id FROM sp_order_assets WHERE order_id = ? AND status = 'approved'").all(o.id) as any[]).map((r) => [r.role, r.asset_id]));
    const holdUntil = new Date(Math.max(Date.now() + 72 * 3600e3, Date.parse(startsOn + 'T23:59:59Z') + 3 * 864e5)).toISOString();
    return this.createOrder(user, o.sponsor_id, { opportunityId: o.opportunity_id, packageId: o.package_id, startsOn, assetIds: approved, clickUrl: o.click_url ?? undefined, autoRenew: b.autoRenew ?? !!o.auto_renew, idempotencyKey: `renew:${o.id}:${Date.now()}` }, 'renewal', { renewalOf: o.id, holdUntil });
  }

  // ------------------------------------------------------------------ refunds
  refundable(orderId: string) {
    const captured = (this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM sp_payments WHERE order_id = ? AND status IN ('captured','refunded','partially_refunded')").get(orderId) as any).n;
    const refunded = (this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM sp_refunds WHERE order_id = ? AND status IN ('requested','pending','processed')").get(orderId) as any).n;
    return Math.max(0, captured - refunded);
  }

  private async refundAll(o: any, reason: string, actor: Actor) {
    const amt = this.refundable(o.id);
    if (amt > 0) await this.refund(actor, o, { amountMinor: amt, reason });
  }

  /** Organizer/platform refund (full or partial). Amount is split across captured payments. */
  async refund(actor: Actor, o: any, b: { amountMinor?: number; reason: string }) {
    const refundable = this.refundable(o.id);
    const amount = b.amountMinor ?? refundable;
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Refund amount must be positive', 'VALIDATION');
    if (amount > refundable) throw new HttpError(400, `At most ${money(refundable, o.currency)} can be refunded`, 'VALIDATION');
    const pays = this.db.prepare("SELECT * FROM sp_payments WHERE order_id = ? AND status IN ('captured','partially_refunded') ORDER BY captured_at").all(o.id) as any[];
    let left = amount;
    const out: any[] = [];
    for (const p of pays) {
      if (!left) break;
      const done = (this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM sp_refunds WHERE payment_id = ? AND status IN ('requested','pending','processed')").get(p.id) as any).n;
      const take = Math.min(left, p.amount_minor - done);
      if (take <= 0) continue;
      out.push(await this.refundPayment(o, p.id, take, b.reason, actor));
      left -= take;
    }
    // A full refund ends the sponsorship immediately (branding off), REFUNDED once the provider confirms.
    const fresh = this.row(o.id);
    if (!this.refundable(o.id) && ['ACTIVE', 'PAUSED', 'PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW'].includes(fresh.status)) {
      const wasLive = ['ACTIVE', 'PAUSED'].includes(fresh.status);
      this.transition(fresh, 'CANCELLED', actor, 'Fully refunded');
      if (wasLive) (this.d.branding.setActive(o.id, false), this.d.onBrandingChange(o.org_id));
    }
    return { refunds: out, order: this.view(this.row(o.id), actor.kind === 'sponsor' ? 'sponsor' : 'org') };
  }

  private async refundPayment(o: any, paymentId: string, amount: number, reason: string, actor: Actor) {
    const p = this.db.prepare('SELECT * FROM sp_payments WHERE id = ?').get(paymentId) as any;
    const provider = this.providerFor(p);
    if (!provider.supports.refunds) throw new HttpError(409, `${provider.label} refunds must be issued from the provider dashboard`, 'NOT_SUPPORTED');
    const rid = id();
    this.db.prepare('INSERT INTO sp_refunds (id, order_id, payment_id, provider, amount_minor, reason, status, requested_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(rid, o.id, p.id, p.provider, amount, reason.slice(0, 300), 'requested', actor.id, now(), now());
    let res;
    try {
      res = await provider.refund({ providerOrderId: p.provider_order_id.split('#')[0], providerPaymentId: p.provider_payment_id, amountMinor: amount, currency: p.currency, reason, refundRef: rid });
    } catch (e: any) {
      this.db.prepare("UPDATE sp_refunds SET status = 'failed', reason = ?, updated_at = ? WHERE id = ?").run(`${reason} — provider error: ${String(e?.message ?? e).slice(0, 200)}`, now(), rid);
      throw new HttpError(502, 'The payment provider rejected the refund. Try again or refund from the provider dashboard.', 'PROVIDER_ERROR');
    }
    this.db.prepare('UPDATE sp_refunds SET provider_refund_id = ?, status = ?, updated_at = ? WHERE id = ?').run(res.providerRefundId, 'pending', now(), rid);
    this.d.ctx.audit(o.org_id, actor.id, 'refund.requested', 'sp_refund', rid, { amount, reason, provider: p.provider });
    if (res.status === 'processed') this.applyRefundProcessed(rid);
    else if (p.provider === 'sandbox') this.deliverSandbox(() => this.d.registry.sandbox.settleRefund(res.providerRefundId));
    return { id: rid, amountMinor: amount, status: res.status };
  }

  /** The sandbox delivers its signed events to our own webhook endpoint logic, asynchronously, like a real gateway. */
  deliverSandbox(make: () => { body: string; headers: Record<string, string> } | null) {
    setTimeout(() => {
      const ev = make();
      if (ev) void this.webhook('sandbox', null, Buffer.from(ev.body), ev.headers).catch((e) => console.error('sandbox webhook', e));
    }, 20).unref?.();
  }

  private refundSettled(providerName: string, ev: WebhookEvent, status: 'processed' | 'failed'): string {
    let r = ev.providerRefundId ? (this.db.prepare('SELECT * FROM sp_refunds WHERE provider = ? AND provider_refund_id = ?').get(providerName, ev.providerRefundId) as any) : null;
    if (!r && status === 'processed') {
      // refund issued from the provider's dashboard: adopt it
      const p = ev.providerPaymentId ? (this.db.prepare('SELECT * FROM sp_payments WHERE provider = ? AND provider_payment_id = ?').get(providerName, ev.providerPaymentId) as any) : null;
      if (!p) return 'unknown_refund';
      const rid = id();
      this.db.prepare('INSERT INTO sp_refunds (id, order_id, payment_id, provider, provider_refund_id, amount_minor, reason, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(rid, p.order_id, p.id, providerName, ev.providerRefundId ?? null, ev.amountMinor ?? 0, 'Issued from provider dashboard', 'pending', now(), now());
      r = this.db.prepare('SELECT * FROM sp_refunds WHERE id = ?').get(rid);
    }
    if (!r) return 'unknown_refund';
    if (status === 'failed') {
      this.db.prepare("UPDATE sp_refunds SET status = 'failed', updated_at = ? WHERE id = ?").run(now(), r.id);
      const o = this.row(r.order_id);
      void this.d.notify.event({ event: 'refund.failed', orgId: o.org_id, title: `Refund failed · ${o.number}`, body: `A refund of ${money(r.amount_minor, o.currency)} failed at the provider. Retry it from the sponsorship page.` });
      return 'refund_failed';
    }
    return this.applyRefundProcessed(r.id);
  }

  private applyRefundProcessed(refundId: string): string {
    let result = 'refund_processed';
    tx(this.db, () => {
      const r = this.db.prepare('SELECT * FROM sp_refunds WHERE id = ?').get(refundId) as any;
      if (r.status === 'processed') return void (result = 'already_processed');
      this.db.prepare("UPDATE sp_refunds SET status = 'processed', updated_at = ? WHERE id = ?").run(now(), r.id);
      const o = this.row(r.order_id);
      const p = this.db.prepare('SELECT * FROM sp_payments WHERE id = ?').get(r.payment_id) as any;
      const refundedOnPayment = (this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM sp_refunds WHERE payment_id = ? AND status = 'processed'").get(p.id) as any).n;
      this.db.prepare('UPDATE sp_payments SET status = ?, updated_at = ? WHERE id = ?').run(refundedOnPayment >= p.amount_minor ? 'refunded' : 'partially_refunded', now(), p.id);
      // reverse the money split in proportion — only for the payment that was booked as revenue
      if (p.booked) {
        const ratio = r.amount_minor / o.total_minor;
        const commission = Math.round(bps(o.subtotal_minor, o.commission_bps) * ratio);
        const fee = Math.round(o.platform_fee_minor * ratio);
        const taxFee = Math.round((o.tax_minor - bps(o.subtotal_minor, o.tax_rate_bps)) * ratio);
        this.ledger(o, 'refund', -r.amount_minor, r.reason);
        this.ledger(o, 'commission', -commission);
        this.ledger(o, 'platform_fee', -fee);
        this.ledger(o, 'tax_platform', -taxFee);
        if (p.scope_org) this.ledger(o, 'commission_receivable', -(commission + fee + taxFee));
        else this.ledger(o, 'organizer_payable', -(r.amount_minor - commission - fee - taxFee));
      } else this.ledger(o, 'refund_unbooked', -r.amount_minor, r.reason); // duplicate / mismatched / late money returned
      const s = getOrgSettings(this.db, o.org_id);
      const fy = financialYear();
      const cn = `${s.invoicePrefix}/CN/${fy}/${String(nextNumber(this.db, `cn:${o.org_id}:${fy}`)).padStart(4, '0')}`;
      this.db.prepare('INSERT INTO sp_invoices (id, number, order_id, org_id, sponsor_id, kind, currency, total_minor, data, issued_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id(), cn, o.id, o.org_id, o.sponsor_id, 'credit_note', o.currency, -r.amount_minor, J({ refundId: r.id, reason: r.reason }), now());
      this.d.docs.store(o.id, 'credit_note', noticeModel('Credit Note', cn, [`Refund of ${money(r.amount_minor, o.currency)} against order ${o.number}.`, `Reason: ${r.reason ?? '—'}.`, `Provider reference: ${r.provider_refund_id ?? '—'}.`]));
      if (!this.refundable(o.id) && TRANSITIONS[o.status as OrderStatus].includes('REFUNDED')) this.transition(o, 'REFUNDED', { id: null, kind: 'provider' }, 'Refund completed');
      void this.d.notify.event({ event: 'refund.processed', sponsorId: o.sponsor_id, title: `Refund completed · ${o.number}`, body: `${money(r.amount_minor, o.currency)} has been refunded to your original payment method.`, link: `/sponsor#order=${o.id}` });
    });
    return result;
  }

  // ------------------------------------------------------------------ scheduled jobs
  /** Holds, expiry, reminders and auto-renewals. Safe to run any number of times. */
  async runJobs(at = new Date()) {
    const nowIso = at.toISOString();
    const day = nowIso.slice(0, 10);
    const sys: Actor = { id: null, kind: 'system' };
    const out = { holdsReleased: 0, expired: 0, reminders: 0, renewals: 0 };
    for (const o of this.db.prepare("SELECT * FROM sp_orders WHERE status = 'PENDING_PAYMENT' AND hold_expires_at IS NOT NULL AND hold_expires_at < ?").all(nowIso) as any[]) {
      try {
        this.transition(o, 'CANCELLED', sys, 'Payment not completed in time; inventory released');
        out.holdsReleased++;
      } catch {
        /* moved concurrently */
      }
    }
    for (const o of this.db.prepare("SELECT * FROM sp_orders WHERE status IN ('ACTIVE','PAUSED') AND ends_on < ?").all(day) as any[]) {
      try {
        this.transition(o, 'EXPIRED', sys, 'Period ended');
        this.d.branding.setActive(o.id, false);
        this.d.onBrandingChange(o.org_id);
        out.expired++;
        void this.d.notify.event({ event: 'sponsorship.expired', sponsorId: o.sponsor_id, title: `Sponsorship ended · ${o.number}`, body: 'Your sponsorship period has ended. Renew within 60 days to keep your slot.', link: `/sponsor#order=${o.id}` });
      } catch {
        /* ignore */
      }
    }
    const days = [...getPlatformSettings(this.db).renewalReminderDays].sort((a, b) => a - b);
    for (const o of this.db.prepare("SELECT * FROM sp_orders WHERE status IN ('ACTIVE','PAUSED') AND ends_on >= ?").all(day) as any[]) {
      const left = daysBetween(day, o.ends_on);
      const due = days.find((n) => left <= n);
      if (due == null) continue;
      if (this.db.prepare('SELECT 1 FROM sp_reminders WHERE order_id = ? AND kind = ?').get(o.id, `expiry_${due}`)) continue;
      // mark this and every larger threshold as sent so a late job doesn't send a burst
      for (const n of days.filter((n) => n >= due)) this.db.prepare('INSERT OR IGNORE INTO sp_reminders (order_id, kind, sent_at) VALUES (?,?,?)').run(o.id, `expiry_${n}`, nowIso);
      out.reminders++;
      void this.d.notify.event({ event: 'sponsorship.renewal_reminder', sponsorId: o.sponsor_id, title: `${left === 0 ? 'Ends today' : `${left} day${left === 1 ? '' : 's'} left`} · ${o.number}`, body: o.auto_renew ? `Auto-renewal is on; we'll renew on ${o.ends_on}.` : `Your sponsorship ends on ${o.ends_on}. Renew to keep your placements.`, link: `/sponsor#order=${o.id}`, channels: ['email', 'whatsapp'] });
    }
    for (const o of this.db.prepare(`SELECT * FROM sp_orders WHERE status = 'ACTIVE' AND auto_renew = 1 AND ends_on <= ? AND NOT EXISTS (SELECT 1 FROM sp_orders r WHERE r.renewal_of = sp_orders.id AND r.status NOT IN ('CANCELLED','REFUNDED'))`).all(new Date(at.getTime() + 7 * 864e5).toISOString().slice(0, 10)) as any[]) {
      try {
        await this.autoRenew(o);
        out.renewals++;
      } catch (e: any) {
        this.d.ctx.audit(o.org_id, null, 'sponsorship.auto_renew_failed', 'sp_order', o.id, { error: String(e?.message ?? e).slice(0, 300) });
      }
    }
    return out;
  }

  private async autoRenew(o: any) {
    const owner = this.db.prepare("SELECT u.id, u.email, u.name FROM sponsor_members m JOIN users u ON u.id = m.user_id WHERE m.sponsor_id = ? AND m.role IN ('owner','admin','finance') ORDER BY m.created_at LIMIT 1").get(o.sponsor_id) as any;
    if (!owner) throw new Error('no billing member');
    const view = this.renew({ id: owner.id, orgId: '', email: owner.email, name: owner.name, role: 'member' }, o.sponsor_id, o.id);
    const r = this.row(view.id);
    if (r.status !== 'PENDING_PAYMENT') return;
    const { provider, scope } = this.d.registry.forOrg(r.org_id, r.currency);
    const billing = P<any>((this.db.prepare('SELECT billing FROM sponsor_accounts WHERE id = ?').get(o.sponsor_id) as any).billing, {});
    const saved = billing.providerCustomers?.[provider.id];
    const base = this.d.baseUrl();
    const req = { orderId: r.id, number: r.number, amountMinor: r.total_minor, currency: r.currency, description: `Renewal ${r.number}`, customer: { id: o.sponsor_id, name: owner.name, email: owner.email }, returnUrl: `${base}/sponsor#order=${r.id}`, cancelUrl: `${base}/sponsor#order=${r.id}`, notifyUrl: `${base}/api/payments/webhook/${provider.id}` };
    let providerOrderId: string;
    let link = `${base}/sponsor#order=${r.id}`;
    if (saved && provider.chargeSaved) {
      providerOrderId = (await provider.chargeSaved({ ...req, customerRef: saved })).providerOrderId;
    } else if (provider.createPaymentLink) {
      const pl = await provider.createPaymentLink(req);
      providerOrderId = pl.providerOrderId;
      link = pl.url.startsWith('/') ? base + pl.url : pl.url;
    } else return void this.d.notify.event({ event: 'sponsorship.renewal_created', sponsorId: o.sponsor_id, title: `Renewal ready · ${r.number}`, body: `Pay ${money(r.total_minor, r.currency)} to renew from ${r.starts_on}.`, link });
    this.db.prepare('INSERT INTO sp_payments (id, order_id, provider, provider_order_id, amount_minor, currency, status, scope_org, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id(), r.id, provider.id, providerOrderId, r.total_minor, r.currency, 'created', scope === 'org' ? r.org_id : null, now(), now());
    this.db.prepare('UPDATE sp_documents SET accepted_by = ?, accepted_at = ?, accepted_ip = ? WHERE order_id = ? AND kind = ? AND accepted_at IS NULL').run(owner.id, now(), 'auto-renew', r.id, 'agreement');
    void this.d.notify.event({ event: 'sponsorship.renewal_created', sponsorId: o.sponsor_id, title: `Renewal · ${r.number}`, body: saved ? `We're charging ${money(r.total_minor, r.currency)} to your saved method to renew from ${r.starts_on}.` : `Pay ${money(r.total_minor, r.currency)} to renew from ${r.starts_on}: ${link}`, link, channels: ['email', 'whatsapp'] });
  }

  // ------------------------------------------------------------------ views
  view(o: any, as: 'sponsor' | 'org' | 'admin') {
    const opp = this.db.prepare('SELECT id, title, slug, sport, city, approval_mode, tournament_id FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
    const pkg = o.package_id ? (this.db.prepare('SELECT id, name, tier FROM sp_packages WHERE id = ?').get(o.package_id) as any) : null;
    const org = this.db.prepare('SELECT name, slug FROM organizations WHERE id = ?').get(o.org_id) as any;
    const sp = this.db.prepare('SELECT id, name, slug FROM sponsor_accounts WHERE id = ?').get(o.sponsor_id) as any;
    const items = (this.db.prepare('SELECT * FROM sp_order_items WHERE order_id = ?').all(o.id) as any[]).map((i) => ({ type: i.type, label: inventoryType(i.type)?.label ?? i.name, quantity: i.quantity, scope: i.scope_type, deliverable: !!inventoryType(i.type)?.deliverable }));
    const assets = (this.db.prepare('SELECT oa.*, s.kind, s.status AS asset_status, s.text FROM sp_order_assets oa JOIN sponsor_assets s ON s.id = oa.asset_id WHERE oa.order_id = ?').all(o.id) as any[]).map((a) => ({
      role: a.role, assetId: a.asset_id, kind: a.kind, status: a.status, assetStatus: a.asset_status, note: a.note, proposedAssetId: a.proposed_asset_id,
      preview: a.kind === 'ad_copy' ? null : `/media/${a.asset_id}?v=thumb`, proposedPreview: a.proposed_asset_id ? `/media/${a.proposed_asset_id}?v=thumb` : null, text: a.text,
    }));
    const pays = (this.db.prepare('SELECT * FROM sp_payments WHERE order_id = ? ORDER BY created_at').all(o.id) as any[]).map((p) => ({ id: p.id, provider: p.provider, status: p.status, amountMinor: p.amount_minor, amount: format(p.amount_minor, p.currency), method: p.method, reference: p.provider_payment_id, capturedAt: p.captured_at, createdAt: p.created_at }));
    const refunds = (this.db.prepare('SELECT * FROM sp_refunds WHERE order_id = ? ORDER BY created_at').all(o.id) as any[]).map((r) => ({ id: r.id, amountMinor: r.amount_minor, amount: format(r.amount_minor, o.currency), status: r.status, reason: r.reason, createdAt: r.created_at }));
    const deliverables = this.db.prepare('SELECT id, type, label, status, proof_url AS proofUrl, note, delivered_at AS deliveredAt FROM sp_deliverables WHERE order_id = ?').all(o.id);
    const placements = (this.db.prepare('SELECT id, surface, scope_type AS scopeType, active FROM sp_placements WHERE order_id = ?').all(o.id) as any[]).map((p) => ({ ...p, active: !!p.active }));
    const events = this.db.prepare('SELECT from_status AS "from", to_status AS "to", actor_kind AS actor, note, at FROM sp_order_events WHERE order_id = ? ORDER BY id').all(o.id);
    const qr = this.db.prepare('SELECT code, target_url FROM sp_qr_codes WHERE order_id = ?').get(o.id) as any;
    const agreement = this.d.docs.latest(o.id, 'agreement');
    const commission = bps(o.subtotal_minor, o.commission_bps);
    return {
      id: o.id, number: o.number, status: o.status, source: o.source,
      opportunity: opp && { id: opp.id, title: opp.title, slug: opp.slug, sport: opp.sport, city: opp.city, approvalMode: opp.approval_mode }, package: pkg,
      organizer: org?.name, sponsor: sp, currency: o.currency,
      subtotalMinor: o.subtotal_minor, platformFeeMinor: o.platform_fee_minor, taxMinor: o.tax_minor, totalMinor: o.total_minor, taxRateBps: o.tax_rate_bps,
      amounts: { subtotal: format(o.subtotal_minor, o.currency), platformFee: format(o.platform_fee_minor, o.currency), tax: format(o.tax_minor, o.currency), total: format(o.total_minor, o.currency) },
      startsOn: o.starts_on, endsOn: o.ends_on, autoRenew: !!o.auto_renew, renewalOf: o.renewal_of, holdExpiresAt: o.status === 'PENDING_PAYMENT' ? o.hold_expires_at : null,
      clickUrl: o.click_url, items, assets, payments: pays, refunds, refundableMinor: this.refundable(o.id), deliverables, placements, events,
      qr: qr ? { code: qr.code, url: `/q/${qr.code}`, target: qr.target_url } : null,
      agreement: agreement ? { sha256: agreement.sha256, acceptedAt: agreement.accepted_at, documentId: agreement.id } : null,
      documents: this.d.docs.list(o.id),
      ...(as !== 'sponsor' ? { risk: P<string[]>(o.risk, []), commissionMinor: commission, organizerNetMinor: o.subtotal_minor - commission, commissionBps: o.commission_bps } : {}),
      createdAt: o.created_at, updatedAt: o.updated_at,
    };
  }

  list(where: { sponsorId?: string; orgId?: string; status?: string | null }, as: 'sponsor' | 'org' | 'admin', limit = 200) {
    const cond: string[] = [];
    const args: any[] = [];
    if (where.sponsorId) (cond.push('sponsor_id = ?'), args.push(where.sponsorId));
    if (where.orgId) (cond.push('org_id = ?'), args.push(where.orgId));
    if (where.status) {
      const st = where.status.split(',').filter((s) => (ORDER_STATUSES as readonly string[]).includes(s));
      if (st.length) (cond.push(`status IN (${st.map(() => '?').join(',')})`), args.push(...st));
    }
    const rows = this.db.prepare(`SELECT * FROM sp_orders ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as any[];
    return rows.map((o) => {
      const opp = this.db.prepare('SELECT title, sport, city FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
      const pkg = o.package_id ? (this.db.prepare('SELECT name, tier FROM sp_packages WHERE id = ?').get(o.package_id) as any) : null;
      const sp = this.db.prepare('SELECT name, slug FROM sponsor_accounts WHERE id = ?').get(o.sponsor_id) as any;
      const org = this.db.prepare('SELECT name FROM organizations WHERE id = ?').get(o.org_id) as any;
      return {
        id: o.id, number: o.number, status: o.status, opportunity: opp?.title, sport: opp?.sport, city: opp?.city, package: pkg?.name, tier: pkg?.tier,
        sponsor: sp?.name, sponsorSlug: sp?.slug, organizer: org?.name, currency: o.currency, totalMinor: o.total_minor, total: format(o.total_minor, o.currency),
        startsOn: o.starts_on, endsOn: o.ends_on, autoRenew: !!o.auto_renew, source: o.source, createdAt: o.created_at,
        ...(as !== 'sponsor' ? { risk: P<string[]>(o.risk, []) } : {}),
      };
    });
  }

  // ------------------------------------------------------------------ settlements (marketplace payouts)
  /** Organizer money collected on the platform account and not yet paid out, per org and currency. */
  settlementPreview(orgId?: string) {
    const rows = this.db.prepare(`SELECT l.org_id, l.currency, SUM(l.amount_minor) AS amount, COUNT(DISTINCT l.order_id) AS orders FROM sp_ledger l JOIN sp_orders o ON o.id = l.order_id
      WHERE l.kind = 'organizer_payable' AND l.settlement_id IS NULL AND o.status IN ('ACTIVE','PAUSED','EXPIRED','REFUNDED','CANCELLED') ${orgId ? 'AND l.org_id = ?' : ''} GROUP BY l.org_id, l.currency`).all(...(orgId ? [orgId] : [])) as any[];
    return rows.map((r) => ({ orgId: r.org_id, organizer: (this.db.prepare('SELECT name FROM organizations WHERE id = ?').get(r.org_id) as any)?.name, currency: r.currency, amountMinor: r.amount, amount: format(r.amount, r.currency), orders: r.orders }));
  }

  createSettlement(actor: Actor, orgId: string, currency: string) {
    return tx(this.db, () => {
      const rows = this.db.prepare(`SELECT l.id, l.order_id, l.amount_minor FROM sp_ledger l JOIN sp_orders o ON o.id = l.order_id WHERE l.kind = 'organizer_payable' AND l.settlement_id IS NULL AND l.org_id = ? AND l.currency = ?
        AND o.status IN ('ACTIVE','PAUSED','EXPIRED','REFUNDED','CANCELLED')`).all(orgId, currency) as any[];
      const amount = rows.reduce((s, r) => s + r.amount_minor, 0);
      if (!rows.length || amount <= 0) throw new HttpError(409, 'Nothing to settle for this organizer', 'NOTHING_TO_SETTLE');
      const sid = id();
      this.db.prepare('INSERT INTO sp_settlements (id, org_id, currency, amount_minor, status, provider, order_ids, created_at) VALUES (?,?,?,?,?,?,?,?)').run(sid, orgId, currency, amount, 'pending', 'manual', J([...new Set(rows.map((r) => r.order_id))]), now());
      const upd = this.db.prepare('UPDATE sp_ledger SET settlement_id = ? WHERE id = ?');
      for (const r of rows) upd.run(sid, r.id);
      this.d.ctx.audit(orgId, actor.id, 'settlement.created', 'sp_settlement', sid, { amount, currency });
      return { id: sid, amountMinor: amount, amount: format(amount, currency), orders: new Set(rows.map((r) => r.order_id)).size };
    });
  }

  markSettlementPaid(actor: Actor, settlementId: string, reference: string) {
    const s = this.db.prepare('SELECT * FROM sp_settlements WHERE id = ?').get(settlementId) as any;
    if (!s) throw new HttpError(404, 'Settlement not found', 'NOT_FOUND');
    if (s.status === 'paid') throw new HttpError(409, 'Already marked paid', 'CONFLICT');
    if (!reference || reference.length < 3) throw new HttpError(400, 'Enter the bank/UTR reference of the payout', 'VALIDATION');
    this.db.prepare("UPDATE sp_settlements SET status = 'paid', reference = ?, paid_at = ? WHERE id = ?").run(reference.slice(0, 80), now(), s.id);
    this.d.ctx.audit(s.org_id, actor.id, 'settlement.paid', 'sp_settlement', s.id, { reference });
    void this.d.notify.event({ event: 'settlement.paid', orgId: s.org_id, title: 'Sponsorship payout sent', body: `${format(s.amount_minor, s.currency)} was paid out. Reference ${reference}.` });
    return { ok: true };
  }
}
