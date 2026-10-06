/**
 * Marketplace: organizer inventory, opportunities and packages; public discovery.
 *
 * Opportunities hang off real platform entities (tournament / venue / match), so the
 * marketplace can state facts it actually knows: how many matches, which venues, how many
 * paired screens. Audience figures are the organizer's own estimates and are labelled so.
 */
import type { AuthUser } from '../auth.ts';
import { HttpError, id } from '../context.ts';
import type { DB } from '../db.ts';
import { J, P, now, tx } from '../db.ts';
import { INVENTORY_TYPES, LEVELS, SALE_MODELS, exposureOf, inventoryType, type ScopeType } from './catalog.ts';
import { convert, format, isCurrency, toMinor } from './money.ts';
import { getOrgSettings, getPlatformSettings } from './settings.ts';

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'opportunity';
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Standard tiers from the brief, expressed as real inventory so each benefit activates (or is tracked) on its own. */
export const TIER_TEMPLATES: Record<string, { name: string; tier: string; price: number; items: [string, number][] }> = {
  gold: { name: 'Gold Sponsor', tier: 'gold', price: 100000, items: [['associate_sponsor', 1], ['tv_scoreboard_logo', 1], ['live_score_branding', 1], ['website_banner', 1], ['instagram_post', 2], ['email_promotion', 1], ['digital_banner', 1], ['tv_fullscreen_ad', 5]] },
  silver: { name: 'Silver Sponsor', tier: 'silver', price: 50000, items: [['tv_scoreboard_logo', 1], ['website_banner', 1], ['instagram_post', 1], ['wall_branding', 1]] },
  bronze: { name: 'Bronze Sponsor', tier: 'bronze', price: 25000, items: [['website_banner', 1], ['associate_sponsor', 1], ['facebook_post', 1]] },
};

export class Marketplace {
  constructor(private db: DB) {}

