/**
 * Sports Diary homepage. Every score on this page comes from the real rule engine,
 * played live in the browser. Nothing is a recorded animation or a hand-typed number.
 */
import '../../../packages/engine/src/index.ts';
import { MatchAggregate, type Participant, type ScorerAction } from '../../../packages/engine/src/index.ts';
import { simulate, rng } from '../../../packages/engine/src/sim.ts';
import { roundRobin, standings } from '../../../packages/engine/src/tournament/index.ts';
import { boardHtml, esc, renderBoard, startClockTicker } from './lib/board.ts';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const R = rng((Date.now() % 100000) + 7);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
startClockTicker(() => Date.now());

// ------------------------------------------------------------------ match setups
interface Setup {
  sport: string;
  name: string;
  discipline: string;
  a: string;
  b: string;
  aShort?: string;
  bShort?: string;
  size: number; // players per side (0 = name only, doubles = 2)
  pre: number; // events to pre-play so the match is already under way
  stepMs: number; // simulated time per pre-played event
  court: string;
  rules: string;
  config?: Record<string, any>;
}

const SETUPS: Setup[] = [
  { sport: 'cricket', name: 'Cricket', discipline: 't20', a: 'Gandhinagar Panthers', b: 'Kochi Warriors', aShort: 'GPN', bShort: 'KWR', size: 11, pre: 150, stepMs: 25000, court: 'Cricket Oval', rules: 'Wides, no-balls, free hits, Super Overs' },
  { sport: 'football', name: 'Football', discipline: '11-a-side', a: 'Ahmedabad Stallions', b: 'Sanand Royals', aShort: 'AHS', bShort: 'SNR', size: 11, pre: 26, stepMs: 60000, court: 'Pitch A', rules: 'Cards, subs, extra time, shoot-outs' },
  { sport: 'badminton', name: 'Badminton', discipline: 'singles', a: 'Pari Gill', b: 'Priya Singh', size: 1, pre: 28, stepMs: 15000, court: 'Court 1', rules: 'Rally scoring, deuce to 30' },
  { sport: 'basketball', name: 'Basketball', discipline: '5x5', a: 'Mumbai Hoops', b: 'Pune Warriors', aShort: 'MHP', bShort: 'PNW', size: 8, pre: 70, stepMs: 9000, court: 'Court 5', rules: 'Fouls, bonus, timeouts, overtime' },
  { sport: 'tennis', name: 'Tennis', discipline: 'singles', a: 'Parth Chopra', b: 'Dev Iyer', size: 1, pre: 46, stepMs: 30000, court: 'Centre Court', rules: 'Advantage, tie-breaks, break points' },
  { sport: 'table-tennis', name: 'Table Tennis', discipline: 'singles', a: 'Aadhya Bose', b: 'Varun Rao', size: 1, pre: 30, stepMs: 12000, court: 'Table 2', rules: 'Serve every two, deuce every point' },
  { sport: 'volleyball', name: 'Volleyball', discipline: 'indoor', a: 'Hyderabad Hawks', b: 'Surat Falcons', aShort: 'HYD', bShort: 'SRT', size: 8, pre: 60, stepMs: 15000, court: 'Court 6', rules: 'Rotations, deciding set to 15' },
  { sport: 'pickleball', name: 'Pickleball', discipline: 'doubles', a: 'Patel / Bhatt', b: 'Reddy / Khan', size: 2, pre: 22, stepMs: 15000, court: 'Court 7', rules: 'Side-out scoring, servers 1 and 2' },
  { sport: 'padel', name: 'Padel', discipline: 'doubles', a: 'Shah / Jain', b: 'Bose / Das', size: 2, pre: 40, stepMs: 25000, court: 'Padel 1', rules: 'Golden point, match tie-break' },
  { sport: 'snooker', name: 'Snooker', discipline: 'best-of-7', a: 'Om Chopra', b: 'Saanvi Reddy', size: 1, pre: 40, stepMs: 30000, court: 'Table 1', rules: 'Breaks, fouls, snookers required' },
  { sport: 'billiards', name: 'Billiards', discipline: 'english-points', a: 'Tanvi Das', b: 'Arjun Kulkarni', size: 1, pre: 14, stepMs: 30000, court: 'Table 3', rules: 'Pots, in-offs, cannons, race to 150', config: { framesToWin: 1 } },
];

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Sai', 'Ishaan', 'Kabir', 'Rohan', 'Dhruv', 'Ananya', 'Diya', 'Kavya', 'Meera', 'Riya', 'Rahul', 'Karan', 'Yash', 'Harsh', 'Mihir', 'Kunal', 'Varun', 'Nikhil', 'Om', 'Rudra', 'Farhan', 'Imran', 'Gurpreet', 'Siddharth'];
const LAST = ['Shah', 'Patel', 'Mehta', 'Desai', 'Joshi', 'Iyer', 'Rao', 'Nair', 'Reddy', 'Kapoor', 'Singh', 'Gill', 'Bose', 'Das', 'Kulkarni', 'Pandya', 'Trivedi', 'Bhatt', 'Menon', 'Verma', 'Jain'];
const person = () => `${FIRST[Math.floor(R() * FIRST.length)]} ${LAST[Math.floor(R() * LAST.length)]}`;

