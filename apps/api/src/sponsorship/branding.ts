/**
 * Automatic branding + exposure measurement.
 *
 * Activation turns an order's inventory into PLACEMENTS (surface × scope). Every public
 * surface — TV screens, live score pages, tournament pages, broadcast overlays — resolves
 * the placements that apply to what it is showing, so a sponsorship goes live everywhere
 * the moment it is activated and disappears the moment it is paused, expired or refunded.
 *
 * Exposure is measured server-side from what was actually served:
 *   • screens: heartbeat every ~15 s reports the placement ids rendered; only ids the server
 *     itself assigned to that screen are credited (a client can't invent exposure)
 *   • pages:   a beacon from live/tournament pages, deduplicated per anonymous viewer
 *   • clicks and QR scans: server-side redirects
 */
import { createHash } from 'node:crypto';
import { id, publicCode } from '../context.ts';
import type { DB } from '../db.ts';
import { J, P, now } from '../db.ts';
import type { MatchService } from '../services/matches.ts';
import { buildFacts, playerOfTheMatch } from '../services/insights.ts';
import { inventoryType, type Surface } from './catalog.ts';

export const today = () => new Date().toISOString().slice(0, 10);
const URL_OK = /^https?:\/\/[^\s]+$/i;

export interface PlacementView {
  id: string;
  surface: Surface;
  sponsor: string;
  slug: string | null;
  tier: string | null;
  logo: string | null;
  logoDark: string | null;
  banner: string | null;
  video: string | null;
  copy: string | null;
  link: string | null;
  qr: string | null;
  weight: number;
}

/** Surfaces a heartbeat may credit without an explicit "shown" list (always on screen). */
const PERSISTENT: Surface[] = ['tv_logo', 'overlay', 'title'];
/** Surfaces counted as a "play" each time they are shown (interstitials). */
const PLAYS: Surface[] = ['tv_fullscreen', 'tv_match_sponsor', 'tv_potm', 'tv_timeout', 'tv_break'];
/** Surfaces that live on public pages (counted by the impression beacon). */
const PAGE_SURFACES: Surface[] = ['live_page', 'tournament_page', 'web_banner', 'title', 'qr', 'overlay'];

interface Scope {
  orgId: string;
  tournamentIds?: string[];
  venueIds?: string[];
  matchIds?: string[];
}

export class Branding {
  private cache = new Map<string, { at: number; value: PlacementView[] }>();
  private devices = new Map<string, { orgId: string; ids: Map<string, { orderId: string; surface: Surface }>; audience: number; lastHb: number }>();
  private potmCache = new Map<string, string | null>();
  private beaconSeen = new Map<string, number>();
  private clickSeen = new Map<string, number>();

  constructor(private db: DB, private matches: MatchService) {}

