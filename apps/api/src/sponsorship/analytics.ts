/**
 * Sponsor ROI analytics and the organizer revenue dashboard.
 *
 * Every number here is derived from rows the platform wrote itself (exposure counters,
 * QR scans, clicks, ledger). Audience figures entered by organizers are shown separately
 * and labelled as estimates.
 *
 * Sponsor Exposure Score (0–100, logarithmic so it stays meaningful from a club match to a
 * national final):
 *   points = 0.5·page impressions + 2·unique online viewers + 0.02·screen audience-minutes
 *          + 0.1·in-venue audience + 10·clicks + 15·QR scans
 *   score  = min(100, round(20 · log10(1 + points / 10)))
 *   → 100 pts ≈ 21, 1 000 ≈ 40, 10 000 ≈ 60, 100 000 ≈ 80, 1 000 000 ≈ 100
 *
 * Estimated reach = unique online viewers + Σ (screen audience estimate per screen per day)
 *                 + unique QR scanners.
 */
import type { DB } from '../db.ts';
import { now } from '../db.ts';
import { today } from './branding.ts';
import type { Marketplace } from './marketplace.ts';
import { format } from './money.ts';

export const SCORE_WEIGHTS = { live_impressions: 0.5, unique_viewers: 2, audience_minutes: 0.02, venue_audience: 0.1, clicks: 10, qr_scans: 15 };

export function exposureScore(m: Record<string, number>) {
  const points =
    SCORE_WEIGHTS.live_impressions * (m.live_impressions ?? 0) +
    SCORE_WEIGHTS.unique_viewers * (m.unique_viewers ?? 0) +
    SCORE_WEIGHTS.audience_minutes * ((m.tv_audience_seconds ?? 0) / 60) +
    SCORE_WEIGHTS.venue_audience * (m.venue_audience ?? 0) +
    SCORE_WEIGHTS.clicks * (m.clicks ?? 0) +
    SCORE_WEIGHTS.qr_scans * (m.qr_scans ?? 0);
  return { points: Math.round(points), score: Math.min(100, Math.round(20 * Math.log10(1 + points / 10))) };
}

export const estimatedReach = (m: Record<string, number>) => (m.unique_viewers ?? 0) + (m.venue_audience ?? 0) + (m.qr_unique ?? 0);

const METRICS = ['tv_seconds', 'tv_audience_seconds', 'tv_plays', 'screens', 'venue_audience', 'live_impressions', 'unique_viewers', 'clicks', 'qr_scans', 'qr_unique'];

export class Analytics {
  constructor(private db: DB, private market: Marketplace) {}

