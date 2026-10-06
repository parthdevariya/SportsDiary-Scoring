/**
 * Sports intelligence layer (Phase 1: grounded, deterministic).
 *
 * Everything here is derived ONLY from the verified event log and engine statistics,
 * never from model guesses, and nothing here can write to a match. Every generated
 * claim carries the event seqs it is grounded in, so an LLM provider plugged in later
 * (Phase 24) receives the same `facts` bundle and must cite from it — the verification
 * contract stays the same whether the prose comes from templates or a model.
 */
import type { MatchAggregate } from '../../../../packages/engine/src/index.ts';
import type { MatchRow } from './matches.ts';
import { P } from '../db.ts';
import { readFileSync } from 'node:fs';

/** The on-dark Sports Diary logo, inlined into share cards so they render anywhere. */
const LOGO = (() => {
  try {
    const svg = readFileSync(new URL('../../../web/public/brand/sports-diary-on-dark.svg', import.meta.url), 'utf8');
    const vb = svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 381 83';
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    return { vb, inner };
  } catch {
    return null;
  }
})();

export interface Fact {
  claim: string;
  sources: number[]; // event seqs
}

export interface InsightProvider {
  name: string;
  summarize(facts: ReturnType<typeof buildFacts>): Promise<{ summary: string; social: string }>;
}

export function buildFacts(row: MatchRow, agg: MatchAggregate, meta: { tournament?: string | null; venue?: string | null; surface?: string | null }) {
  const p = agg.match.participants;
  const d = agg.display();
  const stats = agg.statistics();
  const keyMoments: Fact[] = agg.timeline
    .filter((t) => /GOAL|OUT!|SIX|win|Break|take set|Game \d to|wins frame|Three-pointer|Super Over|innings begins|Penalty/i.test(t.text))
    .slice(-12)
    .map((t) => ({ claim: t.text, sources: [t.seq] }));
  const topPlayers = [...stats.players]
    .map((pl) => ({ ...pl, impact: Number(pl.stats.goals ?? 0) * 3 + Number(pl.stats.pts ?? 0) + Number(pl.stats.runs ?? 0) / 10 + Number(pl.stats.wickets ?? 0) * 2.5 + Number(pl.stats.assists ?? pl.stats.ast ?? 0) }))
    .filter((pl) => pl.impact > 0)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3);
  return {
    sport: agg.engine.name,
    discipline: row.discipline,
    status: agg.status,
    sides: [p[0].name, p[1].name],
    score: agg.score().text,
    resultText: d.resultText ?? null,
    winner: agg.winner(),
    phase: d.phase,
    headline: d.headline ?? null,
    tournament: meta.tournament ?? null,
    venue: [meta.venue, meta.surface].filter(Boolean).join(' · ') || null,
    teamStats: stats.team.slice(0, 8),
    topPlayers: topPlayers.map((t) => ({ name: t.name, side: p[t.side].name, stats: t.stats })),
    keyMoments,
    eventsVerified: agg.applied.length,
    version: agg.version,
  };
}

/** Template provider: deterministic, offline, cannot hallucinate. */
export const templateProvider: InsightProvider = {
  name: 'verified-template',
  async summarize(f) {
    const parts: string[] = [];
    if (f.status === 'completed') parts.push(`${f.resultText ?? `${f.sides[0]} ${f.score[0]}–${f.score[1]} ${f.sides[1]}`}.`);
    else parts.push(`${f.sides[0]} ${f.score[0]} – ${f.score[1]} ${f.sides[1]} (${f.phase.toLowerCase()}).`);
    if (f.tournament) parts.push(`${f.tournament}${f.venue ? `, ${f.venue}` : ''}.`);
    const moments = f.keyMoments.slice(-4).map((m) => m.claim);
    if (moments.length) parts.push(`Key moments: ${moments.join('; ')}.`);
    const standout = f.topPlayers[0];
    if (standout) {
      const s = Object.entries(standout.stats).filter(([, v]) => typeof v === 'number' && v > 0).slice(0, 3).map(([k, v]) => `${v} ${k}`).join(', ');
      parts.push(`Standout: ${standout.name} (${standout.side})${s ? ` — ${s}` : ''}.`);
    }
    const st = f.teamStats.slice(0, 3).map((l) => `${l.label} ${l.values[0]}–${l.values[1]}`).join(' · ');
    if (st) parts.push(st + '.');
    const live = f.status === 'live' ? '🔴 LIVE ' : f.status === 'completed' ? 'FT ' : '';
    const social = `${live}${f.sides[0]} ${f.score[0]}–${f.score[1]} ${f.sides[1]}${f.tournament ? ` | ${f.tournament}` : ''}${f.resultText ? `\n${f.resultText}` : ''}${standout ? `\n⭐ ${standout.name}` : ''}`;
    return { summary: parts.join(' '), social };
  },
};

/** Player of the match from verified stats only; null when the data can't support a pick. */
export function playerOfTheMatch(f: ReturnType<typeof buildFacts>) {
  return f.topPlayers[0] ?? null;
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 1200×630 share card (Open Graph size) rendered as SVG from the public projection. */
export function shareCardSvg(view: any): string {
  const d = view.display;
  const [a, b] = d.sides;
  const live = view.status === 'live';
  const badge = live ? 'LIVE' : view.status === 'completed' ? 'FINAL' : 'UPCOMING';
  const fit = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#031A33"/><stop offset="1" stop-color="#062547"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<rect x="0" y="0" width="1200" height="8" fill="#64C225"/>
<text x="60" y="92" font-family="Inter,Arial,sans-serif" font-size="30" font-weight="700" fill="#93A6BD" letter-spacing="4">${esc(fit((view.tournament ?? d.sportName).toUpperCase(), 48))}</text>
<rect x="${1140 - badge.length * 22 - 40}" y="56" rx="8" width="${badge.length * 22 + 40}" height="50" fill="${live ? '#E5484D' : '#1C4472'}"/>
<text x="${1120 - badge.length * 11}" y="92" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="28" font-weight="800" fill="#fff" letter-spacing="3">${badge}</text>
<text x="60" y="260" font-family="Inter,Arial,sans-serif" font-size="56" font-weight="800" fill="#fff">${esc(fit(a.name, 22))}</text>
<text x="60" y="440" font-family="Inter,Arial,sans-serif" font-size="56" font-weight="800" fill="#fff">${esc(fit(b.name, 22))}</text>
<text x="1140" y="285" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="140" font-weight="900" fill="${d.winner === 0 ? '#64C225' : '#fff'}">${esc(a.score)}</text>
<text x="1140" y="465" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="140" font-weight="900" fill="${d.winner === 1 ? '#64C225' : '#fff'}">${esc(b.score)}</text>
<line x1="60" y1="330" x2="1140" y2="330" stroke="#1C4472" stroke-width="2"/>
<text x="60" y="530" font-family="Inter,Arial,sans-serif" font-size="32" font-weight="600" fill="#64C225">${esc(fit(d.resultText ?? [d.phase, d.headline].filter(Boolean).join(' · '), 60))}</text>
${LOGO ? `<svg x="60" y="575" width="210" height="46" viewBox="${LOGO.vb}" preserveAspectRatio="xMinYMid meet">${LOGO.inner}</svg>` : ''}
<text x="1140" y="606" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="22" fill="#93A6BD">${esc(view.organization ?? '')}</text>
</svg>`;
}

void P;