  // ------------------------------------------------------------------ activation
  /** Create placements, deliverables and a tracked QR code for an order. Idempotent. */
  activate(orderId: string) {
    const o = this.db.prepare('SELECT * FROM sp_orders WHERE id = ?').get(orderId) as any;
    const opp = this.db.prepare('SELECT * FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
    const existing = (this.db.prepare('SELECT COUNT(*) AS n FROM sp_placements WHERE order_id = ?').get(orderId) as any).n;
    if (existing) {
      this.db.prepare('UPDATE sp_placements SET active = 1, starts_on = ?, ends_on = ? WHERE order_id = ?').run(o.starts_on, o.ends_on, orderId);
    } else {
      const items = this.db.prepare('SELECT * FROM sp_order_items WHERE order_id = ?').all(orderId) as any[];
      const seen = new Set<string>();
      const ins = this.db.prepare('INSERT INTO sp_placements (id, order_id, org_id, sponsor_id, surface, scope_type, scope_id, weight, options, starts_on, ends_on, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)');
      const del = this.db.prepare('INSERT INTO sp_deliverables (id, order_id, type, label, status) VALUES (?,?,?,?,?)');
      for (const it of items) {
        const t = inventoryType(it.type);
        if (!t) continue;
        let scopeType = it.scope_type as string;
        let scopeId = it.scope_id ?? (scopeType === 'tournament' ? opp.tournament_id : scopeType === 'venue' ? opp.venue_id : scopeType === 'match' ? opp.match_id : null);
        // An unscoped tournament/venue/match item on an opportunity without that entity applies organizer-wide.
        if (scopeType !== 'org' && !scopeId) (scopeType = 'org'), (scopeId = null);
        for (const surface of t.surfaces) {
          const key = `${surface}|${scopeType}|${scopeId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ins.run(id(), orderId, o.org_id, o.sponsor_id, surface, scopeType, scopeId, (t.weight ?? 1) * Math.max(1, it.quantity), J({ type: it.type }), o.starts_on, o.ends_on, now());
        }
        if (t.deliverable) {
          const already = (this.db.prepare('SELECT COUNT(*) AS n FROM sp_deliverables WHERE order_id = ? AND type = ?').get(orderId, it.type) as any).n;
          for (let q = already + 1; q <= it.quantity; q++) del.run(id(), orderId, it.type, it.quantity > 1 ? `${t.label} (${q} of ${it.quantity})` : t.label, 'pending');
        }
      }
    }
    this.ensureQr(o);
    this.invalidate(o.org_id);
    return {
      placements: this.db.prepare('SELECT surface, scope_type, scope_id FROM sp_placements WHERE order_id = ?').all(orderId) as any[],
      deliverables: (this.db.prepare('SELECT label FROM sp_deliverables WHERE order_id = ?').all(orderId) as any[]).map((d) => d.label),
    };
  }

  setActive(orderId: string, active: boolean) {
    const o = this.db.prepare('SELECT org_id FROM sp_orders WHERE id = ?').get(orderId) as any;
    this.db.prepare('UPDATE sp_placements SET active = ? WHERE order_id = ?').run(active ? 1 : 0, orderId);
    if (o) this.invalidate(o.org_id);
  }

  ensureQr(o: any) {
    const has = this.db.prepare('SELECT code FROM sp_qr_codes WHERE order_id = ?').get(o.id) as any;
    if (has) return has.code;
    const a = this.db.prepare('SELECT name, slug, website FROM sponsor_accounts WHERE id = ?').get(o.sponsor_id) as any;
    const target = o.click_url ?? a?.website ?? `/sponsor/${a?.slug}`;
    let code = publicCode(8);
    while (this.db.prepare('SELECT 1 FROM sp_qr_codes WHERE code = ?').get(code)) code = publicCode(8);
    this.db.prepare('INSERT INTO sp_qr_codes (code, sponsor_id, order_id, label, target_url, created_at) VALUES (?,?,?,?,?,?)').run(code, o.sponsor_id, o.id, a?.name ?? null, target, now());
    return code;
  }

  /** Keep the QR destination in step with the sponsor's click-through URL. */
  updateTarget(orderId: string, url: string) {
    this.db.prepare('UPDATE sp_qr_codes SET target_url = ? WHERE order_id = ?').run(url, orderId);
  }

  invalidate(orgId: string) {
    for (const k of this.cache.keys()) if (k.startsWith(orgId + '|')) this.cache.delete(k);
  }

  // ------------------------------------------------------------------ resolution
  resolve(scope: Scope): PlacementView[] {
    const day = today();
    const t = [...new Set(scope.tournamentIds ?? [])].filter(Boolean).sort();
    const v = [...new Set(scope.venueIds ?? [])].filter(Boolean).sort();
    const m = [...new Set(scope.matchIds ?? [])].filter(Boolean).sort();
    const key = `${scope.orgId}|${day}|${t.join(',')}|${v.join(',')}|${m.join(',')}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;

    const cond = ["p.scope_type = 'org'"];
    const args: any[] = [scope.orgId, day, day];
    const inList = (type: string, ids: string[]) => {
      if (!ids.length) return;
      cond.push(`(p.scope_type = '${type}' AND p.scope_id IN (${ids.map(() => '?').join(',')}))`);
      args.push(...ids);
    };
    inList('tournament', t);
    inList('venue', v);
    inList('match', m);
    const rows = this.db.prepare(`SELECT p.*, o.click_url, a.name AS sponsor_name, a.slug, a.website, pk.tier
      FROM sp_placements p JOIN sp_orders o ON o.id = p.order_id JOIN sponsor_accounts a ON a.id = o.sponsor_id LEFT JOIN sp_packages pk ON pk.id = o.package_id
      WHERE p.org_id = ? AND p.active = 1 AND o.status = 'ACTIVE' AND a.status = 'active'
        AND (p.starts_on IS NULL OR p.starts_on <= ?) AND (p.ends_on IS NULL OR p.ends_on >= ?) AND (${cond.join(' OR ')})
      ORDER BY p.weight DESC, p.created_at`).all(...args) as any[];

    const orderIds = [...new Set(rows.map((r) => r.order_id))];
    const assets = new Map<string, Record<string, any>>();
    if (orderIds.length) {
      const ar = this.db.prepare(`SELECT oa.order_id, oa.role, s.id, s.kind, s.text FROM sp_order_assets oa JOIN sponsor_assets s ON s.id = oa.asset_id
        WHERE oa.order_id IN (${orderIds.map(() => '?').join(',')}) AND oa.status = 'approved' AND s.status NOT IN ('blocked','deleted')`).all(...orderIds) as any[];
      for (const a of ar) {
        const rec = assets.get(a.order_id) ?? {};
        rec[a.role] = a;
        assets.set(a.order_id, rec);
      }
    }
    const qr = new Map<string, string>();
    if (orderIds.length) for (const q of this.db.prepare(`SELECT code, order_id FROM sp_qr_codes WHERE order_id IN (${orderIds.map(() => '?').join(',')})`).all(...orderIds) as any[]) qr.set(q.order_id, q.code);

    const img = (a: any) => (a ? `/media/${a.id}?v=screen` : null);
    const out: PlacementView[] = rows.map((r) => {
      const a = assets.get(r.order_id) ?? {};
      const logo = img(a.logo) ?? img(a.logo_dark);
      return {
        id: r.id, surface: r.surface, sponsor: r.sponsor_name, slug: r.slug, tier: r.tier, weight: r.weight,
        logo, logoDark: img(a.logo_dark) ?? logo, banner: img(a.banner), video: a.video ? `/media/${a.video.id}` : null, copy: a.copy?.text ?? null,
        link: r.click_url || r.website ? `/c/${r.id}` : null, qr: qr.has(r.order_id) ? `/q/${qr.get(r.order_id)}` : null,
      };
    });
    // Manually-added sponsors from the console (pre-marketplace) keep showing in rotation and on pages.
    const legacy = this.db.prepare(`SELECT * FROM sponsors WHERE org_id = ? AND (tournament_id IS NULL ${t.length ? `OR tournament_id IN (${t.map(() => '?').join(',')})` : ''}) ORDER BY tier, name`).all(scope.orgId, ...t) as any[];
    for (const l of legacy) {
      for (const surface of ['tv_rotation', 'tournament_page', 'live_page'] as Surface[]) {
        out.push({ id: `legacy:${l.id}:${surface}`, surface, sponsor: l.name, slug: null, tier: l.tier, weight: 1, logo: l.logo_url, logoDark: l.logo_url, banner: null, video: null, copy: null, link: l.url && URL_OK.test(l.url) ? l.url : null, qr: null });
      }
    }
    this.cache.set(key, { at: Date.now(), value: out });
    if (this.cache.size > 5000) this.cache.clear();
    return out;
  }

  /** Group placements by surface into the payload screens and pages render. */
  view(list: PlacementView[]) {
    const by = (s: Surface) => list.filter((p) => p.surface === s);
    const slim = (p: PlacementView | undefined) => p && Object.fromEntries(Object.entries(p).filter(([k, v]) => v != null && k !== 'surface' && k !== 'weight'));
    const many = (s: Surface, max = 24) => by(s).slice(0, max).map(slim);
    const v: Record<string, any> = {
      title: slim(by('title')[0]) ?? null,
      logos: many('tv_logo', 3),
      rotation: many('tv_rotation'),
      fullscreen: many('tv_fullscreen'),
      matchSponsor: slim(by('tv_match_sponsor')[0]) ?? null,
      potm: slim(by('tv_potm')[0]) ?? null,
      timeout: slim(by('tv_timeout')[0]) ?? null,
      break: slim(by('tv_break')[0]) ?? null,
      live: many('live_page', 12),
      wall: many('tournament_page', 48),
      overlay: many('overlay', 4),
      qr: many('qr', 4),
      banners: many('web_banner', 6),
    };
    const any = Object.values(v).some((x) => (Array.isArray(x) ? x.length : !!x));
    return any ? v : null;
  }

  // ------------------------------------------------------------------ per-surface resolvers
  forMatch(r: any) {
    const list = this.resolve({ orgId: r.org_id, tournamentIds: r.tournament_id ? [r.tournament_id] : [], venueIds: r.venue_id ? [r.venue_id] : [], matchIds: [r.id] });
    const view = this.view(list);
    if (!view) return { sponsorship: null };
    return { sponsorship: { ...view, moment: this.moment(r), potmPlayer: view.potm && r.status === 'completed' ? this.potm(r) : null } };
  }

  forTournament(t: any) {
    const venues = (this.db.prepare('SELECT DISTINCT venue_id FROM matches WHERE tournament_id = ? AND venue_id IS NOT NULL').all(t.id) as any[]).map((x) => x.venue_id);
    const list = this.resolve({ orgId: t.org_id, tournamentIds: [t.id], venueIds: [t.venue_id, ...venues].filter(Boolean) });
    return { sponsorship: this.view(list.filter((p) => ['title', 'tournament_page', 'web_banner', 'live_page', 'qr'].includes(p.surface))) };
  }

  forDisplay(d: any, s: { matchIds: string[]; tournamentIds: string[] }) {
    const a = P<any>(d.assignment, {});
    const tids = new Set(s.tournamentIds);
    const vids = new Set<string>([d.venue_id, a.venueId, ...(a.items ?? []).map((i: any) => i.venueId)].filter(Boolean));
    for (const mid of s.matchIds) {
      const m = this.matches.row(mid);
      if (!m || m.org_id !== d.org_id) continue;
      if (m.tournament_id) tids.add(m.tournament_id);
      if (m.venue_id) vids.add(m.venue_id);
    }
    const list = this.resolve({ orgId: d.org_id, tournamentIds: [...tids], venueIds: [...vids], matchIds: s.matchIds });
    // remember what this screen was told to show, so heartbeats can only credit these
    const ids = new Map<string, { orderId: string; surface: Surface }>();
    const orders = this.orderOfPlacements(list.filter((p) => !p.id.startsWith('legacy:')).map((p) => p.id));
    for (const p of list) if (orders.has(p.id)) ids.set(p.id, { orderId: orders.get(p.id)!, surface: p.surface });
    const prev = this.devices.get(d.id);
    this.devices.set(d.id, { orgId: d.org_id, ids, audience: Math.max(1, Number(d.audience_estimate ?? 50)), lastHb: prev?.lastHb ?? 0 });
    const view = this.view(list);
    const rotation = list.filter((p) => p.surface === 'tv_rotation');
    const seen = new Set<string>();
    const sponsorsCompat = rotation.filter((p) => !seen.has(p.sponsor) && seen.add(p.sponsor)).map((p) => ({ name: p.sponsor, logoUrl: p.logo, tier: p.tier ?? 'partner', placement: p.id }));
    return { view, sponsorsCompat };
  }

  private orderOfPlacements(ids: string[]) {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    for (const r of this.db.prepare(`SELECT id, order_id FROM sp_placements WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[]) out.set(r.id, r.order_id);
    return out;
  }

  /** What is happening in the match right now, for moment-based sponsor slots. */
  private moment(r: any): 'pre' | 'timeout' | 'break' | 'post' | null {
    if (r.status === 'scheduled') return 'pre';
    if (r.status === 'completed') return 'post';
    if (r.status !== 'live' && r.status !== 'paused') return null;
    const last = this.db.prepare('SELECT type, created_at FROM match_events WHERE match_id = ? ORDER BY seq DESC LIMIT 1').get(r.id) as any;
    if (last?.type === 'TIMEOUT' && Date.now() - Date.parse(last.created_at) < 120_000) return 'timeout';
    const phase = String(P<any>(r.display, {})?.phase ?? '');
    if (/BREAK|HALF.?TIME|INTERVAL|INNINGS BREAK/i.test(phase) || last?.type === 'PERIOD_END' || r.status === 'paused') return 'break';
    return null;
  }

  private potm(r: any): string | null {
    const key = `${r.id}:${r.version}`;
    if (this.potmCache.has(key)) return this.potmCache.get(key)!;
    let name: string | null = null;
    try {
      name = playerOfTheMatch(buildFacts(r, this.matches.aggregate(r.id), this.matches.meta(r)))?.name ?? null;
    } catch {
      name = null;
    }
    this.potmCache.set(key, name);
    if (this.potmCache.size > 2000) this.potmCache.clear();
    return name;
  }

  // ------------------------------------------------------------------ exposure
  private bump(orderId: string, metric: string, value: number, dim = '', day = today()) {
    if (!value) return;
    this.db.prepare('INSERT INTO sp_exposure_daily (order_id, day, metric, dim, value) VALUES (?,?,?,?,?) ON CONFLICT(order_id, day, metric, dim) DO UPDATE SET value = value + excluded.value').run(orderId, day, metric, dim, Math.round(value));
  }

  private unique(orderId: string, viewer: string, day = today()): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO sp_unique_viewers (order_id, day, viewer) VALUES (?,?,?)').run(orderId, day, viewer).changes) > 0;
  }

  /** Screen heartbeat (~15 s). Credits only placements the server assigned to this screen. */
  recordDisplayExposure(deviceId: string, shown: string[] | null) {
    const st = this.devices.get(deviceId);
    if (!st || !st.ids.size) return;
    const t = Date.now();
    if (t - st.lastHb < 10_000) return; // ignore heartbeat floods
    const elapsed = st.lastHb ? Math.min(30, Math.round((t - st.lastHb) / 1000)) : 15;
    st.lastHb = t;
    const credit = shown ? shown.filter((id) => st.ids.has(id)) : [...st.ids.keys()].filter((id) => PERSISTENT.includes(st.ids.get(id)!.surface));
    const day = today();
    const ordersSeen = new Set<string>();
    for (const pid of credit) {
      const { orderId, surface } = st.ids.get(pid)!;
      this.bump(orderId, 'tv_seconds', elapsed, surface, day);
      this.bump(orderId, 'tv_audience_seconds', elapsed * st.audience, '', day);
      if (PLAYS.includes(surface)) this.bump(orderId, 'tv_plays', 1, surface, day);
      ordersSeen.add(orderId);
    }
    for (const orderId of ordersSeen) {
      if (this.unique(orderId, `screen:${deviceId}`, day)) {
        this.bump(orderId, 'screens', 1, '', day);
        this.bump(orderId, 'venue_audience', st.audience, '', day);
      }
    }
  }

  forgetDevice(deviceId: string) {
    this.devices.delete(deviceId);
  }

  /** Impression beacon from public pages. Returns the number of placements credited. */
  recordImpressions(b: { placements: string[]; viewer: string; page: string }): number {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(b.viewer ?? ''))) return 0;
    const ids = [...new Set((Array.isArray(b.placements) ? b.placements : []).map(String))].filter((x) => !x.startsWith('legacy:')).slice(0, 30);
    if (!ids.length) return 0;
    const rows = this.db.prepare(`SELECT p.id, p.order_id, p.surface FROM sp_placements p JOIN sp_orders o ON o.id = p.order_id WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.active = 1 AND o.status = 'ACTIVE'`).all(...ids) as any[];
    const t = Date.now();
    const day = today();
    let n = 0;
    for (const r of rows) {
      if (!PAGE_SURFACES.includes(r.surface)) continue;
      const k = `${b.viewer}|${r.id}`;
      if (t - (this.beaconSeen.get(k) ?? 0) < 5 * 60_000) continue; // one impression per viewer per placement per 5 min
      this.beaconSeen.set(k, t);
      this.bump(r.order_id, 'live_impressions', 1, r.surface, day);
      if (this.unique(r.order_id, `v:${b.viewer}`, day)) this.bump(r.order_id, 'unique_viewers', 1, '', day);
      n++;
    }
    if (this.beaconSeen.size > 200_000) this.beaconSeen.clear();
    return n;
  }

  /** Click-through redirect target (only http/https; anything else falls back to the public profile). */
  click(placementId: string, ip: string): string | null {
    const r = this.db.prepare('SELECT p.order_id, o.click_url, a.website, a.slug FROM sp_placements p JOIN sp_orders o ON o.id = p.order_id JOIN sponsor_accounts a ON a.id = o.sponsor_id WHERE p.id = ?').get(placementId) as any;
    if (!r) return null;
    const k = `${ip}|${placementId}`;
    const t = Date.now();
    if (t - (this.clickSeen.get(k) ?? 0) > 30_000) this.bump(r.order_id, 'clicks', 1);
    this.clickSeen.set(k, t);
    if (this.clickSeen.size > 100_000) this.clickSeen.clear();
    const url = r.click_url ?? r.website;
    return url && URL_OK.test(url) ? url : `/sponsor/${r.slug}`;
  }

  /** QR scan: log with context and return the destination. */
  qrScan(code: string, ctx: { ip: string; ua: string; match?: string | null; tournament?: string | null }): string | null {
    const q = this.db.prepare('SELECT * FROM sp_qr_codes WHERE code = ?').get(code.toUpperCase()) as any;
    if (!q) return null;
    const day = today();
    const viewer = createHash('sha256').update(`${ctx.ip}|${ctx.ua}|${day}`).digest('hex').slice(0, 32);
    const m = ctx.match ? (this.db.prepare('SELECT id, tournament_id, venue_id FROM matches WHERE public_code = ?').get(ctx.match.toUpperCase()) as any) : null;
    const t = !m && ctx.tournament ? (this.db.prepare('SELECT id FROM tournaments WHERE public_code = ?').get(ctx.tournament.toUpperCase()) as any) : null;
    this.db.prepare('INSERT INTO sp_qr_scans (code, order_id, viewer, tournament_id, venue_id, match_id, at) VALUES (?,?,?,?,?,?,?)').run(q.code, q.order_id, viewer, m?.tournament_id ?? t?.id ?? null, m?.venue_id ?? null, m?.id ?? null, now());
    if (q.order_id) {
      this.bump(q.order_id, 'qr_scans', 1, '', day);
      if (this.unique(q.order_id, `qr:${viewer}`, day)) this.bump(q.order_id, 'qr_unique', 1, '', day);
    }
    return URL_OK.test(q.target_url) || /^\/(?![/\\])/.test(q.target_url) ? q.target_url : '/';
  }
}