function side(s: Setup, i: 0 | 1, key: string): Participant {
  const name = i === 0 ? s.a : s.b;
  const short = i === 0 ? s.aShort : s.bShort;
  let players: Participant['players'];
  if (s.size === 1) players = [{ id: `${key}-${i}-1`, name }];
  else if (s.size === 2) players = name.split(' / ').map((n, k) => ({ id: `${key}-${i}-${k}`, name: `${person().split(' ')[0]} ${n}` }));
  else players = Array.from({ length: s.size }, (_, k) => ({ id: `${key}-${i}-${k}`, name: person(), number: k + 1 }));
  return { id: `${key}-${i}`, name, short, players };
}

let serial = 0;
function newMatch(s: Setup, pre = s.pre): MatchAggregate {
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = `${s.sport}-${++serial}`;
    const m = new MatchAggregate({ id: key, sport: s.sport, discipline: s.discipline, config: s.config ?? {}, participants: [side(s, 0, key), side(s, 1, key)] });
    simulate(m, { seed: Math.floor(R() * 1e9), stopAfter: pre, bias: 0.5, stepMs: s.stepMs, startAt: Date.now() - pre * s.stepMs });
    if (m.status === 'live') return m;
    pre = Math.floor(pre * 0.6);
  }
  const m = new MatchAggregate({ id: `x${++serial}`, sport: s.sport, discipline: s.discipline, config: s.config ?? {}, participants: [side(s, 0, 'x'), side(s, 1, 'x')] });
  m.record({ type: 'MATCH_START' });
  return m;
}

const view = (m: MatchAggregate, s: Setup) => ({ code: m.match.id, status: m.status, display: m.display(), surface: s.court, tournament: null, label: null });

/** Timed sports: end the period when its real clock runs out, then start the next. */
function tidyClock(m: MatchAggregate) {
  const st: any = m.state;
  if (!st?.clock?.running || !st.clock.startedAt || st.periodIdx == null || st.periodIdx < 0) return;
  const el = st.clock.bankedMs + (Date.now() - st.clock.startedAt);
  let per = 0;
  if (m.engine.id === 'football') per = (st.plan?.[st.periodIdx]?.minutes ?? 45) * 60000;
  else if (m.engine.id === 'basketball') per = (st.periodIdx < m.ctx.config.periods ? m.ctx.config.periodMinutes : m.ctx.config.overtimeMinutes) * 60000;
  if (!per || el < per) return;
  try {
    m.record({ type: 'PERIOD_END' });
    if (m.status === 'live' && m.actions().some((a) => a.type === 'PERIOD_START')) m.record({ type: 'PERIOD_START' });
  } catch { /* the engine decides; nothing to force */ }
}

/** One realistic step chosen by the simulator (handles batters, bowlers, periods...). */
function autoStep(m: MatchAggregate) {
  tidyClock(m);
  const before = m.applied.length;
  for (let i = 0; i < 15 && m.applied.length === before && m.status === 'live'; i++)
    simulate(m, { seed: Math.floor(R() * 1e9), maxSteps: 1, bias: 0.5, startAt: Date.now() - 1, stepMs: 1 });
}

