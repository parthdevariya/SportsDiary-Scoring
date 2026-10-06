/**
 * Sponsorship matching engine + sponsor AI agent.
 *
 * Matching is a transparent, deterministic score (0–100) over live marketplace data:
 *   budget fit 25 · sport/industry fit 20 · location 20 · audience fit 15 · goal fit 10 · value 10
 * Every recommendation carries the reasons that produced its score.
 *
 * The agent turns a sentence ("I have ₹5 lakh and want maximum visibility among young
 * cricket audiences in Gujarat") into that query, builds a budget plan, and explains it.
 * When ANTHROPIC_API_KEY is set, Claude writes the explanation from the computed facts
 * (it never chooses packages or invents numbers); otherwise a rule-based writer is used.
 * The response always says which engine produced it.
 */
import { catalog } from '../../../../packages/engine/src/index.ts';
import type { DB } from '../db.ts';
import { INDUSTRY_AFFINITY } from './catalog.ts';
import type { Marketplace } from './marketplace.ts';
import { convert, format } from './money.ts';
import { getPlatformSettings } from './settings.ts';

export type Goal = 'tv' | 'live' | 'social' | 'onsite' | 'online' | 'broadcast' | 'leads';

export interface RecQuery {
  budgetMinor?: number | null;
  currency?: string;
  sports?: string[];
  cities?: string[];
  states?: string[];
  country?: string | null;
  ageGroups?: string[];
  goals?: Goal[];
  levels?: string[];
  industry?: string | null;
  limit?: number;
}

export const AGE_GROUPS = ['13-17', '18-24', '25-34', '35-44', '45+'];

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry', 'Chandigarh',
];
const MAJOR_CITIES: Record<string, string> = {
  ahmedabad: 'Gujarat', surat: 'Gujarat', vadodara: 'Gujarat', rajkot: 'Gujarat', gandhinagar: 'Gujarat', mumbai: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra',
  bengaluru: 'Karnataka', bangalore: 'Karnataka', mysuru: 'Karnataka', chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', hyderabad: 'Telangana', kolkata: 'West Bengal',
  delhi: 'Delhi', 'new delhi': 'Delhi', noida: 'Uttar Pradesh', gurugram: 'Haryana', jaipur: 'Rajasthan', lucknow: 'Uttar Pradesh', kochi: 'Kerala', indore: 'Madhya Pradesh',
  bhopal: 'Madhya Pradesh', chandigarh: 'Chandigarh', goa: 'Goa', bhubaneswar: 'Odisha', guwahati: 'Assam', patna: 'Bihar',
};

const exposureGoal = (e: any, g: Goal) => (g === 'tv' ? e.tv : g === 'live' ? e.liveScore : g === 'social' ? e.social : g === 'onsite' ? e.onsite : g === 'online' ? e.online : g === 'broadcast' ? e.broadcast : g === 'leads' ? e.online || e.tv : false);

export class Recommender {
  constructor(private db: DB, private market: Marketplace) {}

