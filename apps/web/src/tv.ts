/**
 * Big-screen app. Works on smart-TV browsers, Android TV, a Chromecast'd tab, a mini PC,
 * a Raspberry Pi kiosk or a laptop on HDMI — it is just a page.
 *
 *   /tv                 device mode: register → show PIN/QR → paired → whatever the organizer assigns
 *   /tv/m/:code         one match, no login (public matches)
 *   /tv/t/:code         tournament board: standings + live/upcoming matches, rotating
 *   /overlay/m/:code    transparent lower-third for OBS / streaming software
 *
 * Offline behaviour: the last config and every match state are cached locally and rendered
 * immediately on boot; when the network drops the screen keeps showing the last known score
 * and resynchronizes on reconnect without a refresh.
 */
import { Realtime } from './lib/rt.ts';
import { boardHtml, esc, renderBoard, startClockTicker } from './lib/board.ts';
import { t } from './lib/i18n.ts';

const store = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: any) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* quota / private mode: screen still works, just without boot cache */ }
  },
  del(k: string) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

const app = document.getElementById('app')!;
const path = location.pathname.split('/').filter(Boolean);
const params = new URLSearchParams(location.search);
const overlay = path[0] === 'overlay';
const rt = new Realtime();
startClockTicker(() => rt.serverNow());

let state: { config: any; matches: Record<string, any>; tournaments: Record<string, any> } = { config: null, matches: {}, tournaments: {} };
let viewIndex = 0;
let rotateTimer: any = null;
let lastUpdate: string | null = null;

document.body.classList.add(overlay ? 'mode-overlay' : 'mode-tv');
if (params.get('orientation') === 'portrait') document.body.classList.add('portrait');

// ---------------------------------------------------------------- connection badge
const badge = document.createElement('div');
badge.className = 'conn';
document.body.appendChild(badge);
rt.onState((s) => {
  document.body.dataset.conn = s;
  badge.textContent = s === 'connected' ? '' : s === 'connecting' ? t('connecting') : t('offline');
});

// ---------------------------------------------------------------- keep the screen awake + fullscreen on first interaction
async function wake() {
  try {
    await (navigator as any).wakeLock?.request('screen');
  } catch { /* not supported */ }
}
wake();
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
document.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
}, { once: false });

// ---------------------------------------------------------------- messages
rt.on((m) => {
  if (m.t === 'match' && m.match) {
    state.matches[m.match.code] = m.match;
    lastUpdate = new Date().toISOString();
    persist();
    onMatch(m.match.code);
  } else if (m.t === 'tournament' && m.tournament) {
    state.tournaments[m.tournament.code] = m.tournament;
    for (const x of m.tournament.matches) state.matches[x.code] = x;
    // Tournament boards follow every unfinished match's live feed, not just results.
    if (path[1] === 't') for (const x of m.tournament.matches.filter((y: any) => y.status !== 'completed').slice(0, 40)) rt.sub(`match:${x.code}`);
    persist();
    render();
  } else if (m.t === 'display.config') {
    state = { config: m, matches: { ...state.matches, ...m.matches }, tournaments: m.tournaments ?? {} };
    if (m.device.orientation === 'portrait') document.body.classList.add('portrait');
    else if (!params.get('orientation')) document.body.classList.remove('portrait');
    applyTheme(m.device.theme, m.device.branding);
    if (m.announcement) showAnnouncement(m.announcement);
    viewIndex = 0;
    persist();
    render();
  } else if (m.t === 'display.unknown') {
    store.del('arena.tv.device');
    registerDevice();
  } else if (m.t === 'announce') {
    showAnnouncement(m);
  } else if (m.t === 'reload') {
    location.reload();
  }
});

function persist() {
  if (path[0] === 'tv' && !path[1]) store.set('arena.tv.state', state);
  else store.set(`arena.tv.cache.${location.pathname}`, state);
}