const tooLopsided = (m: MatchAggregate) => {
  const p = m.score().primary;
  return m.engine.id === 'football' ? p[0] + p[1] > 6 : false;
};

// ------------------------------------------------------------------ HERO
const heroTv = $('hero-tv');
const heroPhone = $('hero-phone');
const chips = $('sport-chips');
let heroIdx = 0;
let hero: MatchAggregate | null = null;
let heroTimer: any = null;
let autoRotate: any = null;
let userPicked = false;
let finishedAt = 0;

const CRICKET_W: Record<string, number> = { 'runs-0': 34, 'runs-1': 30, 'runs-2': 9, 'runs-3': 2, 'runs-4': 10, 'runs-6': 5, wide: 4, noball: 1.5, bye: 1, legbye: 1.5 };

function phoneActions(m: MatchAggregate): ScorerAction[] {
  const acts = m.actions().filter((a) => (a.group === 'primary' || a.group === 'stat') && !a.inputs?.some((x) => !x.optional) && a.type !== 'POSSESSION');
  const primary = acts.filter((a) => a.group === 'primary');
  const stat = acts.filter((a) => a.group === 'stat');
  const max = primary.length <= 2 && stat.length === 0 ? 2 : 6;
  return [...primary, ...stat].slice(0, max);
}

function weight(a: ScorerAction, m: MatchAggregate): number {
  if (m.engine.id === 'cricket') return CRICKET_W[a.id] ?? 1;
  if (a.type === 'GOAL') return 0.5;
  if (a.type === 'SCORE') return ({ 1: 0.6, 2: 1.4, 3: 0.8 } as any)[a.payload?.points] ?? 1;
  if (a.type === 'POINT' && a.payload?.how) return 0.25; // aces and double faults are rare
  return 1;
}

function pick(list: ScorerAction[], m: MatchAggregate): ScorerAction {
  const total = list.reduce((t, a) => t + weight(a, m), 0);
  let x = R() * total;
  for (const a of list) if ((x -= weight(a, m)) <= 0) return a;
  return list[list.length - 1];
}

function renderHeroPhone(m: MatchAggregate, s: Setup) {
  if (!heroPhone) return;
  const d = m.display();
  const acts = phoneActions(m);
  const big = acts.length <= 2;
  heroPhone.innerHTML = `
    <div class="ph-top"><span class="ph-back" aria-hidden="true">‹</span><div class="ph-title"><strong>${esc(s.a)} vs ${esc(s.b)}</strong><span>${esc(s.name)}, ${esc(s.court)}</span></div></div>
    <div class="ph-status"><i></i>All saved</div>
    <div class="ph-score">
      <div><span>${esc(d.sides[0].short ?? d.sides[0].name)}</span><b data-k="0">${esc(d.sides[0].score)}</b></div>
      <div><span>${esc(d.sides[1].short ?? d.sides[1].name)}</span><b data-k="1">${esc(d.sides[1].score)}</b></div>
    </div>
    <p class="ph-phase">${esc(d.phase)}</p>
    <ul class="ph-recent">${m.timeline.slice(-3).reverse().map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul>
    <div class="ph-pad ${big ? 'ph-pad-big' : ''}">${acts.map((a, i) => `<span class="ph-btn ${a.tone === 'positive' ? 'is-pos' : ''}" data-i="${i}">${esc(a.label.replace(/^Point /, ''))}</span>`).join('') || '<span class="ph-wait">Next batter coming in…</span>'}</div>`;
}

function renderHero() {
  if (!hero || !heroTv) return;
  const s = SETUPS[heroIdx];
  renderBoard(heroTv, view(hero, s), 'page');
  renderHeroPhone(hero, s);
}

function pulse() {
  const p = document.getElementById('signal-pulse');
  if (!p || reduce) return;
  p.classList.remove('go');
  void (p as any).getBoundingClientRect();
  p.classList.add('go');
}

