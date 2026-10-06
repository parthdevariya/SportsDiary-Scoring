/**
 * Universal scoreboard renderer. Every sport arrives as the engine's DisplayState, so one
 * renderer serves the TV, multi-court tiles, the broadcast overlay and the public page.
 */
import { t } from './i18n.ts';

export const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type BoardSize = 'tv' | 'tile' | 'overlay' | 'page';

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function clockAttrs(c: any) {
  if (!c) return '';
  return `data-clock='${esc(JSON.stringify(c))}'`;
}

/** Text for a clock at server time `now`. */
export function clockText(c: any, now: number): string {
  let el = c.elapsedMs;
  if (c.running && c.anchorAt) el += Math.max(0, now - Date.parse(c.anchorAt));
  if (c.direction === 'down' && c.periodMs) return fmt(c.periodMs - Math.min(el, c.periodMs));
  return fmt(el);
}

let ticking = false;
/** One shared ticker updates every visible clock from the server-synchronized time. */
export function startClockTicker(serverNow: () => number) {
  if (ticking) return;
  ticking = true;
  const tick = () => {
    const now = serverNow();
    document.querySelectorAll<HTMLElement>('[data-clock]').forEach((el) => {
      try {
        const txt = clockText(JSON.parse(el.dataset.clock!), now);
        if (el.textContent !== txt) el.textContent = txt;
      } catch { /* malformed */ }
    });
  };
  tick();
  setInterval(tick, 250);
}

function statusPill(status: string) {
  if (status === 'live') return `<span class="pill pill-live"><i></i><b>${esc(t('live'))}</b></span>`;
  if (status === 'completed') return '';
  if (status === 'scheduled') return `<span class="pill pill-quiet">${esc(t('upcoming'))}</span>`;
  return `<span class="pill pill-quiet">${esc(status)}</span>`;
}

export function boardHtml(view: any, size: BoardSize, opts: { surface?: string | null } = {}): string {
  const d = view.display;
  if (!d) return '';
  const sides = d.sides.map((s: any, i: number) => {
    const win = d.winner === i;
    const lose = d.winner != null && d.winner !== i;
    const badges = (s.badges ?? []).map((b: string) => `<span class="badge">${esc(b)}</span>`).join('');
    const detail = size === 'tile' ? [] : s.detail ?? [];
    return `<div class="side ${win ? 'is-winner' : ''} ${lose ? 'is-loser' : ''}" style="${s.color ? `--team:${esc(s.color)}` : ''}">
      <div class="side-id">
        <span class="lamp ${s.serving ? 'on' : ''}" title="${esc(t('serving'))}"></span>
        <span class="side-name">${esc(size === 'overlay' ? s.short ?? s.name : s.name)}</span>
        ${badges && size !== 'tile' ? `<span class="badges">${badges}</span>` : ''}
      </div>
      ${detail.length ? `<div class="side-detail">${detail.map((x: string) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      <div class="score" data-side="${i}">${esc(s.score)}</div>
    </div>`;
  });
  const periods = d.periods && size !== 'tile' && size !== 'overlay' && d.periods.labels.length > 0
    ? `<table class="periods"><thead><tr><th></th>${d.periods.labels.map((l: string) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${
        d.periods.rows.map((r: string[], i: number) => `<tr><th>${esc(d.sides[i].short ?? d.sides[i].name)}</th>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`
    : '';
  const clock = d.clock ? `<span class="clock" ${clockAttrs(d.clock)}>${esc(clockText(d.clock, Date.now()))}</span>` : '';
  const context = [view.tournament, view.label].filter(Boolean).join(' — ');
  const where = opts.surface ?? view.surface;
  const foot = d.resultText ?? d.headline ?? '';
  const ticker = size === 'tv' && d.ticker?.length && !d.resultText ? `<div class="ticker">${esc(d.ticker[0])}</div>` : '';
  return `<article class="board board-${size} status-${esc(view.status)}" data-code="${esc(view.code)}">
    <header class="board-top">
      <div class="board-ctx">${where ? `<strong>${esc(where)}</strong>` : ''}<span>${esc(size === 'tile' ? d.sportName : context || d.sportName)}</span></div>
      <div class="board-state">${statusPill(view.status)}<span class="phase">${esc(d.phase)}</span>${clock}</div>
    </header>
    <div class="sides">${sides.join('')}</div>
    ${foot || periods || ticker ? `<footer class="board-foot"><div class="foot-text">${foot ? `<div class="headline ${d.resultText ? 'is-result' : ''}">${esc(foot)}</div>` : ''}${ticker}</div>${periods}</footer>` : ''}
  </article>`;
}

/**
 * Render into a container, relighting any score digit that changed (the one deliberate
 * motion on the screen — like a scoreboard bulb flicking on).
 */
export function renderBoard(el: HTMLElement, view: any, size: BoardSize, opts: { surface?: string | null } = {}) {
  const prev = Array.from(el.querySelectorAll<HTMLElement>('.score')).map((s) => s.textContent);
  const prevCode = el.querySelector<HTMLElement>('.board')?.dataset.code;
  el.innerHTML = boardHtml(view, size, opts);
  if (prevCode !== view.code) return;
  el.querySelectorAll<HTMLElement>('.score').forEach((s, i) => {
    if (prev[i] != null && prev[i] !== s.textContent) {
      s.classList.add('relit');
      setTimeout(() => s.classList.remove('relit'), 1200);
    }
  });
}