function applyTheme(theme: any = {}, branding: any = {}) {
  const r = document.documentElement.style;
  const accent = theme.accent ?? branding.accent;
  if (accent && /^#[0-9a-f]{3,8}$/i.test(accent)) r.setProperty('--amber', accent);
  if (theme.background && /^#[0-9a-f]{3,8}$/i.test(theme.background)) r.setProperty('--night', theme.background);
}

// ---------------------------------------------------------------- announcements
let annTimer: any = null;
function showAnnouncement(a: any) {
  const until = Date.parse(a.until);
  if (!(until > rt.serverNow())) return;
  let el = document.getElementById('announce');
  if (!el) {
    el = document.createElement('div');
    el.id = 'announce';
    document.body.appendChild(el);
  }
  el.className = `announce level-${esc(a.level)}`;
  el.innerHTML = `<p>${esc(a.text)}</p>`;
  clearTimeout(annTimer);
  annTimer = setTimeout(() => el!.remove(), Math.min(until - rt.serverNow(), 3600e3));
}

// ---------------------------------------------------------------- rendering
function currentViews(): any[] {
  if (path[0] === 'tv' && path[1] === 'm') return [{ kind: 'match', match: path[2]?.toUpperCase() }];
  if (path[0] === 'overlay') return [{ kind: 'match', match: path[2]?.toUpperCase() }];
  if (path[0] === 'tv' && path[1] === 't') {
    const code = path[2]?.toUpperCase();
    const tour = state.tournaments[code];
    const live = (tour?.matches ?? []).filter((m: any) => m.status === 'live').map((m: any) => m.code);
    const views: any[] = [];
    if (live.length) views.push({ kind: 'grid', matches: live.slice(0, 12), title: tour.name, seconds: 20 });
    if (tour?.standings) views.push({ kind: 'standings', tournament: code, seconds: 15 });
    views.push({ kind: 'upcoming-t', tournament: code, seconds: 12 });
    return views;
  }
  return state.config?.views ?? [];
}

function onMatch(code: string) {
  const views = currentViews();
  const v = views[viewIndex % Math.max(1, views.length)];
  if (!v) return;
  if (v.kind === 'match' && v.match === code) {
    const host = app.querySelector<HTMLElement>('.stage-match');
    // First snapshot (or recovery from the idle screen): full render; afterwards patch in place.
    return host ? renderBoard(host, state.matches[code], overlay ? 'overlay' : 'tv') : render();
  }
  if (v.kind === 'grid') {
    const tile = app.querySelector<HTMLElement>(`[data-tile="${code}"]`);
    if (tile) return renderBoard(tile, state.matches[code], 'tile', { surface: tile.dataset.surface || null });
    if (!app.querySelector('.stage-grid')) return render();
  }
  if (['upcoming', 'results', 'fixtures', 'upcoming-t'].includes(v.kind)) render();
}

function render() {
  const cfg = state.config;
  if (path[0] === 'tv' && !path[1] && cfg && !cfg.device.paired) return renderPairing(cfg.device.pairingCode);
  const views = currentViews();
  clearTimeout(rotateTimer);
  if (!views.length) return renderIdle();
  const v = views[viewIndex % views.length];
  renderView(v);
  if (views.length > 1) {
    rotateTimer = setTimeout(() => {
      viewIndex = (viewIndex + 1) % views.length;
      render();
    }, (v.seconds ?? 10) * 1000);
  }
}

function renderView(v: any) {
  app.dataset.view = v.kind;
  if (v.kind !== 'match') document.body.classList.remove('has-follow');
  switch (v.kind) {
    case 'match': {
      const m = state.matches[v.match];
      if (!m) return renderIdle();
      const qr = !overlay && params.get('qr') !== '0';
      document.body.classList.toggle('has-follow', qr);
      app.innerHTML = `<section class="stage stage-match"></section>${qr ? followQr(m.code) : ''}`;
      return renderBoard(app.querySelector('.stage-match')!, m, overlay ? 'overlay' : 'tv');
    }
    case 'grid': {
      const tiles: { code: string | null; surface: string | null }[] = v.courts
        ? v.courts.map((c: any) => ({ code: c.match, surface: c.surface }))
        : (v.matches ?? []).map((c: string) => ({ code: c, surface: state.matches[c]?.surface ?? null }));
      const n = tiles.length;
      const cols = document.body.classList.contains('portrait') ? (n > 4 ? 2 : 1) : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
      app.innerHTML = `<section class="stage stage-grid">
        ${v.title ? `<h1 class="grid-title">${esc(v.title)}</h1>` : ''}
        <div class="grid" style="--cols:${cols}">${tiles.map((x) => `<div class="tile" data-tile="${esc(x.code ?? '')}" data-surface="${esc(x.surface ?? '')}">${
          x.code && state.matches[x.code] ? boardHtml(state.matches[x.code], 'tile', { surface: x.surface }) : `<div class="tile-empty"><strong>${esc(x.surface ?? '')}</strong><span>${esc(t('noCourtMatch'))}</span></div>`
        }</div>`).join('')}</div></section>`;
      return;
    }
    case 'standings': {
      const tour = state.tournaments[v.tournament];
      if (!tour?.standings) return renderIdle();
      app.innerHTML = `<section class="stage stage-table"><h1>${esc(tour.name)}</h1><h2>${esc(t('standings'))}</h2>${tour.standings.tables.map((tb: any) => `
        ${tb.group ? `<h3>Group ${esc(tb.group)}</h3>` : ''}
        <table class="standings"><thead><tr><th></th><th></th><th>${t('played')}</th><th>${t('won')}</th><th>${t('drawn')}</th><th>${t('lost')}</th><th>+/−</th>${tb.rows.some((r: any) => r.nrr != null) ? '<th>NRR</th>' : ''}<th>${t('pts')}</th></tr></thead>
        <tbody>${tb.rows.map((r: any, i: number) => `<tr><td class="pos">${i + 1}</td><td class="nm">${esc(r.name)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td><td>${r.diff > 0 ? '+' : ''}${r.diff}</td>${r.nrr != null ? `<td>${r.nrr.toFixed(3)}</td>` : ''}<td class="pts">${r.points}</td></tr>`).join('')}</tbody></table>`).join('')}</section>`;
      return;
    }
    case 'upcoming':
    case 'results':
    case 'fixtures':
    case 'upcoming-t': {
      let list: any[];
      let title: string;
      if (v.kind === 'upcoming-t') {
        const tour = state.tournaments[v.tournament];
        list = (tour?.matches ?? []).filter((m: any) => m.status !== 'completed').slice(0, 10);
        title = `${tour?.name ?? ''}`;
      } else {
        list = (v.matches ?? []).map((c: string) => state.matches[c]).filter(Boolean);
        title = v.kind === 'results' ? t('results') : t('upcoming');
      }
      app.innerHTML = `<section class="stage stage-list"><h1>${esc(title)}</h1><ol class="fixtures">${list.map((m) => {
        const d = m.display;
        const when = m.scheduledAt ? new Date(m.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        return `<li class="status-${esc(m.status)}"><span class="when">${m.status === 'live' ? `<span class="pill pill-live"><i></i>${t('live')}</span>` : esc(when)}</span>
          <span class="who">${esc(d.sides[0].name)} <em>${m.status === 'scheduled' ? t('vs') : `${esc(d.sides[0].score)} – ${esc(d.sides[1].score)}`}</em> ${esc(d.sides[1].name)}</span>
          <span class="where">${esc(m.surface ?? '')}</span></li>`;
      }).join('')}</ol></section>`;
      return;
    }
    case 'sponsor': {
      const sp = state.config?.sponsors ?? [];
      app.innerHTML = `<section class="stage stage-sponsor"><h2>${esc(t('sponsors'))}</h2><div class="sponsors">${sp.map((s: any) => s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="${esc(s.name)}">` : `<span>${esc(s.name)}</span>`).join('')}</div></section>`;
      return;
    }
    case 'announcement':
      app.innerHTML = `<section class="stage stage-announcement"><p>${esc(v.text)}</p></section>`;
      return;
    default:
      renderIdle();
  }
}

function followQr(code: string) {
  const url = `${location.origin}/live/${code}`;
  return `<aside class="follow"><img src="/api/qr?data=${encodeURIComponent(url)}" alt=""><span>${esc(t('scanToWatch'))}</span></aside>`;
}

function renderIdle() {
  const org = state.config?.device?.organization;
  app.dataset.view = 'idle';
  app.innerHTML = `<section class="stage stage-idle"><div class="mark">Arena<span>OS</span></div>${org ? `<p class="org">${esc(org)}</p>` : ''}<p>${esc(
    path[1] === 'm' && !state.matches[path[2]?.toUpperCase()] ? t('connecting') : t('idle'),
  )}</p>${state.config?.device?.name ? `<p class="dev">${esc(state.config.device.name)}</p>` : ''}</section>`;
}

function renderPairing(code: string | null) {
  app.dataset.view = 'pair';
  const pairUrl = `${location.origin}/pair?code=${code ?? ''}`;
  app.innerHTML = `<section class="stage stage-pair">
    <div class="pair-copy"><div class="mark">Arena<span>OS</span></div><h1>${esc(t('pairTitle'))}</h1><p>${esc(t('pairHelp'))}</p>
    <div class="pin" aria-label="Pairing code">${(code ?? '······').split('').map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <p class="hint">${esc(t('pairExpires'))}</p></div>
    ${code ? `<img class="pair-qr" src="/api/qr?data=${encodeURIComponent(pairUrl)}" alt="QR code to pair this screen">` : ''}
  </section>`;
}

// ---------------------------------------------------------------- boot
async function registerDevice() {
  try {
    const res = await fetch('/api/displays/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolution: `${screen.width}x${screen.height}`, orientation: innerHeight > innerWidth ? 'portrait' : 'landscape' }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    store.set('arena.tv.device', { deviceId: d.deviceId, secret: d.secret });
    renderPairing(d.pairingCode);
    hello();
  } catch {
    setTimeout(registerDevice, 5000);
  }
}

function hello() {
  const dev = store.get<{ deviceId: string; secret: string }>('arena.tv.device');
  if (dev) rt.setHello({ t: 'display.hello', deviceId: dev.deviceId, secret: dev.secret, resolution: `${screen.width}x${screen.height}` });
}

if (path[0] === 'tv' && !path[1]) {
  const cached = store.get<typeof state>('arena.tv.state');
  if (cached) {
    state = cached;
    render();
  }
  if (store.get('arena.tv.device')) hello();
  else registerDevice();
  setInterval(() => rt.raw({ t: 'display.hb', lastUpdate, resolution: `${screen.width}x${screen.height}` }), 15000);
} else {
  const cached = store.get<typeof state>(`arena.tv.cache.${location.pathname}`);
  if (cached) state = cached;
  const code = path[2]?.toUpperCase();
  if (path[1] === 't') rt.sub(`tournament:${code}`);
  else rt.sub(`match:${code}`);
  render();
}