  /** Score every purchasable package against the query. */
  recommend(q: RecQuery) {
    const fx = getPlatformSettings(this.db).fxRatesPerINR;
    const cur = q.currency ?? 'INR';
    const opps = this.db.prepare(`SELECT o.* FROM sp_opportunities o LEFT JOIN org_sponsorship_settings s ON s.org_id = o.org_id
      WHERE o.status = 'published' AND COALESCE(s.marketplace_enabled, 1) = 1 AND (o.ends_on IS NULL OR o.ends_on >= ?) LIMIT 1000`).all(new Date().toISOString().slice(0, 10)) as any[];
    const cands: any[] = [];
    for (const o of opps) {
      const card = this.market.card(o);
      const prof = JSON.parse(o.audience_profile || '{}');
      for (const p of this.db.prepare('SELECT * FROM sp_packages WHERE opportunity_id = ? AND active = 1').all(o.id) as any[]) {
        const v = this.market.packageView(p);
        if (v.remaining <= 0) continue;
        const model = v.saleModel ?? o.sale_model;
        const priceMinor = model === 'auction' ? v.auction?.nextMinimumMinor ?? null : v.priceMinor;
        if (model === 'auction' && v.auction?.status !== 'open') continue;
        if (priceMinor == null) continue; // pure RFP: no price to compare
        const priceInBudgetCur = convert(priceMinor, o.currency, cur, fx);
        cands.push({ o, card, prof, v, model, priceMinor, priceInBudgetCur });
      }
    }
    const perViewer = cands.filter((c) => c.o.audience_estimate > 0 && c.priceInBudgetCur != null).map((c) => c.priceInBudgetCur / c.o.audience_estimate).sort((a, b) => a - b);
    const median = perViewer.length ? perViewer[Math.floor(perViewer.length / 2)] : null;
    const affinity = q.industry ? INDUSTRY_AFFINITY[q.industry] : undefined;
    const lower = (xs?: string[]) => (xs ?? []).map((x) => x.toLowerCase());
    const qCities = lower(q.cities);
    const qStates = lower(q.states);

    const scored = cands.map((c) => {
      const reasons: string[] = [];
      const cautions: string[] = [];
      let s = 0;
      // budget 25
      if (q.budgetMinor && c.priceInBudgetCur != null) {
        if (c.priceInBudgetCur <= q.budgetMinor) {
          const use = c.priceInBudgetCur / q.budgetMinor;
          s += 25 * (0.6 + 0.4 * use);
          reasons.push(`${format(c.priceMinor, c.o.currency)} fits your ${format(q.budgetMinor, cur)} budget`);
        } else if (c.model === 'negotiated' && c.priceInBudgetCur <= q.budgetMinor * 1.2) {
          s += 8;
          cautions.push('Slightly over budget, but the organizer accepts offers');
        } else return null;
      } else s += 12;
      // sport / industry 20
      const sport = c.o.sport;
      if (q.sports?.length) {
        if (sport && q.sports.includes(sport)) (s += 20), reasons.push(`${titleCase(sport)} audience, as you asked`);
        else if (sport && affinity?.sports.includes(sport)) s += 8;
        else s += 0;
      } else if (affinity) {
        if (sport && affinity.sports.includes(sport)) (s += 16), reasons.push(`${titleCase(sport)} suits ${q.industry} brands`);
        else s += 6;
        if (affinity.levels.includes(c.o.level)) s += 2;
      } else s += 10;
      // location 20
      const city = (c.o.city ?? '').toLowerCase();
      const state = (c.o.state ?? MAJOR_CITIES[city] ?? '').toLowerCase();
      if (qCities.length || qStates.length) {
        if (city && qCities.includes(city)) (s += 20), reasons.push(`In ${c.o.city}`);
        else if (state && (qStates.includes(state) || qCities.some((qc) => MAJOR_CITIES[qc]?.toLowerCase() === state))) (s += 15), reasons.push(`In ${c.o.state ?? MAJOR_CITIES[city]}`);
        else if (q.country && c.o.country?.toLowerCase() === q.country.toLowerCase()) s += 4;
      } else if (q.country) s += c.o.country?.toLowerCase() === q.country.toLowerCase() ? 12 : 2;
      else s += 10;
      // audience 15
      if (q.ageGroups?.length) {
        const ag: string[] = c.prof.ageGroups ?? [];
        if (ag.length) {
          const overlap = q.ageGroups.filter((a) => ag.includes(a)).length / q.ageGroups.length;
          s += 15 * overlap;
          if (overlap >= 0.5) reasons.push(`Audience skews ${ag.filter((a) => q.ageGroups!.includes(a)).join(', ')}`);
        } else {
          s += 5;
          cautions.push('Organizer has not described the audience age profile');
        }
      } else s += 8;
      if (q.levels?.length && q.levels.includes(c.o.level)) (s += 3), reasons.push(`${titleCase(c.o.level)}-level event`);
      // goals 10
      if (q.goals?.length) {
        const hit = q.goals.filter((g) => exposureGoal(c.v.exposure, g));
        s += 10 * (hit.length / q.goals.length);
        if (hit.includes('tv')) reasons.push('Branding on venue TV screens');
        if (hit.includes('live')) reasons.push('On live score pages');
        if (hit.includes('social')) reasons.push('Includes social media posts');
      } else s += 6;
      // value 10
      const ppv = c.o.audience_estimate > 0 && c.priceInBudgetCur != null ? c.priceInBudgetCur / c.o.audience_estimate : null;
      if (ppv != null && median != null) {
        const v = Math.max(0, Math.min(1, median / ppv / 2));
        s += 10 * v;
        if (ppv <= median) reasons.push(`Good value: about ${format(Math.max(1, Math.round(ppv)), cur)} per estimated viewer`);
      } else s += 3;
      if (c.model === 'auction') cautions.push(`Auction — current price ${c.v.auction?.current}, ends ${String(c.v.auction?.endsAt).slice(0, 10)}`);
      if (c.v.remaining === 1 && c.v.maxSponsors > 1) cautions.push('Last slot available');
      return {
        score: Math.round(Math.min(100, s)), reasons, cautions,
        opportunity: { id: c.o.id, slug: c.o.slug, title: c.o.title, sport: c.o.sport, city: c.o.city, state: c.o.state, level: c.o.level, startsOn: c.o.starts_on, endsOn: c.o.ends_on, organizer: c.card.organizer, audienceEstimate: c.o.audience_estimate },
        package: { id: c.v.id, name: c.v.name, tier: c.v.tier, priceMinor: c.priceMinor, currency: c.o.currency, price: format(c.priceMinor, c.o.currency), saleModel: c.model, exposure: c.v.exposure, items: c.v.items.map((i: any) => i.label) },
        priceInBudgetCurrency: c.priceInBudgetCur,
        estimatedReach: c.o.audience_estimate,
      };
    }).filter(Boolean) as any[];
    scored.sort((a, b) => b.score - a.score || (a.priceInBudgetCurrency ?? 0) - (b.priceInBudgetCurrency ?? 0));
    return scored.slice(0, Math.min(q.limit ?? 12, 50));
  }