  private totals(orderIds: string[], from?: string, to?: string): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(METRICS.map((m) => [m, 0]));
    if (!orderIds.length) return out;
    const rows = this.db.prepare(`SELECT metric, SUM(value) AS v FROM sp_exposure_daily WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ${from ? 'AND day >= ?' : ''} ${to ? 'AND day <= ?' : ''} GROUP BY metric`).all(...orderIds, ...([from, to].filter(Boolean) as string[])) as any[];
    for (const r of rows) out[r.metric] = r.v;
    return out;
  }

  /** Matches actually played within an order's scope and period (what the sponsor was attached to). */
  private matchesCovered(o: any) {
    const ps = this.db.prepare('SELECT DISTINCT scope_type, scope_id FROM sp_placements WHERE order_id = ?').all(o.id) as any[];
    if (!ps.length) return { matches: 0, tournaments: [] as string[], venues: [] as string[] };
    const cond: string[] = [];
    const args: any[] = [];
    for (const p of ps) {
      if (p.scope_type === 'org') cond.push('1=1');
      else if (p.scope_type === 'tournament') (cond.push('m.tournament_id = ?'), args.push(p.scope_id));
      else if (p.scope_type === 'venue') (cond.push('m.venue_id = ?'), args.push(p.scope_id));
      else if (p.scope_type === 'match') (cond.push('m.id = ?'), args.push(p.scope_id));
    }
    const end = (o.ends_on ?? today()) + 'T23:59:59Z';
    const rows = this.db.prepare(`SELECT m.id, t.name AS tournament, v.name AS venue FROM matches m LEFT JOIN tournaments t ON t.id = m.tournament_id LEFT JOIN venues v ON v.id = m.venue_id
      WHERE m.org_id = ? AND m.status IN ('live','completed') AND COALESCE(m.started_at, m.created_at) >= ? AND COALESCE(m.started_at, m.created_at) <= ? AND (${cond.join(' OR ')})`).all(o.org_id, (o.starts_on ?? '0000') + 'T00:00:00Z', end, ...args) as any[];
    return { matches: rows.length, tournaments: [...new Set(rows.map((r) => r.tournament).filter(Boolean))], venues: [...new Set(rows.map((r) => r.venue).filter(Boolean))] };
  }

  orderMetrics(o: any): Record<string, any> {
    const m = this.totals([o.id]);
    const { score, points } = exposureScore(m);
    const reach = estimatedReach(m);
    const covered = this.matchesCovered(o);
    return {
      ...m, tvHours: +(m.tv_seconds / 3600).toFixed(1), audienceMinutes: Math.round(m.tv_audience_seconds / 60), score, points, estimatedReach: reach,
      ctr: m.live_impressions ? +((m.clicks / m.live_impressions) * 100).toFixed(2) : 0,
      costPerThousandReachMinor: reach ? Math.round((o.subtotal_minor / reach) * 1000) : null,
      costPerThousandReach: reach ? format(Math.round((o.subtotal_minor / reach) * 1000), o.currency) : null,
      matchesCovered: covered.matches, tournaments: covered.tournaments, venues: covered.venues,
    };
  }

  sponsor(sponsorId: string, q: { orderId?: string | null; from?: string | null; to?: string | null } = {}) {
    const orders = (this.db.prepare(`SELECT * FROM sp_orders WHERE sponsor_id = ? AND status IN ('ACTIVE','PAUSED','EXPIRED','REFUNDED','CANCELLED','PAYMENT_RECEIVED','PENDING_APPROVAL','ASSET_REVIEW') ${q.orderId ? 'AND id = ?' : ''} ORDER BY starts_on DESC`).all(sponsorId, ...(q.orderId ? [q.orderId] : [])) as any[])
      .filter((o) => o.status !== 'CANCELLED' || this.db.prepare('SELECT 1 FROM sp_exposure_daily WHERE order_id = ? LIMIT 1').get(o.id));
    const ids = orders.map((o) => o.id);
    const from = q.from ?? undefined;
    const to = q.to ?? undefined;
    const totals = this.totals(ids, from, to);
    const { score, points } = exposureScore(totals);
    const spend: Record<string, number> = {};
    for (const o of orders) if (o.status !== 'CANCELLED') spend[o.currency] = (spend[o.currency] ?? 0) + o.total_minor;
    const daily = ids.length
      ? (this.db.prepare(`SELECT day, metric, SUM(value) AS v FROM sp_exposure_daily WHERE order_id IN (${ids.map(() => '?').join(',')}) ${from ? 'AND day >= ?' : ''} ${to ? 'AND day <= ?' : ''} GROUP BY day, metric ORDER BY day`).all(...ids, ...([from, to].filter(Boolean) as string[])) as any[])
      : [];
    const series = new Map<string, any>();
    for (const r of daily) {
      const d = series.get(r.day) ?? { day: r.day, impressions: 0, tvMinutes: 0, scans: 0, clicks: 0, viewers: 0 };
      if (r.metric === 'live_impressions') d.impressions += r.v;
      if (r.metric === 'tv_seconds') d.tvMinutes += Math.round(r.v / 60);
      if (r.metric === 'qr_scans') d.scans += r.v;
      if (r.metric === 'clicks') d.clicks += r.v;
      if (r.metric === 'unique_viewers') d.viewers += r.v;
      series.set(r.day, d);
    }
    const bySurface = ids.length
      ? (this.db.prepare(`SELECT dim AS surface, metric, SUM(value) AS v FROM sp_exposure_daily WHERE order_id IN (${ids.map(() => '?').join(',')}) AND dim != '' AND metric IN ('tv_seconds','live_impressions','tv_plays') GROUP BY dim, metric`).all(...ids) as any[])
      : [];
    const scans = ids.length
      ? (this.db.prepare(`SELECT COALESCE(t.name, 'Other') AS tournament, COUNT(*) AS n FROM sp_qr_scans s LEFT JOIN tournaments t ON t.id = s.tournament_id WHERE s.order_id IN (${ids.map(() => '?').join(',')}) GROUP BY 1 ORDER BY n DESC LIMIT 10`).all(...ids) as any[])
      : [];
    const perOrder = orders.map((o) => {
      const opp = this.db.prepare('SELECT title, sport, city, audience_estimate FROM sp_opportunities WHERE id = ?').get(o.opportunity_id) as any;
      const pkg = o.package_id ? (this.db.prepare('SELECT name FROM sp_packages WHERE id = ?').get(o.package_id) as any) : null;
      return { id: o.id, number: o.number, status: o.status, title: opp?.title, sport: opp?.sport, city: opp?.city, package: pkg?.name, startsOn: o.starts_on, endsOn: o.ends_on, spend: format(o.total_minor, o.currency), organizerAudienceEstimate: opp?.audience_estimate ?? 0, metrics: this.orderMetrics(o) };
    });
    const reach = estimatedReach(totals);
    return {
      generatedAt: now(),
      totals: { ...totals, tvHours: +(totals.tv_seconds / 3600).toFixed(1), audienceMinutes: Math.round(totals.tv_audience_seconds / 60), score, points, estimatedReach: reach, ctr: totals.live_impressions ? +((totals.clicks / totals.live_impressions) * 100).toFixed(2) : 0 },
      spend: Object.entries(spend).map(([c, v]) => ({ currency: c, amountMinor: v, amount: format(v, c) })),
      matchesCovered: perOrder.reduce((s, o) => s + o.metrics.matchesCovered, 0),
      cities: [...new Set(perOrder.map((o) => o.city).filter(Boolean))],
      sports: [...new Set(perOrder.map((o) => o.sport).filter(Boolean))],
      series: [...series.values()],
      bySurface,
      qrByTournament: scans,
      orders: perOrder,
      method: {
        score: 'min(100, round(20 × log10(1 + points ÷ 10))), points = 0.5×page impressions + 2×unique online viewers + 0.02×screen audience-minutes + 0.1×in-venue audience + 10×clicks + 15×QR scans',
        reach: 'unique online viewers + in-venue audience (screen audience estimate, once per screen per day) + unique QR scanners. In-venue audience uses the organizer’s per-screen estimate.',
        measured: 'Screens report every 15 s which placements they rendered; only placements the server assigned to that screen are counted. Page impressions are deduplicated per anonymous viewer per placement every 5 minutes.',
      },
    };
  }

  csv(sponsorId: string) {
    const a = this.sponsor(sponsorId);
    const head = ['order', 'title', 'package', 'status', 'starts_on', 'ends_on', 'spend', 'score', 'estimated_reach', 'page_impressions', 'unique_viewers', 'screen_hours', 'screens', 'clicks', 'qr_scans', 'matches_covered'];
    const esc = (v: any) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const lines = a.orders.map((o) => [o.number, o.title, o.package, o.status, o.startsOn, o.endsOn, o.spend, o.metrics.score, o.metrics.estimatedReach, o.metrics.live_impressions, o.metrics.unique_viewers, o.metrics.tvHours, o.metrics.screens, o.metrics.clicks, o.metrics.qr_scans, o.metrics.matchesCovered].map(esc).join(','));
    return [head.join(','), ...lines].join('\n') + '\n';
  }

  organizer(orgId: string) {
    const led = this.db.prepare('SELECT kind, currency, SUM(amount_minor) AS v FROM sp_ledger WHERE org_id = ? GROUP BY kind, currency').all(orgId) as any[];
    const cur = [...new Set(led.map((l) => l.currency))];
    const sum = (kind: string, c: string) => led.filter((l) => l.kind === kind && l.currency === c).reduce((s, l) => s + l.v, 0);
    const revenue = cur.map((c) => {
      const gross = sum('charge', c);
      const refunds = -(sum('refund', c) + sum('refund_unbooked', c));
      const earnings = sum('organizer_payable', c) + sum('organizer_collected', c) - sum('commission_receivable', c);
      const settled = (this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS v FROM sp_settlements WHERE org_id = ? AND currency = ? AND status = 'paid'").get(orgId, c) as any).v;
      const unsettled = (this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS v FROM sp_ledger WHERE org_id = ? AND currency = ? AND kind = 'organizer_payable' AND settlement_id IS NULL").get(orgId, c) as any).v;
      return { currency: c, grossMinor: gross, gross: format(gross, c), refundsMinor: refunds, refunds: format(refunds, c), earningsMinor: earnings, earnings: format(earnings, c), commission: format(sum('commission', c) + sum('platform_fee', c), c), paidOut: format(settled, c), awaitingPayout: format(unsettled, c) };
    });
    const status = Object.fromEntries((this.db.prepare('SELECT status, COUNT(*) AS n FROM sp_orders WHERE org_id = ? GROUP BY status').all(orgId) as any[]).map((r) => [r.status, r.n]));
    const pending = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_minor),0) AS v, currency FROM sp_orders WHERE org_id = ? AND ((status = 'PENDING_PAYMENT' AND hold_expires_at > ?) OR status = 'DRAFT') GROUP BY currency").all(orgId, now()) as any[];
    const activeSponsors = (this.db.prepare("SELECT COUNT(DISTINCT sponsor_id) AS n FROM sp_orders WHERE org_id = ? AND status = 'ACTIVE'").get(orgId) as any).n;
    const inv = this.market.listInventory(orgId);
    const units = inv.reduce((s, i) => s + i.quantity, 0);
    const sold = inv.reduce((s, i) => s + Math.min(i.quantity, i.sold), 0);
    const top = (this.db.prepare(`SELECT a.name, a.slug, o.currency, SUM(o.total_minor) AS v, COUNT(*) AS n FROM sp_orders o JOIN sponsor_accounts a ON a.id = o.sponsor_id
      WHERE o.org_id = ? AND o.status IN ('ACTIVE','PAUSED','EXPIRED','PAYMENT_RECEIVED','PENDING_APPROVAL','ASSET_REVIEW') GROUP BY o.sponsor_id, o.currency ORDER BY v DESC LIMIT 5`).all(orgId) as any[]).map((t) => ({ name: t.name, slug: t.slug, spend: format(t.v, t.currency), orders: t.n }));
    const threads = this.db.prepare("SELECT t.id, t.kind, (SELECT author_side FROM sp_messages WHERE thread_id = t.id AND offer_minor IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_offer FROM sp_threads t WHERE t.org_id = ? AND t.status = 'open'").all(orgId) as any[];
    const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const pipeline = [
      { stage: 'Enquiry', count: threads.filter((t) => !t.last_offer).length },
      { stage: 'Proposal Sent', count: threads.filter((t) => t.last_offer === 'organizer').length },
      { stage: 'Negotiation', count: threads.filter((t) => t.last_offer === 'sponsor').length },
      { stage: 'Payment Pending', count: pending.reduce((s, p) => s + p.n, 0) },
      { stage: 'Paid', count: (status.PAYMENT_RECEIVED ?? 0) + (status.PENDING_APPROVAL ?? 0) + (status.ASSET_REVIEW ?? 0) },
      { stage: 'Active', count: status.ACTIVE ?? 0 },
      { stage: 'Expiring', count: (this.db.prepare("SELECT COUNT(*) AS n FROM sp_orders WHERE org_id = ? AND status = 'ACTIVE' AND ends_on <= ?").get(orgId, in30) as any).n },
      { stage: 'Renewed', count: (this.db.prepare("SELECT COUNT(*) AS n FROM sp_orders WHERE org_id = ? AND renewal_of IS NOT NULL AND status IN ('PAYMENT_RECEIVED','PENDING_APPROVAL','ASSET_REVIEW','ACTIVE','PAUSED','EXPIRED')").get(orgId) as any).n },
    ];
    const monthly = (this.db.prepare("SELECT substr(at, 1, 7) AS month, currency, SUM(amount_minor) AS v FROM sp_ledger WHERE org_id = ? AND kind IN ('charge','refund','refund_unbooked') GROUP BY month, currency ORDER BY month DESC LIMIT 24").all(orgId) as any[]).reverse();
    const orderIds = (this.db.prepare("SELECT id FROM sp_orders WHERE org_id = ? AND status IN ('ACTIVE','PAUSED','EXPIRED')").all(orgId) as any[]).map((r) => r.id);
    const exposure = this.totals(orderIds);
    return {
      revenue, activeSponsors, statusCounts: status,
      pendingPayments: pending.map((p) => ({ count: p.n, amount: format(p.v, p.currency) })),
      awaitingApproval: (status.PENDING_APPROVAL ?? 0) + (status.ASSET_REVIEW ?? 0),
      deliverablesPending: (this.db.prepare("SELECT COUNT(*) AS n FROM sp_deliverables d JOIN sp_orders o ON o.id = d.order_id WHERE o.org_id = ? AND o.status IN ('ACTIVE','PAUSED') AND d.status IN ('pending','scheduled')").get(orgId) as any).n,
      inventory: { units, sold, available: units - sold, soldPct: units ? Math.round((sold / units) * 100) : 0, availablePct: units ? 100 - Math.round((sold / units) * 100) : 0, items: inv },
      topSponsors: top, pipeline, monthly,
      exposureDelivered: { tvHours: +(exposure.tv_seconds / 3600).toFixed(1), pageImpressions: exposure.live_impressions, uniqueViewers: exposure.unique_viewers, qrScans: exposure.qr_scans, clicks: exposure.clicks },
    };
  }

  /** Platform-wide numbers for the admin overview. */
  platform() {
    const gmv = this.db.prepare("SELECT currency, SUM(amount_minor) AS v FROM sp_ledger WHERE kind = 'charge' GROUP BY currency").all() as any[];
    const take = this.db.prepare("SELECT currency, SUM(amount_minor) AS v FROM sp_ledger WHERE kind IN ('commission','platform_fee') GROUP BY currency").all() as any[];
    return {
      gmv: gmv.map((g) => ({ currency: g.currency, amount: format(g.v, g.currency) })),
      platformRevenue: take.map((g) => ({ currency: g.currency, amount: format(g.v, g.currency) })),
      sponsors: Object.fromEntries((this.db.prepare('SELECT status, COUNT(*) AS n FROM sponsor_accounts GROUP BY status').all() as any[]).map((r) => [r.status, r.n])),
      orders: Object.fromEntries((this.db.prepare('SELECT status, COUNT(*) AS n FROM sp_orders GROUP BY status').all() as any[]).map((r) => [r.status, r.n])),
      opportunities: (this.db.prepare("SELECT COUNT(*) AS n FROM sp_opportunities WHERE status = 'published'").get() as any).n,
      flaggedAssets: (this.db.prepare("SELECT COUNT(*) AS n FROM sponsor_assets WHERE status = 'flagged'").get() as any).n,
      riskOrders: (this.db.prepare("SELECT COUNT(*) AS n FROM sp_orders WHERE risk != '[]'").get() as any).n,
      outbox: Object.fromEntries((this.db.prepare('SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status').all() as any[]).map((r) => [r.status, r.n])),
      webhooksRejected24h: (this.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.webhook_rejected' AND at > ?").get(new Date(Date.now() - 864e5).toISOString()) as any).n,
    };
  }
}

