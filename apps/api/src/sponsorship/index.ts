/**
 * Sponsorship marketplace module: wiring + HTTP routes.
 *
 * Reuses the platform's identity (users/sessions), organizer RBAC, tenants, tournaments,
 * matches, venues, displays, realtime hub and audit log. Adds sponsor accounts and roles,
 * the marketplace, payments, activation, branding, analytics and administration.
 */
import { createHmac } from 'node:crypto';
import type { Guard, Handler, Raw, Req, RouteFn } from '../app.ts';
import { RateLimiter, can, type AuthUser } from '../auth.ts';
import { HttpError, type Ctx } from '../context.ts';
import { P, now } from '../db.ts';
import type { DisplayService } from '../services/displays.ts';
import type { MatchService } from '../services/matches.ts';
import type { TournamentService } from '../services/tournaments.ts';
import { catalog } from '../../../../packages/engine/src/index.ts';
import { Analytics } from './analytics.ts';
import { ASSET_KINDS, ASSET_RULES, AssetService, LocalStorage, MemoryStorage } from './assets.ts';
import { Branding } from './branding.ts';
import { INDUSTRIES, LEVELS, SALE_MODELS, SPONSOR_CATEGORIES } from './catalog.ts';
import { Deals } from './deals.ts';
import { Documents, renderPdf } from './documents.ts';
import { Marketplace, TIER_TEMPLATES } from './marketplace.ts';
import { CURRENCIES, format, isCurrency, toMinor } from './money.ts';
import { Notifier } from './notify.ts';
import { PROVIDERS } from './oidc.ts';
import { OrderService, ORDER_STATUSES, type Actor } from './orders.ts';
import { PaymentRegistry, sandboxAllowed } from './payments/index.ts';
import { AGE_GROUPS, Recommender, type RecQuery } from './recommend.ts';
import { migrateSponsorship } from './schema.ts';
import { mask, secretSeed } from './secrets.ts';
import { getOrgSettings, getPlatformSettings, saveOrgSettings, setPlatformSettings, DEFAULT_SETTINGS } from './settings.ts';
import { SPONSOR_ROLES, SponsorService } from './sponsors.ts';

export interface SponsorshipModule {
  authorize(user: AuthUser, perm: string, requested?: string | null): { accountId: string; role: string };
  recordDisplayExposure(deviceId: string, shown: string[] | null): void;
  runJobs(at?: Date): Promise<any>;
  dispose(): void;
  sponsors: SponsorService;
  orders: OrderService;
  market: Marketplace;
  branding: Branding;
  registry: PaymentRegistry;
  assets: AssetService;
  deals: Deals;
  analytics: Analytics;
  recommender: Recommender;
  notify: Notifier;
}

interface Deps {
  route: RouteFn;
  raw: (type: string, body: string | Buffer, status?: number, headers?: Record<string, string>) => Raw;
  ctx: Ctx;
  matches: MatchService;
  tournaments: TournamentService;
  displays: DisplayService;
  rateLimitScale: number;
  dbFile?: string;
}

const PROVIDER_FIELDS: Record<string, string[]> = { razorpay: ['keyId', 'keySecret', 'webhookSecret'], stripe: ['secretKey', 'webhookSecret'], cashfree: ['appId', 'secretKey', 'environment'] };