  /** Greedy budget allocation: best score × reach per rupee, one package per opportunity. */
  plan(q: RecQuery) {
    const recs = this.recommend({ ...q, limit: 50 });
    if (!q.budgetMinor) return { picks: recs.slice(0, 3), totalMinor: null, remainingMinor: null, estimatedReach: recs.slice(0, 3).reduce((s, r) => s + (r.estimatedReach ?? 0), 0), currency: q.currency ?? 'INR' };
    const ranked = [...recs].filter((r) => r.priceInBudgetCurrency != null && r.package.saleModel !== 'auction').sort((a, b) => b.score * Math.max(1, b.estimatedReach) / b.priceInBudgetCurrency - (a.score * Math.max(1, a.estimatedReach)) / a.priceInBudgetCurrency);
    let left = q.budgetMinor;
    const used = new Set<string>();
    const picks: any[] = [];
    // a plan honours what the sponsor explicitly asked for: the sport and the place are hard requirements
    const wantSport = (r: any) => !q.sports?.length || q.sports.includes(r.opportunity.sport);
    const lc = (x?: string | null) => (x ?? '').toLowerCase();
    const wantPlace = (r: any) =>
      (!q.cities?.length && !q.states?.length) ||
      (q.cities ?? []).some((c) => lc(c) === lc(r.opportunity.city)) ||
      (q.states ?? []).some((st) => lc(st) === lc(r.opportunity.state) || lc(st) === lc(MAJOR_CITIES[lc(r.opportunity.city)]));
    for (const r of ranked) {
      if (used.has(r.opportunity.id) || r.priceInBudgetCurrency > left || r.score < 40 || !wantSport(r) || !wantPlace(r)) continue;
      picks.push(r);
      used.add(r.opportunity.id);
      left -= r.priceInBudgetCurrency;
      if (picks.length >= 6) break;
    }
    // upgrade pass: spend the remaining budget on bigger packages of the chosen opportunities (best score per extra rupee first)
    for (let changed = true; changed; ) {
      changed = false;
      const ups = picks.flatMap((cur, idx) => recs.filter((r) => r.opportunity.id === cur.opportunity.id && r.package.id !== cur.package.id && r.package.saleModel !== 'auction' && r.priceInBudgetCurrency > cur.priceInBudgetCurrency && r.priceInBudgetCurrency - cur.priceInBudgetCurrency <= left && r.score >= cur.score - 5)
        .map((r) => ({ idx, r, extra: r.priceInBudgetCurrency - cur.priceInBudgetCurrency })))
        .sort((a, b) => b.r.score - a.r.score || b.extra - a.extra);
      if (ups[0]) {
        left -= ups[0].extra;
        picks[ups[0].idx] = ups[0].r;
        changed = true;
      }
    }
    const cur = q.currency ?? 'INR';
    return { picks, totalMinor: q.budgetMinor - left, total: format(q.budgetMinor - left, cur), remainingMinor: left, remaining: format(left, cur), estimatedReach: picks.reduce((s, r) => s + (r.estimatedReach ?? 0), 0), currency: cur, note: 'Prices exclude GST and platform fees. Reach is the organizers’ audience estimate.' };
  }