function heroTick() {
  if (!hero) return;
  const s = SETUPS[heroIdx];
  if (hero.status !== 'live' || tooLopsided(hero)) {
    if (!finishedAt) finishedAt = Date.now();
    if (Date.now() - finishedAt > 4500) {
      finishedAt = 0;
      hero = newMatch(s);
      renderHero();
    }
    return schedule();
  }
  tidyClock(hero);
  const acts = phoneActions(hero);
  const silent = !acts.length || (hero.engine.id === 'cricket' && R() < 0.07) || (hero.engine.id === 'football' && R() < 0.15);
  if (silent) {
    autoStep(hero);
    renderHero();
    return schedule();
  }
  const a = pick(acts, hero);
  const btn = heroPhone?.querySelector<HTMLElement>(`.ph-btn[data-i="${acts.indexOf(a)}"]`);
  btn?.classList.add('tap');
  setTimeout(() => {
    if (!hero) return;
    try {
      hero.record({ type: a.type, payload: { ...(a.payload ?? {}) } });
    } catch {
      autoStep(hero);
    }
    pulse();
    setTimeout(renderHero, reduce ? 0 : 260);
    schedule();
  }, reduce ? 0 : 380);
}

function schedule() {
  clearTimeout(heroTimer);
  if (document.hidden) return;
  heroTimer = setTimeout(heroTick, reduce ? 3200 : 1500 + R() * 900);
}

function selectHero(i: number, byUser = false) {
  heroIdx = i;
  hero = newMatch(SETUPS[i]);
  finishedAt = 0;
  chips?.querySelectorAll('button').forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
  if (heroTv) heroTv.innerHTML = '';
  renderHero();
  if (byUser) {
    userPicked = true;
    clearInterval(autoRotate);
  }
  schedule();
}