export function registerSponsorship(dep: Deps): SponsorshipModule {
  const { route, raw, ctx, matches, tournaments, displays } = dep;
  const db = ctx.db;
  migrateSponsorship(db);

  const seed = process.env.SANDBOX_WEBHOOK_SEED ?? secretSeed();
  const notify = new Notifier(db);
  const sponsors = new SponsorService(db, notify);
  const assets = new AssetService(db, dep.dbFile === ':memory:' ? new MemoryStorage() : new LocalStorage());
  const registry = new PaymentRegistry(db, seed);
  const market = new Marketplace(db);
  const docs = new Documents(db);
  const branding = new Branding(db, matches);
  const analytics = new Analytics(db, market);
  const recommender = new Recommender(db, market);

  // ------------------------------------------------------------------ base URL (links in emails / gateway callbacks)
  let seenBase = 'http://localhost:8080';
  const baseUrl = () => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? seenBase;
  const noteBase = (r: Req) => {
    // Host headers are attacker-controlled: only trusted outside production. Production must set PUBLIC_URL.
    if (process.env.NODE_ENV !== 'production' && r.headers.host) seenBase = `${(r.headers['x-forwarded-proto'] as string) ?? 'http'}://${r.headers.host}`;
  };

  // ------------------------------------------------------------------ branding fan-out (debounced per organizer)
  const brandTimers = new Map<string, NodeJS.Timeout>();
  const onBrandingChange = (orgId: string) => {
    branding.invalidate(orgId);
    clearTimeout(brandTimers.get(orgId));
    const t = setTimeout(() => {
      brandTimers.delete(orgId);
      try {
        displays.pushOrg(orgId);
        for (const m of db.prepare("SELECT * FROM matches WHERE org_id = ? AND status IN ('live','scheduled','paused') AND visibility = 'public' LIMIT 300").all(orgId) as any[]) matches.broadcast(m);
        for (const tr of db.prepare("SELECT id FROM tournaments WHERE org_id = ? AND status != 'completed'").all(orgId) as any[]) tournaments.broadcast(tr.id);
      } catch (e) {
        console.error('branding refresh', e);
      }
    }, 120);
    t.unref?.();
    brandTimers.set(orgId, t);
  };

  const orders = new OrderService({ db, ctx, notify, registry, market, branding, docs, onBrandingChange, baseUrl });
  const deals = new Deals(db, ctx, notify, market, orders);

  // surfaces pick up sponsor branding through the services' extension points
  matches.publicExtensions.push((r) => branding.forMatch(r));
  tournaments.publicExtensions.push((t) => branding.forTournament(t));
  displays.brandingResolver = (d, s) => branding.forDisplay(d, s);

  // ------------------------------------------------------------------ platform admins from configuration
  const bootstrapAdmins = () => {
    const emails = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (emails.length) db.prepare(`UPDATE users SET platform_admin = 1 WHERE platform_admin = 0 AND email IN (${emails.map(() => '?').join(',')})`).run(...emails);
  };
  bootstrapAdmins();

  // ------------------------------------------------------------------ signed media URLs (private previews in <img> tags)
  const mediaSig = (assetId: string, exp: number) => createHmac('sha256', seed).update(`media:${assetId}:${exp}`).digest('base64url').slice(0, 32);
  const sign = <T>(obj: T): T => {
    const exp = Math.floor(Date.now() / 1000 / 3600) * 3600 + 7200; // stable for an hour → cacheable
    const walk = (v: any): any => {
      if (typeof v === 'string' && v.startsWith('/media/')) {
        const aid = v.slice(7).split('?')[0];
        return `${v}${v.includes('?') ? '&' : '?'}exp=${exp}&sig=${mediaSig(aid, exp)}`;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(obj);
  };

  // ------------------------------------------------------------------ limiters
  const k = dep.rateLimitScale;
  const agentLimiter = new RateLimiter(10 * k, (10 / 60) * k);
  const beaconLimiter = new RateLimiter(60 * k, 2 * k);
  const uploadLimiter = new RateLimiter(30 * k, (30 / 600) * k);

  // ------------------------------------------------------------------ route helpers
  const R = (method: string, pattern: string, guard: Guard, h: Handler, opts?: { maxBody?: number }) => route(method, pattern, guard, h, opts);
  const sp = (r: Req) => r.sponsor!.accountId;
  const actorOrg = (r: Req): Actor => ({ id: r.user!.id, kind: 'organizer' });
  const actorAdmin = (r: Req): Actor => ({ id: r.user!.id, kind: 'platform' });
  const amountToMinor = (v: any, currency: string) => {
    try {
      return toMinor(v, currency);
    } catch {
      throw new HttpError(400, 'Enter a valid amount', 'VALIDATION');
    }
  };

  // ================================================================== AUTH & IDENTITY (Phase 1)
  R('GET', '/api/auth/providers', 'public', () => ({
    google: PROVIDERS.google.clientId() ?? null, apple: PROVIDERS.apple.clientId() ?? null,
    emailDelivery: !!process.env.RESEND_API_KEY, smsDelivery: !!process.env.TWILIO_ACCOUNT_SID,
  }));
  R('POST', '/api/auth/sponsor-signup', 'public', (r) => {
    noteBase(r);
    const out = sponsors.signup(r.body ?? {});
    ctx.audit(null, out.userId, 'sponsor.signup', 'sponsor', out.account.id);
    return { token: out.token, account: out.account };
  });
  R('POST', '/api/auth/otp/send', 'public', async (r) => {
    const b = r.body ?? {};
    if (!['email', 'sms'].includes(b.channel)) throw new HttpError(400, 'channel must be email or sms', 'VALIDATION');
    if (!['login', 'verify'].includes(b.purpose ?? 'login')) throw new HttpError(400, 'Unknown purpose', 'VALIDATION');
    if ((b.purpose ?? 'login') === 'verify' && !r.user) throw new HttpError(401, 'Sign in required', 'UNAUTHORIZED');
    return sponsors.sendCode(b.channel, String(b.destination ?? ''), b.purpose ?? 'login');
  });
  R('POST', '/api/auth/otp/verify', 'public', (r) => {
    const b = r.body ?? {};
    if (!['email', 'sms'].includes(b.channel)) throw new HttpError(400, 'channel must be email or sms', 'VALIDATION');
    return sponsors.verifyCode(b.channel, String(b.destination ?? ''), String(b.code ?? ''), b.purpose === 'verify' ? 'verify' : 'login', r.user);
  });
  R('POST', '/api/auth/forgot', 'public', (r) => (noteBase(r), sponsors.forgotPassword(r.body?.email, baseUrl())));
  R('POST', '/api/auth/reset', 'public', (r) => sponsors.resetPassword(String(r.body?.token ?? ''), String(r.body?.password ?? '')));
  R('POST', '/api/auth/oauth/:provider', 'public', (r) => sponsors.oauth(r.params.provider, String(r.body?.idToken ?? '')));

  R('GET', '/api/sponsor/me', 'user', (r) => {
    const u = db.prepare('SELECT id, name, email, phone, email_verified, phone_verified, org_id, role, platform_admin FROM users WHERE id = ?').get(r.user!.id) as any;
    return sign({
      user: { id: u.id, name: u.name, email: u.email, phone: u.phone, emailVerified: !!u.email_verified, phoneVerified: !!u.phone_verified, organizer: !!u.org_id, organizerRole: u.org_id ? u.role : null, platformAdmin: !!u.platform_admin },
      memberships: sponsors.memberships(r.user!.id),
    });
  });
  R('POST', '/api/sponsors', 'user', (r) => {
    const a = sponsors.createAccount(r.user!, r.body ?? {});
    ctx.audit(null, r.user!.id, 'sponsor.create', 'sponsor', a.id);
    return a;
  });
  R('GET', '/api/sponsors', 'public', (r) => sponsors.publicDirectory(r.query.get('q')?.slice(0, 60) ?? undefined).map(sign));
  R('GET', '/api/sponsors/:id', 'public', (r) => {
    // members see their full profile; everyone else sees the public profile (if published)
    if (r.user) {
      const m = db.prepare('SELECT a.* FROM sponsor_members m JOIN sponsor_accounts a ON a.id = m.sponsor_id WHERE m.user_id = ? AND (a.id = ? OR a.slug = ?)').get(r.user.id, r.params.id, r.params.id) as any;
      if (m) return sign({ ...sponsors.view(m), member: true });
    }
    const a = db.prepare('SELECT slug FROM sponsor_accounts WHERE id = ? OR slug = ?').get(r.params.id, r.params.id) as any;
    if (!a) throw new HttpError(404, 'Sponsor not found', 'NOT_FOUND');
    return sponsors.publicProfile(a.slug);
  });
  R('GET', '/api/sponsor/account', 'sp:view', (r) => sign({ ...sponsors.view(sponsors.account(sp(r))), role: r.sponsor!.role }));
  R('PATCH', '/api/sponsor/account', 'sp:profile', (r) => {
    const v = sponsors.updateProfile(sp(r), r.body ?? {});
    ctx.audit(null, r.user!.id, 'sponsor.profile_update', 'sponsor', sp(r));
    return sign(v);
  });
  R('GET', '/api/sponsor/billing', 'sp:finance', (r) => {
    const b = P<any>(sponsors.account(sp(r)).billing, {});
    return { ...b, providerCustomers: Object.fromEntries(Object.entries(b.providerCustomers ?? {}).map(([k, v]) => [k, mask(String(v))])) };
  });
  R('PUT', '/api/sponsor/billing', 'sp:finance', (r) => {
    const out = sponsors.updateBilling(sp(r), r.body ?? {});
    ctx.audit(null, r.user!.id, 'sponsor.billing_update', 'sponsor', sp(r));
    return { ...out, providerCustomers: Object.fromEntries(Object.entries(out.providerCustomers ?? {}).map(([k, v]) => [k, mask(String(v))])) };
  });
  R('GET', '/api/sponsor/invoices', 'sp:finance', (r) =>
    (db.prepare(`SELECT i.number, i.kind, i.total_minor, i.currency, i.issued_at, o.id AS order_id, o.number AS order_number,
      (SELECT d.id FROM sp_documents d WHERE d.order_id = o.id AND d.kind = i.kind ORDER BY ABS(julianday(d.created_at) - julianday(i.issued_at)) LIMIT 1) AS doc_id
      FROM sp_invoices i JOIN sp_orders o ON o.id = i.order_id WHERE i.sponsor_id = ? ORDER BY i.issued_at DESC LIMIT 500`).all(sp(r)) as any[]).map((i) => ({
      number: i.number, kind: i.kind, amount: format(i.total_minor, i.currency), amountMinor: i.total_minor, currency: i.currency, issuedAt: i.issued_at, orderId: i.order_id, orderNumber: i.order_number, documentId: i.doc_id,
    })));
  R('GET', '/api/sponsor/team', 'sp:view', (r) => ({ ...sponsors.team(sp(r)), roles: SPONSOR_ROLES, you: { id: r.user!.id, role: r.sponsor!.role } }));
  R('POST', '/api/sponsor/team/invite', 'sp:team', async (r) => {
    noteBase(r);
    const out = await sponsors.invite(sp(r), r.user!, r.sponsor!.role, String(r.body?.email ?? ''), String(r.body?.role ?? 'viewer'), baseUrl());
    ctx.audit(null, r.user!.id, 'sponsor.invite', 'sponsor', sp(r), { email: r.body?.email, role: r.body?.role });
    return out;
  });
  R('PATCH', '/api/sponsor/team/:userId', 'sp:team', (r) => (sponsors.setRole(sp(r), r.sponsor!.role, r.params.userId, String(r.body?.role ?? '')), ctx.audit(null, r.user!.id, 'sponsor.role', 'user', r.params.userId, { role: r.body?.role }), { ok: true }));
  R('DELETE', '/api/sponsor/team/:userId', 'sp:team', (r) => (sponsors.removeMember(sp(r), r.sponsor!.role, r.params.userId), ctx.audit(null, r.user!.id, 'sponsor.remove_member', 'user', r.params.userId), { ok: true }));
  R('POST', '/api/sponsor/invites/accept', 'user', (r) => sponsors.acceptInvite(r.user!, String(r.body?.token ?? '')));

  // assets
  R('GET', '/api/sponsor/assets', 'sp:view', (r) => sign({ assets: assets.list(sp(r)), rules: Object.fromEntries(Object.entries(ASSET_RULES).map(([k, v]) => [k, { ...v }])) }));
  R('POST', '/api/sponsor/assets', 'sp:assets', async (r) => {
    if (!uploadLimiter.take(`up:${r.user!.id}`)) throw new HttpError(429, 'Too many uploads. Wait a few minutes.', 'RATE_LIMIT');
    const kind = r.query.get('kind') ?? r.body?.kind ?? '';
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${ASSET_KINDS.join(', ')}`, 'VALIDATION');
    const data = kind === 'ad_copy' ? Buffer.from(String(r.body?.text ?? ''), 'utf8') : r.rawBody;
    const a = await assets.upload(sp(r), r.user!.id, kind, data, r.query.get('name') ?? r.body?.name ?? undefined);
    ctx.audit(null, r.user!.id, 'sponsor.asset_upload', 'sponsor_asset', a.id, { kind, bytes: a.bytes, status: a.status });
    return sign(a);
  }, { maxBody: 26_000_000 });
  R('DELETE', '/api/sponsor/assets/:id', 'sp:assets', (r) => (assets.remove(sp(r), r.params.id), { ok: true }));

  R('GET', '/media/:id', 'public', (r) => {
    const aid = r.params.id;
    const exp = Number(r.query.get('exp') ?? 0);
    const signed = exp > Date.now() / 1000 && r.query.get('sig') === mediaSig(aid, exp);
    const publicOk = assets.canView(aid, null);
    if (!signed && !publicOk) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    const a = db.prepare('SELECT mime, kind FROM sponsor_assets WHERE id = ?').get(aid) as any;
    // the public only ever receives re-encoded renditions (or the validated MP4)
    let v = r.query.get('v');
    if (v && !['thumb', 'screen'].includes(v)) v = null;
    if (!signed && !v && a.mime !== 'video/mp4') v = 'screen';
    const file = assets.read(aid, v);
    if (!file) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    const headers: Record<string, string> = { 'cache-control': signed && !publicOk ? 'private, max-age=3600' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'cross-origin' };
    if (file.mime === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    return raw(file.mime, file.data, 200, headers);
  });

  // notifications (sponsor members and organizer staff)
  const myNotifications = (u: AuthUser) => {
    const spIds = (db.prepare('SELECT sponsor_id FROM sponsor_members WHERE user_id = ?').all(u.id) as any[]).map((x) => x.sponsor_id);
    const cond = ['user_id = ?'];
    const args: any[] = [u.id];
    if (spIds.length) (cond.push(`sponsor_id IN (${spIds.map(() => '?').join(',')})`), args.push(...spIds));
    if (u.orgId && can(u, 'sponsor.manage')) (cond.push('org_id = ?'), args.push(u.orgId));
    return { cond: cond.join(' OR '), args };
  };
  R('GET', '/api/notifications', 'user', (r) => {
    const { cond, args } = myNotifications(r.user!);
    const items = db.prepare(`SELECT id, event, title, body, link, read_at AS readAt, created_at AS at FROM notifications WHERE ${cond} ORDER BY created_at DESC LIMIT 50`).all(...args);
    const unread = (db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE (${cond}) AND read_at IS NULL`).get(...args) as any).n;
    return { unread, items };
  });
  R('POST', '/api/notifications/read', 'user', (r) => {
    const { cond, args } = myNotifications(r.user!);
    const ids: string[] = Array.isArray(r.body?.ids) ? r.body.ids.slice(0, 200).map(String) : [];
    if (ids.length) db.prepare(`UPDATE notifications SET read_at = ? WHERE (${cond}) AND id IN (${ids.map(() => '?').join(',')})`).run(now(), ...args, ...ids);
    else db.prepare(`UPDATE notifications SET read_at = ? WHERE (${cond}) AND read_at IS NULL`).run(now(), ...args);
    return { ok: true };
  });

  // ================================================================== MARKETPLACE (Phases 2–3)
  R('GET', '/api/sponsorship-meta', 'public', () => ({
    inventoryTypes: market.inventoryTypes(), templates: Object.entries(TIER_TEMPLATES).map(([k, t]) => ({ id: k, name: t.name, price: t.price, items: t.items })),
    sponsorCategories: SPONSOR_CATEGORIES, industries: INDUSTRIES, levels: LEVELS, saleModels: SALE_MODELS, ageGroups: AGE_GROUPS,
    sports: catalog().map((s) => ({ id: s.id, name: s.name })), currencies: Object.keys(CURRENCIES), assetKinds: ASSET_KINDS, orderStatuses: ORDER_STATUSES,
    sandbox: sandboxAllowed(),
  }));
  R('GET', '/api/sponsorship-opportunities', 'public', (r) => market.search(r.query));
  R('GET', '/api/sponsorship-opportunities/:id', 'public', (r) => market.detail(r.params.id, { orgId: r.user?.orgId || undefined, displayCurrency: r.query.get('currency') ?? undefined }));
  R('POST', '/api/sponsorship-opportunities', 'sponsor.manage', (r) => {
    const out = market.createOpportunity(r.user!, r.body ?? {});
    ctx.audit(r.user!.orgId, r.user!.id, 'sponsorship.opportunity_create', 'sp_opportunity', out.id);
    return out;
  });
  R('PATCH', '/api/sponsorship-opportunities/:id', 'sponsor.manage', (r) => {
    const out = market.updateOpportunity(r.user!, r.params.id, r.body ?? {});
    ctx.audit(r.user!.orgId, r.user!.id, 'sponsorship.opportunity_update', 'sp_opportunity', r.params.id, { status: r.body?.status });
    return out;
  });
  R('POST', '/api/sponsorship-opportunities/:id/packages', 'sponsor.manage', (r) => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM sp_packages WHERE opportunity_id = ?').get(r.params.id) as any).n;
    const pid = market.addPackage(r.user!, r.params.id, r.body ?? {}, n);
    return market.packageView(db.prepare('SELECT * FROM sp_packages WHERE id = ?').get(pid) as any);
  });
  R('PATCH', '/api/sponsorship-packages/:id', 'sponsor.manage', (r) => {
    const p = db.prepare('SELECT p.*, o.org_id, o.currency AS oc FROM sp_packages p JOIN sp_opportunities o ON o.id = p.opportunity_id WHERE p.id = ?').get(r.params.id) as any;
    if (!p || p.org_id !== r.user!.orgId) throw new HttpError(404, 'Package not found', 'NOT_FOUND');
    const b = r.body ?? {};
    const priceMinor = b.price != null ? amountToMinor(b.price, p.oc) : p.price_minor;
    const max = b.maxSponsors != null ? Number(b.maxSponsors) : p.max_sponsors;
    if (!Number.isInteger(max) || max < 1 || max > 1000) throw new HttpError(400, 'maxSponsors must be 1–1000', 'VALIDATION');
    if (max < p.sold) throw new HttpError(409, `${p.sold} slot(s) are already sold`, 'CONFLICT');
    db.prepare('UPDATE sp_packages SET name = ?, description = ?, price_minor = ?, max_sponsors = ?, duration_days = ?, active = ? WHERE id = ?').run(
      b.name ? String(b.name).slice(0, 80) : p.name, b.description ?? p.description, priceMinor, max, b.durationDays ?? p.duration_days, b.active === undefined ? p.active : b.active ? 1 : 0, p.id);
    ctx.audit(r.user!.orgId, r.user!.id, 'sponsorship.package_update', 'sp_package', p.id, { price: priceMinor, max, active: b.active });
    return market.packageView(db.prepare('SELECT * FROM sp_packages WHERE id = ?').get(p.id) as any);
  });
  R('GET', '/api/sponsorship-inventory', 'sponsor.manage', (r) => market.listInventory(r.user!.orgId));
  R('POST', '/api/sponsorship-inventory', 'sponsor.manage', (r) => market.createInventory(r.user!, r.body ?? {}));
  R('PATCH', '/api/sponsorship-inventory/:id', 'sponsor.manage', (r) => {
    const i = db.prepare('SELECT * FROM sp_inventory WHERE id = ? AND org_id = ?').get(r.params.id, r.user!.orgId) as any;
    if (!i) throw new HttpError(404, 'Inventory item not found', 'NOT_FOUND');
    const qty = r.body?.quantity != null ? Number(r.body.quantity) : i.quantity;
    if (!Number.isInteger(qty) || qty < market.inventorySold(i.id) || qty > 10000) throw new HttpError(400, `quantity must be between ${market.inventorySold(i.id)} (already sold) and 10000`, 'VALIDATION');
    db.prepare('UPDATE sp_inventory SET quantity = ?, active = ?, name = ? WHERE id = ?').run(qty, r.body?.active === undefined ? i.active : r.body.active ? 1 : 0, r.body?.name ?? i.name, i.id);
    return market.inventoryRow(i.id);
  });
  R('GET', '/api/org/sponsorship-opportunities', 'sponsor.manage', (r) => market.listOwn(r.user!.orgId));
  R('GET', '/api/org/sponsorship-opportunities/:id', 'sponsor.manage', (r) => market.detail(r.params.id, { orgId: r.user!.orgId }));

  // ================================================================== ORDERS & PAYMENTS (Phases 3–5)
  R('POST', '/api/sponsorship-orders/quote', 'public', (r) => {
    const q = orders.quote(String(r.body?.opportunityId ?? ''), String(r.body?.packageId ?? ''), { sponsorCountry: r.body?.country ?? null });
    return { currency: q.opp.currency, ...q.breakdown, display: q.display, holdMinutes: getPlatformSettings(db).holdMinutes };
  });
  R('POST', '/api/sponsorship-orders', 'sp:buy', (r) => sign(orders.createOrder(r.user!, sp(r), r.body ?? {})));
  R('GET', '/api/sponsorship-orders', 'sp:view', (r) => orders.list({ sponsorId: sp(r), status: r.query.get('status') }, 'sponsor'));
  R('GET', '/api/sponsorship-orders/:id', 'sp:view', (r) => sign({ ...orders.view(orders.forSponsor(sp(r), r.params.id), 'sponsor'), metrics: analytics.orderMetrics(orders.forSponsor(sp(r), r.params.id)) }));
  R('POST', '/api/sponsorship-orders/:id/pay', 'sp:pay', async (r) => (noteBase(r), sign(await orders.pay(r.user!, sp(r), r.params.id, r.body ?? {}, r.ip))));
  R('POST', '/api/sponsorship-orders/:id/confirm', 'sp:view', async (r) => sign(await orders.confirm(sp(r), r.params.id)));
  R('POST', '/api/sponsorship-orders/:id/cancel', 'sp:buy', async (r) => sign(await orders.cancelBySponsor(r.user!, sp(r), r.params.id, r.body?.reason)));
  R('PATCH', '/api/sponsorship-orders/:id', 'sp:renew', (r) => sign(orders.setAutoRenew(sp(r), r.params.id, !!r.body?.autoRenew)));
  R('GET', '/api/sponsorship-orders/:id/agreement', 'sp:view', (r) => {
    const o = orders.forSponsor(sp(r), r.params.id);
    const d = docs.latest(o.id, 'agreement');
    return { html: d.body_html, sha256: d.sha256, acceptedAt: d.accepted_at, documentId: d.id };
  });

  // Webhooks: signed by the provider; never require a session. Raw bytes are verified.
  const webhook: Handler = async (r) => {
    const provider = r.params.provider ?? PaymentRegistry.detect(r.headers as any);
    if (!provider) throw new HttpError(400, 'Unrecognised webhook', 'BAD_SIGNATURE');
    return orders.webhook(provider, r.params.orgId ?? null, r.rawBody, r.headers as any);
  };
  R('POST', '/api/payments/webhook', 'public', webhook);
  R('POST', '/api/payments/webhook/:provider', 'public', webhook);
  R('POST', '/api/payments/webhook/:provider/:orgId', 'public', webhook);

  // Sandbox hosted checkout (test mode only). The outcome reaches the order ONLY through a signed webhook.
  R('GET', '/api/pay/sandbox/:providerOrderId', 'public', (r) => {
    if (!sandboxAllowed()) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    const s = registry.sandbox.peek(r.params.providerOrderId);
    if (!s) throw new HttpError(404, 'Checkout not found', 'NOT_FOUND');
    const o = db.prepare('SELECT number, total_minor, currency FROM sp_orders WHERE id = ?').get(s.orderId) as any;
    return { orderNumber: o?.number, amount: format(s.amountMinor, s.currency), currency: s.currency, description: s.description, status: s.status, testMode: true, methods: registry.sandbox.supports.methods };
  });
  R('POST', '/api/pay/sandbox/:providerOrderId/complete', 'public', async (r) => {
    if (!sandboxAllowed()) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    const s = registry.sandbox.peek(r.params.providerOrderId);
    if (!s) throw new HttpError(404, 'Checkout not found', 'NOT_FOUND');
    if (s.status !== 'created') throw new HttpError(409, 'This test checkout is already completed', 'CONFLICT');
    const outcome = r.body?.outcome === 'failure' ? 'failure' : 'success';
    const method = registry.sandbox.supports.methods.includes(r.body?.method) ? r.body.method : 'upi';
    const ev = registry.sandbox.complete(r.params.providerOrderId, outcome, method);
    await orders.webhook('sandbox', null, Buffer.from(ev.body), ev.headers);
    return { ok: true, outcome, redirect: outcome === 'success' ? s.returnUrl : s.cancelUrl };
  });

  // sponsor actions on a sponsorship
  R('POST', '/api/sponsorships/:id/assets', 'sp:assets', (r) => sign(orders.replaceAssets(sp(r), r.params.id, r.body ?? {})));
  R('POST', '/api/sponsorships/:id/renew', 'sp:renew', (r) => sign(orders.renew(r.user!, sp(r), r.params.id, r.body ?? {})));

  // organizer actions
  const orgOrder = (r: Req) => orders.forOrg(r.user!.orgId, r.params.id);
  R('GET', '/api/org/sponsorships', 'sponsor.manage', (r) => orders.list({ orgId: r.user!.orgId, status: r.query.get('status') }, 'org'));
  R('GET', '/api/org/sponsorships/:id', 'sponsor.manage', (r) => {
    const o = orgOrder(r);
    const a = db.prepare('SELECT name, slug, email, phone, contact_person, website, industry, category FROM sponsor_accounts WHERE id = ?').get(o.sponsor_id) as any;
    return sign({ ...orders.view(o, 'org'), sponsorContact: a, metrics: analytics.orderMetrics(o) });
  });
  R('POST', '/api/sponsorships/:id/approve', 'sponsor.manage', async (r) => sign(await orders.approve(r.user!, r.params.id, r.body ?? {})));
  R('POST', '/api/sponsorships/:id/reject', 'sponsor.manage', async (r) => sign(await orders.reject(r.user!, r.params.id, String(r.body?.reason ?? 'Declined by organizer'))));
  R('POST', '/api/sponsorships/:id/review-assets', 'sponsor.manage', (r) => (orders.reviewAssets(r.user!, r.params.id, r.body?.assets ?? {}), sign(orders.view(orgOrder(r), 'org'))));
  R('POST', '/api/sponsorships/:id/pause', 'sponsor.manage', (r) => sign(orders.setPaused(actorOrg(r), orgOrder(r), true, r.body?.reason)));
  R('POST', '/api/sponsorships/:id/resume', 'sponsor.manage', (r) => sign(orders.setPaused(actorOrg(r), orgOrder(r), false)));
  R('POST', '/api/sponsorships/:id/cancel', 'sponsor.manage', async (r) => sign(await orders.cancelByOrganizer(actorOrg(r), orgOrder(r), r.body ?? {})));
  R('POST', '/api/sponsorships/:id/transfer', 'sponsor.manage', (r) => sign(orders.transfer(actorOrg(r), orgOrder(r), String(r.body?.toSponsor ?? ''), r.body?.note)));
  R('POST', '/api/sponsorships/:id/refund', 'sponsor.manage', async (r) => {
    const o = orgOrder(r);
    const reason = String(r.body?.reason ?? '').trim();
    if (reason.length < 3) throw new HttpError(400, 'Give a reason for the refund', 'VALIDATION');
    return sign(await orders.refund(actorOrg(r), o, { amountMinor: r.body?.amount != null && r.body.amount !== '' ? amountToMinor(r.body.amount, o.currency) : undefined, reason }));
  });
  R('PATCH', '/api/org/deliverables/:id', 'sponsor.manage', (r) => orders.markDeliverable(r.user!, r.params.id, r.body ?? {}));
  R('GET', '/api/org/sponsorship-dashboard', 'sponsor.manage', (r) => analytics.organizer(r.user!.orgId));
  R('GET', '/api/org/sponsorship-settings', 'org.manage', (r) => {
    noteBase(r);
    const s = getOrgSettings(db, r.user!.orgId);
    return {
      ...s, providerConfig: Object.fromEntries(Object.entries(s.providerConfig).map(([k, v]) => [k, k === 'environment' || k === 'keyId' || k === 'appId' ? v : mask(v)])),
      commission: `${s.commissionBps / 100}%`, platformFee: format(s.platformFeeMinor, 'INR'), providers: registry.status(), providerFields: PROVIDER_FIELDS,
      webhookUrl: `${baseUrl()}/api/payments/webhook/${s.provider}/${r.user!.orgId}`,
    };
  });
  R('PUT', '/api/org/sponsorship-settings', 'org.manage', (r) => {
    const b = r.body ?? {};
    if (b.provider && !['sandbox', ...Object.keys(PROVIDER_FIELDS)].includes(b.provider)) throw new HttpError(400, 'Unknown payment provider', 'VALIDATION');
    let providerConfig: Record<string, string> | undefined;
    if (b.providerConfig && b.provider && b.provider !== 'sandbox') {
      const fields = PROVIDER_FIELDS[b.provider];
      const cur = getOrgSettings(db, r.user!.orgId);
      providerConfig = {};
      for (const f of fields) {
        const v = b.providerConfig[f];
        // masked values coming back unchanged keep the stored secret
        const keep = typeof v === 'string' && v.startsWith('••••') && cur.provider === b.provider ? cur.providerConfig[f] : v;
        if (!keep) throw new HttpError(400, `${b.provider} needs ${fields.join(', ')}`, 'VALIDATION');
        providerConfig[f] = String(keep).trim();
      }
    }
    if (b.invoicePrefix && !/^[A-Z0-9-]{2,10}$/i.test(b.invoicePrefix)) throw new HttpError(400, 'Invoice prefix: 2–10 letters/digits', 'VALIDATION');
    saveOrgSettings(db, r.user!.orgId, { provider: b.provider, providerConfig, invoicePrefix: b.invoicePrefix?.toUpperCase(), gstin: b.gstin, legalName: b.legalName, address: b.address, state: b.state, marketplaceEnabled: b.marketplaceEnabled });
    ctx.audit(r.user!.orgId, r.user!.id, 'sponsorship.settings_update', 'organization', r.user!.orgId, { provider: b.provider, keysChanged: !!providerConfig });
    return { ok: true };
  });

  // documents (sponsor team, organizer staff, platform admins)
  const canSeeOrder = (u: AuthUser, o: any) =>
    !!u.platformAdmin || (u.orgId === o.org_id && can(u, 'sponsor.manage')) || !!db.prepare('SELECT 1 FROM sponsor_members WHERE sponsor_id = ? AND user_id = ?').get(o.sponsor_id, u.id);
  R('GET', '/api/sponsorships/:id/documents', 'user', (r) => {
    const o = orders.row(r.params.id);
    if (!canSeeOrder(r.user!, o)) throw new HttpError(404, 'Sponsorship not found', 'NOT_FOUND');
    return docs.list(o.id);
  });
  R('GET', '/api/sponsorships/:id/documents/:docId', 'user', async (r) => {
    const o = orders.row(r.params.id);
    if (!canSeeOrder(r.user!, o)) throw new HttpError(404, 'Sponsorship not found', 'NOT_FOUND');
    const d = docs.get(o.id, r.params.docId);
    if (!d) throw new HttpError(404, 'Document not found', 'NOT_FOUND');
    const name = `${d.kind}-${o.number}`.replace(/[^A-Za-z0-9-]/g, '_');
    if (r.query.get('format') === 'pdf' && d.model) return raw('application/pdf', await renderPdf(d.model), 200, { 'content-disposition': `attachment; filename="${name}.pdf"`, 'cache-control': 'private, no-store' });
    return raw('text/html; charset=utf-8', d.body_html, 200, { 'cache-control': 'private, no-store', 'x-document-sha256': d.sha256 });
  });

  // ================================================================== ANALYTICS & TRACKING (Phase 7)
  R('GET', '/api/sponsors/:id/analytics', 'user', (r) => {
    const acct = db.prepare('SELECT id FROM sponsor_accounts WHERE id = ? OR slug = ?').get(r.params.id, r.params.id) as any;
    if (!acct) throw new HttpError(404, 'Sponsor not found', 'NOT_FOUND');
    if (!r.user!.platformAdmin) sponsors.authorize(r.user!, 'analytics', acct.id);
    if (r.query.get('format') === 'csv') return raw('text/csv; charset=utf-8', analytics.csv(acct.id), 200, { 'content-disposition': 'attachment; filename="sponsorship-analytics.csv"' });
    return analytics.sponsor(acct.id, { orderId: r.query.get('order'), from: r.query.get('from'), to: r.query.get('to') });
  });
  R('GET', '/api/sponsor/dashboard', 'sp:view', (r) => {
    const id = sp(r);
    const list = orders.list({ sponsorId: id }, 'sponsor', 100);
    const a = analytics.sponsor(id);
    const actions: any[] = [];
    for (const o of list) {
      if (o.status === 'PENDING_PAYMENT' || o.status === 'DRAFT') actions.push({ kind: 'pay', orderId: o.id, text: `Complete payment for ${o.number} (${o.total})` });
      if (o.status === 'ASSET_REVIEW') actions.push({ kind: 'assets', orderId: o.id, text: `Creative for ${o.number} is being reviewed — check for change requests` });
    }
    const rejected = db.prepare("SELECT o.id, o.number, oa.role FROM sp_order_assets oa JOIN sp_orders o ON o.id = oa.order_id WHERE o.sponsor_id = ? AND oa.status = 'rejected' AND o.status NOT IN ('CANCELLED','REFUNDED','EXPIRED')").all(id) as any[];
    for (const x of rejected) actions.push({ kind: 'replace', orderId: x.id, text: `Replace the ${x.role.replace('_', ' ')} for ${x.number}` });
    return sign({ account: { ...sponsors.view(sponsors.account(id)), role: r.sponsor!.role }, orders: list, analytics: { totals: a.totals, spend: a.spend, matchesCovered: a.matchesCovered, series: a.series.slice(-30) }, actions, bids: deals.myBids(id) });
  });
  R('POST', '/api/sx/impressions', 'public', (r) => {
    if (!beaconLimiter.take(`b:${r.ip}`)) return { counted: 0 };
    return { counted: branding.recordImpressions({ placements: r.body?.placements, viewer: String(r.body?.viewer ?? ''), page: String(r.body?.page ?? '') }) };
  });
  R('GET', '/c/:placementId', 'public', (r) => {
    const url = branding.click(r.params.placementId, r.ip);
    if (!url) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    return raw('text/plain; charset=utf-8', `Redirecting to ${url}`, 302, { location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer-when-downgrade' });
  });
  R('GET', '/q/:code', 'public', (r) => {
    const url = branding.qrScan(r.params.code, { ip: r.ip, ua: String(r.headers['user-agent'] ?? ''), match: r.query.get('m'), tournament: r.query.get('t') });
    if (!url) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    return raw('text/plain; charset=utf-8', `Redirecting to ${url}`, 302, { location: url, 'cache-control': 'no-store' });
  });
  R('GET', '/api/sponsor/qr', 'sp:view', (r) =>
    (db.prepare('SELECT q.code, q.label, q.target_url, q.created_at, o.number, (SELECT COUNT(*) FROM sp_qr_scans s WHERE s.code = q.code) AS scans FROM sp_qr_codes q LEFT JOIN sp_orders o ON o.id = q.order_id WHERE q.sponsor_id = ? ORDER BY q.created_at DESC').all(sp(r)) as any[]).map((q) => ({
      code: q.code, label: q.label, order: q.number, target: q.target_url, scans: q.scans, url: `/q/${q.code}`, image: `/api/qr?data=${encodeURIComponent(`${baseUrl()}/q/${q.code}`)}`,
    })));

  // ================================================================== AI MATCHING (Phase 9)
  const recQuery = (r: Req): RecQuery => {
    const list = (k: string) => (r.query.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const cur = r.query.get('currency') ?? 'INR';
    let account: any = null;
    if (r.user) account = db.prepare('SELECT a.industry, a.city, a.country FROM sponsor_members m JOIN sponsor_accounts a ON a.id = m.sponsor_id WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1').get(r.user.id);
    return {
      budgetMinor: r.query.get('budget') ? amountToMinor(r.query.get('budget'), isCurrency(cur) ? cur : 'INR') : null, currency: isCurrency(cur) ? cur : 'INR',
      sports: list('sports'), cities: list('cities'), states: list('states'), country: r.query.get('country') ?? null, ageGroups: list('ages'), goals: list('goals') as any,
      levels: list('levels'), industry: r.query.get('industry') ?? account?.industry ?? null, limit: Number(r.query.get('limit') ?? 12),
    };
  };
  R('GET', '/api/sponsorships/recommendations', 'public', (r) => {
    const q = recQuery(r);
    return { query: q, recommendations: recommender.recommend(q), plan: q.budgetMinor ? recommender.plan(q) : null, engine: 'rules' };
  });
  R('POST', '/api/sponsorships/agent', 'public', async (r) => {
    if (!agentLimiter.take(`ai:${r.user?.id ?? r.ip}`)) throw new HttpError(429, 'Too many questions. Wait a minute.', 'RATE_LIMIT');
    const acct = r.user ? (db.prepare('SELECT a.industry, a.city, a.country FROM sponsor_members m JOIN sponsor_accounts a ON a.id = m.sponsor_id WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1').get(r.user.id) as any) : null;
    return recommender.agent(String(r.body?.message ?? ''), acct);
  });

  // ================================================================== AUCTIONS, RFP, NEGOTIATION (Phase 10)
  R('POST', '/api/sponsorship-packages/:id/bids', 'sp:buy', (r) => deals.bid(r.user!, sp(r), r.params.id, r.body?.maxAmount));
  R('GET', '/api/sponsor/bids', 'sp:view', (r) => deals.myBids(sp(r)));
  R('POST', '/api/sponsorship-threads', 'sp:buy', (r) => deals.startThread(r.user!, sp(r), r.body ?? {}));
  R('GET', '/api/sponsorship-threads', 'sp:view', (r) => deals.list({ sponsorId: sp(r) }));
  R('GET', '/api/sponsorship-threads/:id', 'sp:view', (r) => deals.thread(r.params.id, { sponsorId: sp(r) }));
  R('POST', '/api/sponsorship-threads/:id/messages', 'sp:buy', (r) => deals.reply(r.user!, r.params.id, 'sponsor', { sponsorId: sp(r) }, r.body ?? {}));
  R('POST', '/api/sponsorship-threads/:id/accept', 'sp:buy', (r) => sign(deals.accept(r.user!, r.params.id, 'sponsor', { sponsorId: sp(r) })));
  R('POST', '/api/sponsorship-threads/:id/decline', 'sp:buy', (r) => deals.decline(r.user!, r.params.id, 'sponsor', { sponsorId: sp(r) }, r.body?.reason));
  R('GET', '/api/org/sponsorship-threads', 'sponsor.manage', (r) => deals.list({ orgId: r.user!.orgId }));
  R('GET', '/api/org/sponsorship-threads/:id', 'sponsor.manage', (r) => deals.thread(r.params.id, { orgId: r.user!.orgId }));
  R('POST', '/api/org/sponsorship-threads/:id/messages', 'sponsor.manage', (r) => deals.reply(r.user!, r.params.id, 'organizer', { orgId: r.user!.orgId }, r.body ?? {}));
  R('POST', '/api/org/sponsorship-threads/:id/accept', 'sponsor.manage', (r) => sign(deals.accept(r.user!, r.params.id, 'organizer', { orgId: r.user!.orgId })));
  R('POST', '/api/org/sponsorship-threads/:id/decline', 'sponsor.manage', (r) => deals.decline(r.user!, r.params.id, 'organizer', { orgId: r.user!.orgId }, r.body?.reason));

  // ================================================================== PLATFORM ADMIN
  R('GET', '/api/admin/overview', 'platform', () => ({ ...analytics.platform(), providers: registry.status(), settlements: orders.settlementPreview() }));
  R('GET', '/api/admin/settings', 'platform', () => ({ settings: getPlatformSettings(db), defaults: DEFAULT_SETTINGS }));
  R('PATCH', '/api/admin/settings', 'platform', (r) => {
    const b = r.body ?? {};
    const patch: any = {};
    const int = (k: string, min: number, max: number) => {
      if (b[k] === undefined) return;
      const v = Number(b[k]);
      if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${k} must be an integer ${min}–${max}`, 'VALIDATION');
      patch[k] = v;
    };
    int('commissionBps', 0, 5000);
    int('platformFeeMinor', 0, 100_000_00);
    int('taxRateBps', 0, 5000);
    int('featuredFeeMinor', 0, 10_000_000_00);
    int('holdMinutes', 5, 1440);
    int('maxOrdersPerHour', 1, 1000);
    if (b.sponsorApproval !== undefined) {
      if (!['auto', 'manual'].includes(b.sponsorApproval)) throw new HttpError(400, 'sponsorApproval must be auto or manual', 'VALIDATION');
      patch.sponsorApproval = b.sponsorApproval;
    }
    if (b.defaultProvider !== undefined) {
      if (!['sandbox', 'razorpay', 'stripe', 'cashfree'].includes(b.defaultProvider)) throw new HttpError(400, 'Unknown provider', 'VALIDATION');
      patch.defaultProvider = b.defaultProvider;
    }
    if (b.prohibitedCategories !== undefined) patch.prohibitedCategories = (Array.isArray(b.prohibitedCategories) ? b.prohibitedCategories : String(b.prohibitedCategories).split(',')).map((x: any) => String(x).trim().toLowerCase()).filter(Boolean);
    if (b.renewalReminderDays !== undefined) patch.renewalReminderDays = (Array.isArray(b.renewalReminderDays) ? b.renewalReminderDays : String(b.renewalReminderDays).split(',')).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 120);
    if (b.fxRatesPerINR !== undefined) {
      const fx: Record<string, number> = {};
      for (const [c, v] of Object.entries(b.fxRatesPerINR ?? {})) if (isCurrency(c) && c !== 'INR' && Number(v) > 0) fx[c] = Number(v);
      patch.fxRatesPerINR = fx;
    }
    setPlatformSettings(db, patch);
    ctx.audit(null, r.user!.id, 'platform.settings_update', 'platform', 'settings', patch);
    return { settings: getPlatformSettings(db) };
  });
  R('GET', '/api/admin/sponsors', 'platform', (r) => {
    const st = r.query.get('status');
    return (db.prepare(`SELECT * FROM sponsor_accounts ${st ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 500`).all(...(st ? [st] : [])) as any[]).map((a) => ({
      ...sponsors.view(a), orders: (db.prepare('SELECT COUNT(*) AS n FROM sp_orders WHERE sponsor_id = ?').get(a.id) as any).n, members: (db.prepare('SELECT COUNT(*) AS n FROM sponsor_members WHERE sponsor_id = ?').get(a.id) as any).n,
    })).map(sign);
  });
  R('POST', '/api/admin/sponsors/:id/status', 'platform', (r) => {
    const st = String(r.body?.status ?? '');
    if (!['active', 'suspended', 'rejected', 'pending'].includes(st)) throw new HttpError(400, 'status must be active, suspended, rejected or pending', 'VALIDATION');
    const a = sponsors.account(r.params.id);
    db.prepare('UPDATE sponsor_accounts SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(st, r.body?.reason ?? null, now(), a.id);
    db.prepare('INSERT INTO moderation_log (subject_type, subject_id, action, reason, actor_id, at) VALUES (?,?,?,?,?,?)').run('sponsor', a.id, st, r.body?.reason ?? null, r.user!.id, now());
    ctx.audit(null, r.user!.id, 'platform.sponsor_status', 'sponsor', a.id, { status: st, reason: r.body?.reason });
    // suspended sponsors disappear from every screen at once
    for (const o of db.prepare("SELECT DISTINCT org_id FROM sp_orders WHERE sponsor_id = ? AND status = 'ACTIVE'").all(a.id) as any[]) onBrandingChange(o.org_id);
    void notify.event({ event: 'sponsor.status', sponsorId: a.id, title: `Account ${st}`, body: st === 'active' ? 'Your sponsor account is approved. You can now buy sponsorships.' : `Your sponsor account is ${st}${r.body?.reason ? `: ${r.body.reason}` : ''}.` });
    return { ok: true };
  });
  R('GET', '/api/admin/orgs', 'platform', () =>
    (db.prepare('SELECT id, name, slug, created_at FROM organizations ORDER BY name').all() as any[]).map((o) => {
      const s = getOrgSettings(db, o.id);
      return { ...o, commissionBps: s.commissionBps, platformFeeMinor: s.platformFeeMinor, provider: s.provider, marketplaceEnabled: s.marketplaceEnabled, opportunities: (db.prepare('SELECT COUNT(*) AS n FROM sp_opportunities WHERE org_id = ?').get(o.id) as any).n };
    }));
  R('PUT', '/api/admin/orgs/:id/sponsorship-settings', 'platform', (r) => {
    const b = r.body ?? {};
    if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(r.params.id)) throw new HttpError(404, 'Organizer not found', 'NOT_FOUND');
    const nul = (v: any, min: number, max: number) => {
      if (v === undefined) return undefined;
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Value must be ${min}–${max}`, 'VALIDATION');
      return n;
    };
    saveOrgSettings(db, r.params.id, { commissionBps: nul(b.commissionBps, 0, 5000), platformFeeMinor: nul(b.platformFeeMinor, 0, 100_000_00), marketplaceEnabled: b.marketplaceEnabled });
    ctx.audit(r.params.id, r.user!.id, 'platform.org_terms', 'organization', r.params.id, b);
    return { ok: true };
  });
  R('GET', '/api/admin/moderation', 'platform', () => ({
    flagged: (db.prepare("SELECT id FROM sponsor_assets WHERE status = 'flagged' ORDER BY created_at DESC LIMIT 100").all() as any[]).map((a) => sign({ ...assets.get(a.id), sponsor: (db.prepare('SELECT s.name FROM sponsor_assets x JOIN sponsor_accounts s ON s.id = x.sponsor_id WHERE x.id = ?').get(a.id) as any)?.name })),
    log: db.prepare('SELECT * FROM moderation_log ORDER BY id DESC LIMIT 100').all(),
  }));
  R('POST', '/api/admin/assets/:id/moderate', 'platform', (r) => {
    const action = r.body?.action === 'block' ? 'block' : r.body?.action === 'clear' ? 'clear' : null;
    if (!action) throw new HttpError(400, 'action must be block or clear', 'VALIDATION');
    assets.get(r.params.id);
    assets.moderate(r.params.id, r.user!.id, action, String(r.body?.reason ?? 'policy'), r.body?.note);
    for (const o of db.prepare("SELECT DISTINCT o.org_id FROM sp_order_assets oa JOIN sp_orders o ON o.id = oa.order_id WHERE oa.asset_id = ? AND o.status = 'ACTIVE'").all(r.params.id) as any[]) onBrandingChange(o.org_id);
    return { ok: true };
  });
  R('POST', '/api/admin/opportunities/:id/feature', 'platform', (r) => {
    const days = Number(r.body?.days ?? 0);
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, 'days must be 0–365', 'VALIDATION');
    const o = db.prepare('SELECT id, org_id FROM sp_opportunities WHERE id = ?').get(r.params.id) as any;
    if (!o) throw new HttpError(404, 'Opportunity not found', 'NOT_FOUND');
    db.prepare('UPDATE sp_opportunities SET featured_until = ? WHERE id = ?').run(days ? new Date(Date.now() + days * 864e5).toISOString() : null, o.id);
    ctx.audit(o.org_id, r.user!.id, 'platform.feature', 'sp_opportunity', o.id, { days, fee: getPlatformSettings(db).featuredFeeMinor });
    return { ok: true };
  });
  R('GET', '/api/admin/orders', 'platform', (r) => {
    const list = orders.list({ status: r.query.get('status') }, 'admin', 500);
    return r.query.get('risk') === '1' ? list.filter((o: any) => o.risk?.length) : list;
  });
  R('GET', '/api/admin/orders/:id', 'platform', (r) => sign({ ...orders.view(orders.row(r.params.id), 'admin'), metrics: analytics.orderMetrics(orders.row(r.params.id)) }));
  R('POST', '/api/admin/sponsorships/:id/refund', 'platform', async (r) => {
    const o = orders.row(r.params.id);
    return sign(await orders.refund(actorAdmin(r), o, { amountMinor: r.body?.amount != null && r.body.amount !== '' ? amountToMinor(r.body.amount, o.currency) : undefined, reason: String(r.body?.reason ?? 'Platform refund') }));
  });
  R('POST', '/api/admin/sponsorships/:id/pause', 'platform', (r) => sign(orders.setPaused(actorAdmin(r), orders.row(r.params.id), true, r.body?.reason ?? 'Paused by platform')));
  R('POST', '/api/admin/sponsorships/:id/resume', 'platform', (r) => sign(orders.setPaused(actorAdmin(r), orders.row(r.params.id), false)));
  R('POST', '/api/admin/sponsorships/:id/cancel', 'platform', async (r) => sign(await orders.cancelByOrganizer(actorAdmin(r), orders.row(r.params.id), r.body ?? {})));
  R('POST', '/api/admin/sponsorships/:id/transfer', 'platform', (r) => sign(orders.transfer(actorAdmin(r), orders.row(r.params.id), String(r.body?.toSponsor ?? ''), r.body?.note)));
  R('POST', '/api/admin/sponsorships/:id/clear-risk', 'platform', (r) => {
    const o = orders.row(r.params.id);
    db.prepare("UPDATE sp_orders SET risk = '[]', updated_at = ? WHERE id = ?").run(now(), o.id);
    ctx.audit(o.org_id, r.user!.id, 'platform.clear_risk', 'sp_order', o.id, { risk: P(o.risk, []), note: r.body?.note });
    return sign(orders.view(orders.row(o.id), 'admin'));
  });
  R('GET', '/api/admin/outbox', 'platform', (r) => db.prepare(`SELECT id, channel, destination, subject, substr(body, 1, 400) AS body, event, provider, status, error, created_at FROM notification_outbox ${r.query.get('status') ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 200`).all(...(r.query.get('status') ? [r.query.get('status')] : [])));
  R('GET', '/api/admin/webhooks', 'platform', () => ({
    events: db.prepare('SELECT provider, event_id, type, received_at, processed_at, result FROM sp_webhook_events ORDER BY received_at DESC LIMIT 200').all(),
    rejected: db.prepare("SELECT at, entity_id AS provider, data FROM audit_log WHERE action = 'payment.webhook_rejected' ORDER BY id DESC LIMIT 50").all(),
  }));
  R('GET', '/api/admin/settlements', 'platform', () => ({ due: orders.settlementPreview(), history: (db.prepare('SELECT s.*, o.name AS organizer FROM sp_settlements s JOIN organizations o ON o.id = s.org_id ORDER BY s.created_at DESC LIMIT 200').all() as any[]).map((s) => ({ ...s, amount: format(s.amount_minor, s.currency), order_ids: P(s.order_ids, []) })) }));
  R('POST', '/api/admin/settlements', 'platform', (r) => orders.createSettlement(actorAdmin(r), String(r.body?.orgId ?? ''), String(r.body?.currency ?? 'INR')));
  R('POST', '/api/admin/settlements/:id/paid', 'platform', (r) => orders.markSettlementPaid(actorAdmin(r), r.params.id, String(r.body?.reference ?? '')));
  R('POST', '/api/admin/jobs/run', 'platform', async () => ({ ...(await runJobs()) }));
  R('GET', '/api/admin/audit', 'platform', (r) => db.prepare(`SELECT * FROM audit_log ${r.query.get('prefix') ? 'WHERE action LIKE ?' : ''} ORDER BY id DESC LIMIT 300`).all(...(r.query.get('prefix') ? [`${r.query.get('prefix')}%`] : [])));

  // ------------------------------------------------------------------ jobs
  const runJobs = async (at = new Date()) => {
    bootstrapAdmins();
    const auctions = deals.closeAuctions(at);
    const out = await orders.runJobs(at);
    return { ...out, auctionsClosed: auctions };
  };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runJobs();
    } catch (e) {
      console.error('sponsorship jobs', e);
    } finally {
      running = false;
    }
  }, Number(process.env.SPONSORSHIP_JOB_INTERVAL_MS ?? 60_000));
  timer.unref?.();

  return {
    authorize: (user, perm, requested) => sponsors.authorize(user, perm, requested),
    recordDisplayExposure: (deviceId, shown) => {
      try {
        branding.recordDisplayExposure(deviceId, shown);
      } catch (e) {
        console.error('exposure', e);
      }
    },
    runJobs,
    dispose() {
      clearInterval(timer);
      for (const t of brandTimers.values()) clearTimeout(t);
    },
    sponsors, orders, market, branding, registry, assets, deals, analytics, recommender, notify,
  };
}