  /** Natural language → structured query. Reports exactly what it understood. */
  parse(text: string, defaults: Partial<RecQuery> = {}): { query: RecQuery; understood: string[] } {
    const t = ` ${text.toLowerCase()} `;
    const understood: string[] = [];
    const q: RecQuery = { currency: 'INR', ...defaults };
    // budget
    const money = text.match(/(?:₹|rs\.?|inr)\s*[\d,.]+\s*(?:crores?|cr|lakhs?|lacs?|l\b|k\b)?|\$\s*[\d,.]+\s*k?|€\s*[\d,.]+\s*k?|£\s*[\d,.]+\s*k?|\b[\d,.]+\s*(?:crores?|cr|lakhs?|lacs?|k)\b|\b\d{5,}\b/i);
    if (money) {
      const m = money[0].toLowerCase();
      const cur = m.includes('$') ? 'USD' : m.includes('€') ? 'EUR' : m.includes('£') ? 'GBP' : 'INR';
      const n = Number((m.match(/[\d,.]+/)?.[0] ?? '0').replace(/,/g, ''));
      const mult = /crore|cr\b/.test(m) ? 1e7 : /lakh|lac|\bl\b/.test(m) ? 1e5 : /k\b/.test(m) ? 1e3 : 1;
      if (n > 0) {
        q.budgetMinor = Math.round(n * mult * 100);
        q.currency = cur;
        understood.push(`Budget ${format(q.budgetMinor, cur)}`);
      }
    }
    // sports
    const sports = new Set<string>();
    for (const s of catalog()) if (t.includes(` ${s.name.toLowerCase()}`) || t.includes(` ${s.id}`)) sports.add(s.id);
    if (/\bsoccer\b|\bfutsal\b/.test(t)) sports.add('football');
    if (/\bping[- ]?pong\b|\btt\b/.test(t)) sports.add('table-tennis');
    if (/\bpool\b/.test(t)) sports.add('billiards');
    if (/racket|racquet/.test(t)) ['badminton', 'tennis', 'pickleball', 'padel', 'table-tennis'].forEach((x) => sports.add(x));
    if (sports.size) (q.sports = [...sports]), understood.push(`Sport: ${[...sports].map(titleCase).join(', ')}`);
    // places
    const states = INDIAN_STATES.filter((s) => t.includes(` ${s.toLowerCase()}`));
    const cityNames = new Set<string>(Object.keys(MAJOR_CITIES));
    for (const r of this.db.prepare("SELECT DISTINCT LOWER(city) AS c FROM sp_opportunities WHERE city IS NOT NULL AND status = 'published'").all() as any[]) cityNames.add(r.c);
    const cities = [...cityNames].filter((c) => c && t.includes(` ${c}`));
    if (states.length) (q.states = states), understood.push(`State: ${states.join(', ')}`);
    if (cities.length) (q.cities = cities.map(titleCase)), understood.push(`City: ${cities.map(titleCase).join(', ')}`);
    if (/\bindia\b|\bindian\b|nationwide|pan[- ]india/.test(t) && !states.length && !cities.length) (q.country = 'India'), understood.push('Anywhere in India');
    // audience
    const ages = new Set<string>();
    const levels = new Set<string>();
    if (/young|youth|gen ?z|millennial/.test(t)) ['18-24', '25-34'].forEach((a) => ages.add(a));
    if (/student|college|universit/.test(t)) (ages.add('18-24'), levels.add('college'));
    if (/school|kids|children|teen/.test(t)) (ages.add('13-17'), levels.add('school'));
    if (/famil|parents/.test(t)) ['25-34', '35-44'].forEach((a) => ages.add(a));
    if (/corporate|professional|b2b|working/.test(t)) (['25-34', '35-44'].forEach((a) => ages.add(a)), levels.add('corporate'));
    if (/senior|older|retire/.test(t)) ages.add('45+');
    if (/national\b/.test(t)) levels.add('national');
    if (/state[- ]level/.test(t)) levels.add('state');
    if (ages.size) (q.ageGroups = [...ages]), understood.push(`Audience age ${[...ages].join(', ')}`);
    if (levels.size) (q.levels = [...levels]), understood.push(`Level: ${[...levels].join(', ')}`);
    // goals
    const goals = new Set<Goal>();
    if (/visib|awareness|exposure|eyeball|branding|reach/.test(t)) ['tv', 'live', 'onsite'].forEach((g) => goals.add(g as Goal));
    if (/\btv\b|screen|led|big screen/.test(t)) goals.add('tv');
    if (/live score|online|digital|website|app\b/.test(t)) goals.add('online');
    if (/social|instagram|facebook|linkedin|youtube|\bx\b|twitter/.test(t)) goals.add('social');
    if (/stream|broadcast|overlay/.test(t)) goals.add('broadcast');
    if (/lead|traffic|click|qr|footfall|sign ?ups?|conversion/.test(t)) goals.add('leads');
    if (/on[- ]?ground|venue|banner|physical/.test(t)) goals.add('onsite');
    if (goals.size) (q.goals = [...goals]), understood.push(`Goals: ${[...goals].join(', ')}`);
    return { query: q, understood };
  }