  // ------------------------------------------------------------------ inventory
  private assertScope(orgId: string, scopeType: ScopeType, scopeId: string | null) {
    if (scopeType === 'org') return;
    if (!scopeId) return; // bound to the opportunity's own tournament/venue/match at activation
    const table = scopeType === 'tournament' ? 'tournaments' : scopeType === 'venue' ? 'venues' : 'matches';
    if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND org_id = ?`).get(scopeId, orgId)) throw new HttpError(400, `Unknown ${scopeType}`, 'VALIDATION');
  }

  createInventory(user: AuthUser, b: any) {
    const t = inventoryType(b.type);
    if (!t) throw new HttpError(400, 'Unknown inventory type', 'VALIDATION', { allowed: INVENTORY_TYPES.map((x) => x.type) });
    const scopeType: ScopeType = b.scopeType ?? t.scopes[0];
    if (!t.scopes.includes(scopeType)) throw new HttpError(400, `${t.label} can be scoped to: ${t.scopes.join(', ')}`, 'VALIDATION');
    this.assertScope(user.orgId, scopeType, b.scopeId ?? null);
    const currency = b.currency ?? 'INR';
    if (!isCurrency(currency)) throw new HttpError(400, 'Unsupported currency', 'VALIDATION');
    const qty = Number(b.quantity ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new HttpError(400, 'quantity must be 1–10000', 'VALIDATION');
    const iid = id();
    this.db.prepare('INSERT INTO sp_inventory (id, org_id, type, name, scope_type, scope_id, quantity, unit_price_minor, currency, options, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      iid, user.orgId, t.type, String(b.name ?? t.label).slice(0, 120), scopeType, b.scopeId ?? null, qty, toMinor(b.unitPrice ?? 0, currency), currency, J(b.options ?? {}), now(),
    );
    return this.inventoryRow(iid);
  }

  inventoryRow(iid: string) {
    const r = this.db.prepare('SELECT * FROM sp_inventory WHERE id = ?').get(iid) as any;
    const t = inventoryType(r.type)!;
    return { id: r.id, type: r.type, label: t.label, name: r.name, category: t.category, scopeType: r.scope_type, scopeId: r.scope_id, quantity: r.quantity, unitPriceMinor: r.unit_price_minor, currency: r.currency, deliverable: !!t.deliverable, surfaces: t.surfaces, active: !!r.active, sold: this.inventorySold(iid) };
  }

  listInventory(orgId: string) {
    return (this.db.prepare('SELECT id FROM sp_inventory WHERE org_id = ? AND active = 1 ORDER BY created_at').all(orgId) as any[]).map((r) => this.inventoryRow(r.id));
  }

  /** Units of an inventory item committed to orders that are paid, active, or holding stock. */
  inventorySold(iid: string): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(oi.quantity),0) AS n FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id
      WHERE oi.inventory_id = ? AND (o.status IN ('PAYMENT_RECEIVED','PENDING_APPROVAL','ASSET_REVIEW','ACTIVE','PAUSED') OR (o.status = 'PENDING_PAYMENT' AND o.hold_expires_at > ?))`).get(iid, now()) as any).n;
  }

  // ------------------------------------------------------------------ opportunities
  createOpportunity(user: AuthUser, b: any) {
    if (!b.title || String(b.title).trim().length < 4) throw new HttpError(400, 'Give the opportunity a title', 'VALIDATION');
    const saleModel = b.saleModel ?? 'fixed';
    if (!(SALE_MODELS as readonly string[]).includes(saleModel)) throw new HttpError(400, `saleModel must be one of ${SALE_MODELS.join(', ')}`, 'VALIDATION');
    const approval = b.approvalMode ?? 'auto';
    if (!['auto', 'manual', 'asset_review'].includes(approval)) throw new HttpError(400, 'approvalMode must be auto, manual or asset_review', 'VALIDATION');
    const level = b.level ?? 'local';
    if (!(LEVELS as readonly string[]).includes(level)) throw new HttpError(400, `level must be one of ${LEVELS.join(', ')}`, 'VALIDATION');
    const currency = b.currency ?? 'INR';
    if (!isCurrency(currency)) throw new HttpError(400, 'Unsupported currency', 'VALIDATION');
    if (b.startsOn && !isDate(b.startsOn)) throw new HttpError(400, 'startsOn must be YYYY-MM-DD', 'VALIDATION');
    if (b.endsOn && !isDate(b.endsOn)) throw new HttpError(400, 'endsOn must be YYYY-MM-DD', 'VALIDATION');
    if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) throw new HttpError(400, 'The end date is before the start date', 'VALIDATION');

    let tournament: any = null;
    if (b.tournamentId) {
      tournament = this.db.prepare('SELECT * FROM tournaments WHERE id = ? AND org_id = ?').get(b.tournamentId, user.orgId);
      if (!tournament) throw new HttpError(400, 'Unknown tournament', 'VALIDATION');
    }
    const venueId = b.venueId ?? tournament?.venue_id ?? null;
    if (venueId && !this.db.prepare('SELECT 1 FROM venues WHERE id = ? AND org_id = ?').get(venueId, user.orgId)) throw new HttpError(400, 'Unknown venue', 'VALIDATION');
    if (b.matchId && !this.db.prepare('SELECT 1 FROM matches WHERE id = ? AND org_id = ?').get(b.matchId, user.orgId)) throw new HttpError(400, 'Unknown match', 'VALIDATION');

    const oid = id();
    let slug = slugify(b.title);
    while (this.db.prepare('SELECT 1 FROM sp_opportunities WHERE org_id = ? AND slug = ?').get(user.orgId, slug)) slug = `${slugify(b.title).slice(0, 52)}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const t = now();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO sp_opportunities (id, org_id, title, slug, description, sport, tournament_id, venue_id, match_id, country, state, city, level, audience_estimate,
        audience_profile, starts_on, ends_on, sale_model, approval_mode, currency, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        oid, user.orgId, String(b.title).trim().slice(0, 140), slug, b.description?.slice(0, 5000) ?? null, b.sport ?? tournament?.sport ?? null, tournament?.id ?? null, venueId,
        b.matchId ?? null, b.country ?? 'India', b.state ?? null, b.city ?? null, level, Math.max(0, Math.round(Number(b.audienceEstimate ?? 0))), J(b.audienceProfile ?? {}),
        b.startsOn ?? null, b.endsOn ?? null, saleModel, approval, currency, b.publish ? 'published' : 'draft', t, t,
      );
      for (const [i, p] of (b.packages ?? []).entries()) this.addPackage(user, oid, p, i);
    });
    return this.detail(oid, { orgId: user.orgId });
  }

  private ownOpportunity(orgId: string, oid: string) {
    const o = this.db.prepare('SELECT * FROM sp_opportunities WHERE id = ? AND org_id = ?').get(oid, orgId) as any;
    if (!o) throw new HttpError(404, 'Opportunity not found', 'NOT_FOUND');
    return o;
  }

  updateOpportunity(user: AuthUser, oid: string, b: any) {
    const o = this.ownOpportunity(user.orgId, oid);
    const status = b.status ?? o.status;
    if (!['draft', 'published', 'closed'].includes(status)) throw new HttpError(400, 'status must be draft, published or closed', 'VALIDATION');
    if (status === 'published') {
      const pk = this.db.prepare('SELECT COUNT(*) AS n FROM sp_packages WHERE opportunity_id = ? AND active = 1').get(oid) as any;
      if (!pk.n && o.sale_model !== 'rfp') throw new HttpError(409, 'Add at least one package before publishing', 'CONFLICT');
    }
    this.db.prepare(`UPDATE sp_opportunities SET title=?, description=?, city=?, state=?, country=?, level=?, audience_estimate=?, audience_profile=?, starts_on=?, ends_on=?,
      sale_model=?, approval_mode=?, status=?, updated_at=? WHERE id = ?`).run(
      b.title ?? o.title, b.description ?? o.description, b.city ?? o.city, b.state ?? o.state, b.country ?? o.country, b.level ?? o.level,
      b.audienceEstimate ?? o.audience_estimate, b.audienceProfile ? J(b.audienceProfile) : o.audience_profile, b.startsOn ?? o.starts_on, b.endsOn ?? o.ends_on,
      b.saleModel ?? o.sale_model, b.approvalMode ?? o.approval_mode, status, now(), oid,
    );
    return this.detail(oid, { orgId: user.orgId });
  }

  /** Package with items given as existing inventory ids, or as catalog types (inventory auto-created and scoped to the opportunity). */
  addPackage(user: AuthUser, oid: string, p: any, sort = 0) {
    const o = this.ownOpportunity(user.orgId, oid);
    const tpl = p.template ? TIER_TEMPLATES[p.template] : null;
    if (p.template && !tpl) throw new HttpError(400, 'Unknown template (gold, silver, bronze)', 'VALIDATION');
    const name = p.name ?? tpl?.name;
    if (!name) throw new HttpError(400, 'Package name is required', 'VALIDATION');
    const saleModel = p.saleModel ?? o.sale_model;
    const price = p.price ?? tpl?.price;
    if (saleModel !== 'rfp' && saleModel !== 'auction' && (price == null || Number(price) <= 0)) throw new HttpError(400, `Set a price for ${name}`, 'VALIDATION');
    const max = Number(p.maxSponsors ?? 1);
    if (!Number.isInteger(max) || max < 1 || max > 1000) throw new HttpError(400, 'maxSponsors must be 1–1000', 'VALIDATION');
    let auction: any = null;
    if (saleModel === 'auction') {
      const a = p.auction ?? {};
      if (!a.startPrice || !a.endsAt || Number.isNaN(Date.parse(a.endsAt))) throw new HttpError(400, 'Auctions need startPrice and endsAt', 'VALIDATION');
      if (Date.parse(a.endsAt) < Date.now()) throw new HttpError(400, 'Auction end time is in the past', 'VALIDATION');
      auction = { startMinor: toMinor(a.startPrice, o.currency), incrementMinor: toMinor(a.increment ?? Math.max(1000, Number(a.startPrice) * 0.05), o.currency), reserveMinor: a.reserve ? toMinor(a.reserve, o.currency) : null, endsAt: new Date(a.endsAt).toISOString(), status: 'open' };
    }
    const pid = id();
    const items: [string, number][] = [];
    for (const it of p.items ?? (tpl ? tpl.items.map(([type, quantity]) => ({ type, quantity })) : [])) {
      let inventoryId = it.inventoryId;
      if (!inventoryId) {
        const t = inventoryType(it.type);
        if (!t) throw new HttpError(400, `Unknown inventory type ${it.type}`, 'VALIDATION');
        const scopeType: ScopeType = o.match_id && t.scopes.includes('match') ? 'match' : o.tournament_id && t.scopes.includes('tournament') ? 'tournament' : o.venue_id && t.scopes.includes('venue') ? 'venue' : t.scopes.includes('org') ? 'org' : t.scopes[0];
        const scopeId = scopeType === 'match' ? o.match_id : scopeType === 'tournament' ? o.tournament_id : scopeType === 'venue' ? o.venue_id : null;
        inventoryId = this.createInventory(user, { type: t.type, scopeType, scopeId, quantity: Math.max(max * (it.quantity ?? 1), 1), unitPrice: it.unitPrice ?? 0, currency: o.currency }).id;
      } else if (!this.db.prepare('SELECT 1 FROM sp_inventory WHERE id = ? AND org_id = ?').get(inventoryId, user.orgId)) throw new HttpError(400, 'Unknown inventory item', 'VALIDATION');
      items.push([inventoryId, Math.max(1, Number(it.quantity ?? 1))]);
    }
    if (!items.length && saleModel !== 'rfp') throw new HttpError(400, `${name} needs at least one benefit`, 'VALIDATION');
    this.db.prepare(`INSERT INTO sp_packages (id, opportunity_id, name, tier, description, price_minor, currency, duration_days, max_sponsors, sale_model, auction, sort, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pid, oid, String(name).slice(0, 80), p.tier ?? tpl?.tier ?? null, p.description?.slice(0, 2000) ?? null, price != null ? toMinor(price, o.currency) : null, o.currency,
      p.durationDays ?? null, max, saleModel, auction ? J(auction) : null, p.sort ?? sort, now(),
    );
    const ins = this.db.prepare('INSERT INTO sp_package_items (package_id, inventory_id, quantity) VALUES (?,?,?)');
    for (const [iid, q] of items) ins.run(pid, iid, q);
    return pid;
  }

  // ------------------------------------------------------------------ views
  packageView(p: any, displayCurrency?: string) {
    const items = (this.db.prepare('SELECT i.*, pi.quantity AS pkg_qty FROM sp_package_items pi JOIN sp_inventory i ON i.id = pi.inventory_id WHERE pi.package_id = ?').all(p.id) as any[]).map((i) => {
      const t = inventoryType(i.type)!;
      return { inventoryId: i.id, type: i.type, label: t.label, name: i.name, quantity: i.pkg_qty, category: t.category, deliverable: !!t.deliverable, surfaces: t.surfaces, assets: t.assets };
    });
    const remaining = Math.max(0, p.max_sponsors - p.sold - this.activeHolds(p.id));
    const settings = getPlatformSettings(this.db);
    const approx = displayCurrency && displayCurrency !== p.currency && p.price_minor != null ? convert(p.price_minor, p.currency, displayCurrency, settings.fxRatesPerINR) : null;
    return {
      id: p.id, name: p.name, tier: p.tier, description: p.description, priceMinor: p.price_minor, currency: p.currency,
      price: p.price_minor != null ? format(p.price_minor, p.currency) : null, approxPrice: approx != null ? `≈ ${format(approx, displayCurrency!)}` : null,
      durationDays: p.duration_days, maxSponsors: p.max_sponsors, sold: p.sold, remaining, saleModel: p.sale_model,
      auction: p.auction ? this.auctionPublic(p) : null, items, exposure: exposureOf(items.map((i) => i.type)), active: !!p.active,
    };
  }

  activeHolds(packageId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sp_orders WHERE package_id = ? AND status = 'PENDING_PAYMENT' AND hold_expires_at > ?").get(packageId, now()) as any).n;
  }

  private auctionPublic(p: any) {
    const a = P(p.auction, {} as any);
    const bids = this.db.prepare('SELECT sponsor_id, max_minor FROM sp_bids WHERE package_id = ? AND withdrawn_at IS NULL ORDER BY max_minor DESC, created_at ASC').all(p.id) as any[];
    const top = bids[0];
    const second = bids.find((b) => b.sponsor_id !== top?.sponsor_id);
    const current = !top ? a.startMinor : second ? Math.min(top.max_minor, second.max_minor + a.incrementMinor) : a.startMinor;
    return { status: a.status, endsAt: a.endsAt, startMinor: a.startMinor, incrementMinor: a.incrementMinor, currentMinor: current, current: format(current, p.currency), bids: bids.length, reserveMet: a.reserveMinor ? (top?.max_minor ?? 0) >= a.reserveMinor : true, nextMinimumMinor: top ? current + a.incrementMinor : a.startMinor };
  }

  /** Facts the platform knows about an opportunity's reach (not estimates). */
  private facts(o: any) {
    let matches = 0;
    let venues: string[] = [];
    let screens = 0;
    if (o.tournament_id) {
      matches = (this.db.prepare('SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ?').get(o.tournament_id) as any).n;
      venues = (this.db.prepare('SELECT DISTINCT v.name FROM matches m JOIN venues v ON v.id = m.venue_id WHERE m.tournament_id = ?').all(o.tournament_id) as any[]).map((v) => v.name);
    } else if (o.match_id) matches = 1;
    const venueIds = o.venue_id ? [o.venue_id] : o.tournament_id ? (this.db.prepare('SELECT DISTINCT venue_id FROM matches WHERE tournament_id = ? AND venue_id IS NOT NULL').all(o.tournament_id) as any[]).map((r) => r.venue_id) : [];
    if (o.venue_id && !venues.length) venues = [(this.db.prepare('SELECT name FROM venues WHERE id = ?').get(o.venue_id) as any)?.name].filter(Boolean);
    if (venueIds.length) screens = (this.db.prepare(`SELECT COUNT(*) AS n FROM display_devices WHERE org_id = ? AND (venue_id IN (${venueIds.map(() => '?').join(',')}))`).get(o.org_id, ...venueIds) as any).n;
    return { matches, venues, screens };
  }

  card(o: any, displayCurrency?: string) {
    const pkgs = this.db.prepare('SELECT * FROM sp_packages WHERE opportunity_id = ? AND active = 1 ORDER BY sort, price_minor DESC').all(o.id) as any[];
    const views = pkgs.map((p) => this.packageView(p, displayCurrency));
    const priced = views.filter((v) => v.priceMinor != null);
    const minPrice = priced.length ? Math.min(...priced.map((v) => v.priceMinor!)) : null;
    const org = this.db.prepare('SELECT name, slug FROM organizations WHERE id = ?').get(o.org_id) as any;
    const tournament = o.tournament_id ? (this.db.prepare('SELECT name, public_code FROM tournaments WHERE id = ?').get(o.tournament_id) as any) : null;
    const exposure = views.reduce((acc, v) => {
      for (const [k, val] of Object.entries(v.exposure)) (acc as any)[k] = (acc as any)[k] || val;
      return acc;
    }, { tv: false, liveScore: false, broadcast: false, social: false, onsite: false, online: false });
    const days = o.starts_on && o.ends_on ? Math.round((Date.parse(o.ends_on) - Date.parse(o.starts_on)) / 864e5) + 1 : null;
    return {
      id: o.id, slug: o.slug, title: o.title, sport: o.sport, city: o.city, state: o.state, country: o.country, level: o.level,
      audienceEstimate: o.audience_estimate, startsOn: o.starts_on, endsOn: o.ends_on, durationDays: days, saleModel: o.sale_model,
      currency: o.currency, fromMinor: minPrice, from: minPrice != null ? format(minPrice, o.currency) : null,
      organizer: org?.name, tournament: tournament?.name ?? null, tournamentCode: tournament?.public_code ?? null,
      exposure, packages: views.length, available: views.some((v) => v.remaining > 0) || o.sale_model === 'rfp',
      featured: !!(o.featured_until && o.featured_until > now()), status: o.status,
      costPerViewerMinor: minPrice != null && o.audience_estimate ? Math.round(minPrice / o.audience_estimate) : null,
    };
  }

  detail(oid: string, viewer: { orgId?: string; displayCurrency?: string } = {}) {
    const o = this.db.prepare('SELECT * FROM sp_opportunities WHERE id = ? OR slug = ?').get(oid, oid) as any;
    if (!o) throw new HttpError(404, 'Opportunity not found', 'NOT_FOUND');
    const own = viewer.orgId === o.org_id;
    if (!own && o.status !== 'published') throw new HttpError(404, 'Opportunity not found', 'NOT_FOUND');
    const pkgs = this.db.prepare(`SELECT * FROM sp_packages WHERE opportunity_id = ? ${own ? '' : 'AND active = 1'} ORDER BY sort, price_minor DESC`).all(o.id) as any[];
    const s = getOrgSettings(this.db, o.org_id);
    return {
      ...this.card(o, viewer.displayCurrency),
      description: o.description, approvalMode: o.approval_mode, audienceProfile: P(o.audience_profile, {}),
      facts: this.facts(o), packages: pkgs.map((p) => this.packageView(p, viewer.displayCurrency)),
      terms: { taxRateBps: s.taxRateBps, platformFeeMinor: s.platformFeeMinor, platformFee: format(s.platformFeeMinor, o.currency) },
      tournamentId: own ? o.tournament_id : undefined, venueId: own ? o.venue_id : undefined, matchId: own ? o.match_id : undefined,
    };
  }

  listOwn(orgId: string) {
    return (this.db.prepare('SELECT * FROM sp_opportunities WHERE org_id = ? ORDER BY created_at DESC').all(orgId) as any[]).map((o) => this.card(o));
  }

  /** Public discovery with the spec's filters. All filtering is server-side and parameterized. */
  search(q: URLSearchParams) {
    const where = ["o.status = 'published'", 'COALESCE(s.marketplace_enabled, 1) = 1'];
    const args: any[] = [];
    const eq = (param: string, col: string) => {
      const v = q.get(param);
      if (v) (where.push(`LOWER(${col}) = LOWER(?)`), args.push(v));
    };
    eq('sport', 'o.sport');
    eq('city', 'o.city');
    eq('state', 'o.state');
    eq('country', 'o.country');
    eq('level', 'o.level');
    eq('saleModel', 'o.sale_model');
    if (q.get('tournament')) (where.push('(o.tournament_id = ? OR t.public_code = ?)'), args.push(q.get('tournament'), String(q.get('tournament')).toUpperCase()));
    if (q.get('venue')) (where.push('o.venue_id = ?'), args.push(q.get('venue')));
    if (q.get('organizer')) (where.push('org.slug = ?'), args.push(q.get('organizer')));
    if (q.get('from')) (where.push('(o.ends_on IS NULL OR o.ends_on >= ?)'), args.push(q.get('from')));
    if (q.get('to')) (where.push('(o.starts_on IS NULL OR o.starts_on <= ?)'), args.push(q.get('to')));
    if (q.get('minAudience')) (where.push('o.audience_estimate >= ?'), args.push(Number(q.get('minAudience'))));
    if (q.get('maxAudience')) (where.push('o.audience_estimate <= ?'), args.push(Number(q.get('maxAudience'))));
    if (q.get('q')) {
      const like = `%${String(q.get('q')).slice(0, 60)}%`;
      where.push('(o.title LIKE ? OR o.description LIKE ? OR o.city LIKE ? OR t.name LIKE ? OR org.name LIKE ?)');
      args.push(like, like, like, like, like);
    }
    const rows = this.db.prepare(`SELECT o.* FROM sp_opportunities o JOIN organizations org ON org.id = o.org_id LEFT JOIN tournaments t ON t.id = o.tournament_id
      LEFT JOIN org_sponsorship_settings s ON s.org_id = o.org_id WHERE ${where.join(' AND ')} LIMIT 500`).all(...args) as any[];
    const dc = q.get('currency') ?? undefined;
    let cards = rows.map((o) => this.card(o, dc));
    // filters that depend on package contents
    const minB = q.get('minBudget') ? toMinor(q.get('minBudget')!, 'INR') : null;
    const maxB = q.get('maxBudget') ? toMinor(q.get('maxBudget')!, 'INR') : null;
    if (minB != null) cards = cards.filter((c) => c.fromMinor != null && c.fromMinor >= minB);
    if (maxB != null) cards = cards.filter((c) => c.fromMinor != null && c.fromMinor <= maxB);
    for (const v of (q.get('visibility') ?? '').split(',').filter(Boolean)) cards = cards.filter((c) => (c.exposure as any)[v === 'live' ? 'liveScore' : v]);
    if (q.get('tv') === '1') cards = cards.filter((c) => c.exposure.tv);
    if (q.get('stream') === '1') cards = cards.filter((c) => c.exposure.broadcast);
    if (q.get('social') === '1') cards = cards.filter((c) => c.exposure.social);
    if (q.get('mode') === 'online') cards = cards.filter((c) => c.exposure.online);
    if (q.get('mode') === 'offline') cards = cards.filter((c) => c.exposure.onsite);
    if (q.get('category')) {
      const cat = q.get('category');
      cards = cards.filter((c) => (this.db.prepare('SELECT 1 FROM sp_packages p JOIN sp_package_items pi ON pi.package_id = p.id JOIN sp_inventory i ON i.id = pi.inventory_id WHERE p.opportunity_id = ? AND i.type IN (' + INVENTORY_TYPES.filter((t) => t.category === cat).map(() => '?').join(',') + ') LIMIT 1').get(c.id, ...INVENTORY_TYPES.filter((t) => t.category === cat).map((t) => t.type)) ? true : false));
    }
    if (q.get('maxDuration')) cards = cards.filter((c) => c.durationDays != null && c.durationDays <= Number(q.get('maxDuration')));
    if (q.get('available') === '1') cards = cards.filter((c) => c.available);
    const sort = q.get('sort') ?? 'featured';
    const by: Record<string, (a: any, b: any) => number> = {
      featured: (a, b) => Number(b.featured) - Number(a.featured) || (b.audienceEstimate ?? 0) - (a.audienceEstimate ?? 0),
      price: (a, b) => (a.fromMinor ?? Infinity) - (b.fromMinor ?? Infinity),
      audience: (a, b) => (b.audienceEstimate ?? 0) - (a.audienceEstimate ?? 0),
      value: (a, b) => (a.costPerViewerMinor ?? Infinity) - (b.costPerViewerMinor ?? Infinity),
      date: (a, b) => String(a.startsOn ?? '9999').localeCompare(String(b.startsOn ?? '9999')),
    };
    cards.sort(by[sort] ?? by.featured);
    const facets = {
      sports: [...new Set(rows.map((r) => r.sport).filter(Boolean))].sort(),
      cities: [...new Set(rows.map((r) => r.city).filter(Boolean))].sort(),
      states: [...new Set(rows.map((r) => r.state).filter(Boolean))].sort(),
      countries: [...new Set(rows.map((r) => r.country).filter(Boolean))].sort(),
    };
    return { total: cards.length, results: cards.slice(0, Math.min(Number(q.get('limit') ?? 60), 200)), facets };
  }

  inventoryTypes() {
    return INVENTORY_TYPES.map((t) => ({ type: t.type, label: t.label, category: t.category, scopes: t.scopes, surfaces: t.surfaces, deliverable: !!t.deliverable, assets: t.assets }));
  }
}