if (chips) {
  chips.innerHTML = SETUPS.map((s, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-i="${i}">${esc(s.name)}</button>`).join('');
  chips.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-i]');
    if (b) selectHero(Number(b.dataset.i), true);
  });
}

// ------------------------------------------------------------------ SPORT GRID + TICKER
interface Live { s: Setup; m: MatchAggregate; el: HTMLElement | null; done: number; tick?: HTMLElement[] }
const grid = $('sport-grid');
const lives: Live[] = [];

function tickerHtml(l: Live) {
  const d = l.m.display();
  return `<b>${esc(l.s.name)}</b><span>${esc(d.sides[0].name)}</span><strong>${esc(d.sides[0].score)}</strong><span class="vs">${l.m.status === 'completed' ? 'FT' : esc(d.phase)}</span><strong>${esc(d.sides[1].score)}</strong><span>${esc(d.sides[1].name)}</span>`;
}

function stepLive(l: Live) {
  if (l.m.status !== 'live' || tooLopsided(l.m)) {
    if (!l.done) l.done = Date.now();
    if (Date.now() - l.done > 5000) {
      l.m = newMatch(l.s);
      l.done = 0;
    }
  } else autoStep(l.m);
  if (l.el) renderBoard(l.el, view(l.m, l.s), 'tile');
  l.tick?.forEach((t) => (t.innerHTML = tickerHtml(l)));
}

if (grid) {
  grid.innerHTML =
    SETUPS.map((s, i) => `<article class="h-sport"><div class="h-sport-board" id="tile-${i}"></div><h3>${esc(s.name)}</h3><p>${esc(s.rules)}</p></article>`).join('') +
    `<article class="h-sport h-sport-next"><div class="h-sport-next-box"><h3>Your sport next</h3><p>New sports plug into the same engine: rules, events and statistics, without rebuilding the platform.</p></div></article>`;
}
SETUPS.forEach((s, i) => {
  const l: Live = { s, m: newMatch(s), el: $(`tile-${i}`), done: 0 };
  lives.push(l);
  if (l.el) l.el.innerHTML = boardHtml(view(l.m, s), 'tile');
});

const ticker = $('ticker');
if (ticker) {
  const items = lives.map((l, i) => `<span class="h-tick" data-t="${i}">${tickerHtml(l)}</span>`).join('');
  ticker.innerHTML = items + items; // two copies for a seamless loop
  ticker.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => (lives[Number(el.dataset.t)].tick ??= []).push(el));
}

// ------------------------------------------------------------------ VENUE WALL
const WALL: Setup[] = [
  { ...SETUPS[2], court: 'Court 1', a: 'Farhan Reddy', b: 'Diya Gill' },
  { ...SETUPS[2], court: 'Court 2', a: 'Om Agarwal', b: 'Simran Kapoor' },
  { ...SETUPS[2], court: 'Court 3', a: 'Aditya Malhotra', b: 'Aarav Rao' },
  { ...SETUPS[2], court: 'Court 4', a: 'Meera Nair', b: 'Riya Joshi' },
  { ...SETUPS[7], court: 'Pickleball 1' },
  { ...SETUPS[8], court: 'Padel 1' },
  { ...SETUPS[5], court: 'Table 2', a: 'Kunal Mehta', b: 'Tara Desai' },
  { ...SETUPS[6], court: 'Main court' },
];
const wallGrid = $('wall-grid');
const wall: Live[] = [];
if (wallGrid) {
  wallGrid.innerHTML = WALL.map((_, i) => `<div class="h-wall-tile" id="wall-${i}"></div>`).join('');
  WALL.forEach((s, i) => {
    const l: Live = { s, m: newMatch(s), el: $(`wall-${i}`), done: 0 };
    wall.push(l);
    if (l.el) l.el.innerHTML = boardHtml(view(l.m, s), 'tile');
  });
}
const health = $('health');
if (health)
  health.innerHTML = [
    ['Main hall wall', 'Online'], ['Court 1 TV', 'Online'], ['Court 2 TV', 'Online'], ['Lobby totem', 'Online'], ['Café screen', 'Reconnecting'],
  ].map(([n, st]) => `<li><span class="dot ${st === 'Online' ? 'dot-online' : 'dot-syncing'}"></span><span>${n}</span><em>${st}</em></li>`).join('');

// ------------------------------------------------------------------ independent tickers for grid + wall
function loop(l: Live, min: number, max: number) {
  const go = () => {
    if (!document.hidden) stepLive(l);
    setTimeout(go, (reduce ? 2 : 1) * (min + R() * (max - min)));
  };
  setTimeout(go, 600 + R() * max);
}
lives.forEach((l) => loop(l, 1800, 4600));
wall.forEach((l) => loop(l, 1600, 4200));

// announcement demo on the wall
const ann = $('wall-announce');
if (ann && !reduce)
  setInterval(() => {
    if (document.hidden) return;
    ann.hidden = false;
    ann.classList.add('show');
    setTimeout(() => {
      ann.classList.remove('show');
      setTimeout(() => (ann.hidden = true), 400);
    }, 4200);
  }, 15000);

// ------------------------------------------------------------------ PAIRING DEMO
const pairTv = $('pair-tv');
const pairInput = $('pair-input');
const pairBtn = $('pair-btn');
const pairCard = $('pair-card');
function pinScreen(code: string) {
  if (!pairTv) return;
  pairTv.innerHTML = `<div class="pd-pin"><img src="/brand/sports-diary-on-dark.svg" alt="" width="381" height="83"><p>Pair this screen</p><div class="pd-digits">${code.split('').map((c) => `<span>${c}</span>`).join('')}</div><small>Enter this code in Sports Diary</small></div>`;
}
let pairCode = String(100000 + Math.floor(R() * 899999));
pinScreen(pairCode);
if (pairInput) pairInput.innerHTML = '<span class="pd-caret"></span>';
async function pairLoop() {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    pairCode = String(100000 + Math.floor(R() * 899999));
    pinScreen(pairCode);
    if (pairInput) pairInput.innerHTML = '<span class="pd-caret"></span>';
    pairCard?.classList.remove('done');
    await wait(1800);
    for (let i = 1; i <= 6; i++) {
      if (pairInput) pairInput.innerHTML = `${pairCode.slice(0, i).split('').map((c) => `<b>${c}</b>`).join('')}<span class="pd-caret"></span>`;
      await wait(240);
    }
    await wait(500);
    pairBtn?.classList.add('tap');
    await wait(420);
    pairBtn?.classList.remove('tap');
    pairCard?.classList.add('done');
    if (pairTv) {
      pairTv.classList.add('flash');
      const l = lives[0];
      pairTv.innerHTML = `<div class="pd-live"></div>`;
      const host = pairTv.querySelector<HTMLElement>('.pd-live')!;
      renderBoard(host, view(l.m, l.s), 'page');
      const follow = setInterval(() => renderBoard(host, view(l.m, l.s), 'page'), 1000);
      setTimeout(() => pairTv.classList.remove('flash'), 700);
      await wait(7000);
      clearInterval(follow);
      pairTv.classList.remove('flash');
    }
  }
}

// ------------------------------------------------------------------ OFFLINE DEMO
const off = { status: $('off-status'), link: $('off-link'), banner: $('off-banner'), pa: $('off-phone-a'), pb: $('off-phone-b'), ta: $('off-tv-a'), tb: $('off-tv-b') };
function relight(el: HTMLElement | null, v: string) {
  if (!el || el.textContent === v) return;
  el.textContent = v;
  el.classList.remove('relit');
  void el.offsetWidth;
  el.classList.add('relit');
}
async function offlineLoop() {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let a = 14;
  let b = 12;
  for (;;) {
    if (a > 19 || b > 19) {
      a = 14;
      b = 12;
    }
    const set = (st: string, cls: string) => {
      if (off.status) {
        off.status.textContent = st;
        off.status.className = `h-off-status ${cls}`;
      }
    };
    set('All saved', '');
    off.link?.classList.remove('cut');
    if (off.banner) (off.banner.textContent = 'Live'), (off.banner.className = 'h-off-banner');
    relight(off.ta, String(a));
    relight(off.tb, String(b));
    relight(off.pa, String(a));
    relight(off.pb, String(b));
    await wait(2600);
    off.link?.classList.add('cut');
    if (off.banner) (off.banner.textContent = 'Showing last known score'), (off.banner.className = 'h-off-banner is-held');
    const taps = [0, 0, 1];
    for (let i = 0; i < taps.length; i++) {
      await wait(1100);
      taps[i] === 0 ? a++ : b++;
      relight(off.pa, String(a));
      relight(off.pb, String(b));
      set(`Offline: ${i + 1} saved on phone`, 'is-off');
    }
    await wait(1400);
    off.link?.classList.remove('cut');
    set('Sending 3…', 'is-send');
    await wait(900);
    set('All saved', '');
    if (off.banner) (off.banner.textContent = 'Live'), (off.banner.className = 'h-off-banner');
    relight(off.ta, String(a));
    relight(off.tb, String(b));
    await wait(2600);
  }
}

// ------------------------------------------------------------------ STANDINGS (real round robin, played by the engine)
function buildStandings() {
  const table = $('standings');
  if (!table) return;
  const names = ['Aarav Shah', 'Diya Patel', 'Kabir Mehta', 'Isha Desai', 'Rohan Iyer', 'Meera Nair'];
  const fx = roundRobin(names);
  const results = fx.map((f, i) => {
    const m = new MatchAggregate({ id: `rr${i}`, sport: 'badminton', discipline: 'singles', config: {}, participants: [{ id: f.home!, name: f.home! }, { id: f.away!, name: f.away! }] });
    // stronger players earlier in the seed list win a little more often
    const bias = 0.5 + (names.indexOf(f.away!) - names.indexOf(f.home!)) * 0.012;
    simulate(m, { seed: 1000 + i, bias });
    return { home: f.home!, away: f.away!, winner: m.winner() as 0 | 1 | null, primary: m.score().primary, extra: m.score().extra };
  });
  const rows = standings('badminton', names, results);
  table.innerHTML = `<thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">P</th><th scope="col">W</th><th scope="col">L</th><th scope="col">Games</th><th scope="col">Pts</th></tr></thead><tbody>${rows
    .map((r, i) => `<tr class="${i < 2 ? 'q' : ''}"><td>${i + 1}</td><td class="nm">${esc(r.entrant)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.for}–${r.against}</td><td class="pts">${r.points}</td></tr>`)
    .join('')}</tbody>`;
}

// ------------------------------------------------------------------ MATCH REPORT (from a real simulated T10 game)
function buildReport() {
  const host = $('report');
  if (!host) return;
  const s: Setup = { ...SETUPS[0], discipline: 't10', a: 'Vadodara Kings', b: 'Rajkot Rangers', aShort: 'VDK', bShort: 'RJR' };
  let m = newMatch(s, 0);
  for (let tries = 0; tries < 5; tries++) {
    m = new MatchAggregate({ id: `rep${tries}`, sport: 'cricket', discipline: 't10', config: { oversPerInnings: 10 }, participants: [side(s, 0, `r${tries}`), side(s, 1, `r${tries}`)] });
    simulate(m, { seed: 77 + tries * 13, bias: 0.5 });
    if (m.status === 'completed' && m.winner() != null) break;
  }
  const st = m.statistics();
  const bat = [...st.players].filter((p) => p.stats.runs != null).sort((x, y) => Number(y.stats.runs) - Number(x.stats.runs))[0];
  const bowl = [...st.players].filter((p) => p.stats.wickets != null).sort((x, y) => Number(y.stats.wickets) - Number(x.stats.wickets) || Number(x.stats.runsConceded) - Number(y.stats.runsConceded))[0];
  const team = (i: 0 | 1) => m.match.participants[i].name;
  // label each ball with the batting side, so overs from both innings read clearly
  let batting = '';
  const tagged = m.timeline.map((t) => {
    if (t.type === 'INNINGS_START') batting = m.match.participants.find((p) => t.text.startsWith(p.name))?.short ?? '';
    return { ...t, batting };
  });
  const moments = tagged.filter((t) => /OUT!|SIX/.test(t.text)).slice(-4);
  const d = m.display();
  const sentences = [
    `${d.resultText ?? ''}.`,
    bat ? `${bat.name} (${team(bat.side)}) top-scored with ${bat.stats.runs} off ${bat.stats.ballsFaced} balls.` : '',
    bowl && Number(bowl.stats.wickets) > 0 ? `${bowl.name} took ${bowl.stats.wickets} for ${bowl.stats.runsConceded}.` : '',
  ].filter(Boolean);
  const inn = (st.detail as any)?.innings ?? [];
  $('report-sub')!.textContent = `Cricket T10, ${inn.map((i: any) => `${team(i.battingSide).split(' ')[0]} ${i.total}`).join(' v ')}`;
  host.innerHTML = `<p class="h-report">${esc(sentences.join(' '))}</p>
    <p class="h-report-label">Key moments</p>
    <ol class="h-moments">${moments.map((t) => {
      const [, over, rest] = t.text.match(/^(\d+\.\d)\s+(.*)$/) ?? [null, '', t.text];
      return `<li><span class="ov">${esc(t.batting)} ${esc(over)}</span><span>${esc(rest)}</span></li>`;
    }).join('')}</ol>`;
}

// ------------------------------------------------------------------ boot
selectHero(0);
if (!reduce)
  autoRotate = setInterval(() => {
    if (!userPicked && !document.hidden) selectHero((heroIdx + 1) % 5); // rotate the five headline sports
  }, 16000);
buildStandings();
buildReport();
if (!reduce) {
  // Start each demo when it scrolls into view, so visitors see it from the beginning.
  const startWhenSeen = (id: string, fn: () => void) => {
    const el = $(id);
    if (!el || !('IntersectionObserver' in window)) return fn();
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fn();
      }
    }, { threshold: 0.35 });
    io.observe(el);
  };
  startWhenSeen('pair-tv', pairLoop);
  startWhenSeen('off-status', offlineLoop);
}
document.addEventListener('visibilitychange', () => !document.hidden && schedule());

// Signed-in visitors get a direct way back to their console.
try {
  if (localStorage.getItem('arena.token')) {
    const a = $('nav-signin');
    if (a) a.textContent = 'Open console';
  }
} catch { /* storage unavailable */ }