  async agent(text: string, sponsor: { industry?: string | null; city?: string | null; country?: string | null } | null) {
    const msg = String(text ?? '').slice(0, 1000).trim();
    if (msg.length < 3) return { engine: 'rules', answer: 'Tell me your budget, the sport or audience you want, and where — for example: "I have ₹5 lakh and want maximum visibility among young cricket audiences in Gujarat."', understood: [], plan: null };
    const { query, understood } = this.parse(msg, { industry: sponsor?.industry ?? null });
    if (!query.country && !query.states?.length && !query.cities?.length && sponsor?.country) query.country = sponsor.country;
    const plan = this.plan(query);
    const facts = {
      request: msg, understood,
      picks: plan.picks.map((p: any) => ({ title: p.opportunity.title, package: p.package.name, price: p.package.price, sport: p.opportunity.sport, city: p.opportunity.city, organizerAudienceEstimate: p.estimatedReach, score: p.score, reasons: p.reasons, cautions: p.cautions })),
      total: (plan as any).total ?? null, remaining: (plan as any).remaining ?? null, estimatedReach: plan.estimatedReach,
    };
    const ai = await claudeExplain(facts).catch(() => null);
    return { engine: ai ? `claude:${process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5'}` : 'rules', answer: ai ?? ruleExplain(facts), understood, query, plan };
  }
}

const titleCase = (s: string) => String(s).replace(/(^|[\s-])\w/g, (c) => c.toUpperCase()).replace('-', ' ');

function ruleExplain(f: any): string {
  if (!f.picks.length) return `I couldn't find open packages matching ${f.understood.length ? f.understood.join(' · ') : 'that request'}. Try a wider area, another sport, or a higher budget — or post an enquiry to organizers.`;
  const lines = f.picks.map((p: any, i: number) => `${i + 1}. ${p.title} — ${p.package} for ${p.price}${p.organizerAudienceEstimate ? ` (≈${p.organizerAudienceEstimate.toLocaleString('en-IN')} people, organizer estimate)` : ''}. ${p.reasons.slice(0, 2).join('; ')}.`);
  const head = f.total ? `Here's how I'd spend ${f.total} of your budget across ${f.picks.length} sponsorship${f.picks.length > 1 ? 's' : ''}:` : 'Here are the best matches:';
  const tail = f.remaining ? `\n\n${f.remaining} left over${f.picks.length ? ' — keep it for renewals or add social posts' : ''}. Prices exclude GST.` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

/** Claude writes the explanation from computed facts only. Returns null if unavailable. */
async function claudeExplain(facts: any): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !facts.picks.length) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
        max_tokens: 600,
        system: 'You are a sponsorship advisor on a sports marketplace. Explain the recommended plan to the sponsor in under 180 words. Use ONLY the facts in the JSON: do not add packages, prices, audiences or claims that are not there. Audience numbers are organizer estimates; say so. Use a short numbered list for the picks.',
        messages: [{ role: 'user', content: JSON.stringify(facts) }],
      }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.content?.find((c: any) => c.type === 'text')?.text?.trim() || null;
  } finally {
    clearTimeout(timer);
  }
}
