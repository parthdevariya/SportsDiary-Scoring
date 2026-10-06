/** Public spectator pages: /live/:code (a match) and /t/:code (a tournament). No login. */
import { esc, renderBoard, startClockTicker } from './lib/board.ts';
import { Realtime } from './lib/rt.ts';
import { toast } from './lib/api.ts';
import { LANGS, getLang, setLang, t } from './lib/i18n.ts';

const app = document.getElementById('app')!;
const [kind, raw] = location.pathname.split('/').filter(Boolean);
const code = (raw ?? '').toUpperCase();
const rt = new Realtime();
startClockTicker(() => rt.serverNow());

function langPicker() {
  return `<select class="lang" aria-label="Language">${LANGS.map((l) => `<option value="${l.id}" ${l.id === getLang() ? 'selected' : ''}>${l.label}</option>`).join('')}</select>`;
}
app.addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement;
  if (el.classList.contains('lang')) {
    setLang(el.value as any);
    location.reload();
  }
});

// ------------------------------------------------------------------ match page
let detail: any = null;
let refetchTimer: any = null;

async function loadMatch() {
  try {
    const r = await fetch(`/api/public/m/${code}`);
    if (!r.ok) throw new Error('This match is not public or the link is wrong.');
    detail = await r.json();
    renderMatch();
  } catch (e: any) {
    if (!detail) app.innerHTML = `<div class="empty"><h1>Match not found</h1><p>${esc(e.message)}</p></div>`;
  }
}

function shareText() {
  const d = detail.display;
  const status = detail.status === 'live' ? `${t('live')}: ` : detail.status === 'completed' ? `${t('final')}: ` : '';
  return `${status}${d.sides[0].name} ${d.sides[0].score} – ${d.sides[1].score} ${d.sides[1].name}${detail.tournament ? ` | ${detail.tournament}` : ''}`;
}

function renderMatch() {
  const url = location.href;
  const text = shareText();
  const st = detail.statistics?.team ?? [];
  const d = detail.display;
  document.title = `${d.sides[0].name} ${d.sides[0].score}–${d.sides[1].score} ${d.sides[1].name}`;
  app.innerHTML = `
    <header class="live-top"><a class="mark" href="/">Arena<span>OS</span></a>${detail.organization ? `<span class="org">${esc(detail.organization)}</span>` : ''}${langPicker()}</header>
    <section id="board" class="live-board"></section>
    <section class="share" aria-label="Share">
      <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}">WhatsApp</a>
      <a class="btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}">X</a>
      <a class="btn" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">Facebook</a>
      <a class="btn" href="/share/${esc(code)}" download="score-${esc(code)}.svg">Score card image</a>
      <button class="btn" data-cmd="copy">Copy link</button>
      ${'share' in navigator ? '<button class="btn" data-cmd="native">More…</button>' : ''}
    </section>
    <div class="live-cols">
      ${st.length ? `<section class="stats"><h2>Match stats</h2><table>${st.map((l: any) => `<tr><td>${esc(l.values[0])}</td><th>${esc(l.label)}</th><td>${esc(l.values[1])}</td></tr>`).join('')}</table></section>` : ''}
      <section class="timeline"><h2>Timeline</h2>${timelineHtml(detail.timeline ?? [])}</section>
    </div>
    ${detail.tournamentCode ? `<p class="crumb"><a href="/t/${esc(detail.tournamentCode)}">${esc(detail.tournament)} — standings and fixtures</a></p>` : ''}`;
  renderBoard(document.getElementById('board')!, detail, 'page');
}

function timelineHtml(items: any[]) {
  const li = (x: any) => `<li><time>${new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span>${esc(x.text)}</span></li>`;
  if (!items.length) return '<ol><li class="muted">The match hasn’t started yet.</li></ol>';
  const open = document.querySelector('.timeline details')?.hasAttribute('open') ? 'open' : '';
  return `<ol>${items.slice(0, 15).map(li).join('')}</ol>${items.length > 15 ? `<details ${open}><summary>Show ${items.length - 15} earlier</summary><ol>${items.slice(15).map(li).join('')}</ol></details>` : ''}`;
}

app.addEventListener('click', async (e) => {
  const cmd = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
  if (cmd === 'copy') {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied');
    } catch {
      prompt('Copy this link', location.href);
    }
  } else if (cmd === 'native') {
    (navigator as any).share?.({ title: document.title, text: shareText(), url: location.href }).catch(() => {});
  }
});

// ------------------------------------------------------------------ tournament page
let tour: any = null;
function renderTournament() {
  document.title = tour.name;
  const groups = (tour.standings?.tables ?? []) as any[];
  const byRound = new Map<string, any[]>();
  for (const m of tour.matches) {
    const k = m.label?.replace(/ \d+$/, '') ?? `Round ${m.round}`;
    byRound.set(k, [...(byRound.get(k) ?? []), m]);
  }
  app.innerHTML = `
    <header class="live-top"><a class="mark" href="/">Arena<span>OS</span></a>${langPicker()}</header>
    <h1 class="t-name">${esc(tour.name)}</h1>
    ${groups.map((g) => `<section class="stats"><h2>${g.group ? `Group ${esc(g.group)}` : esc(t('standings'))}</h2>
      <table class="standings"><thead><tr><th></th><th></th><th>${t('played')}</th><th>${t('won')}</th><th>${t('lost')}</th><th>+/−</th><th>${t('pts')}</th></tr></thead>
      <tbody>${g.rows.map((r: any, i: number) => `<tr><td>${i + 1}</td><td class="nm">${esc(r.name)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.diff}</td><td class="pts">${r.points}</td></tr>`).join('')}</tbody></table></section>`).join('')}
    ${[...byRound.entries()].map(([k, ms]) => `<section class="fixtures-block"><h2>${esc(k)}</h2><ul class="fixture-links">${ms.map((m) => {
      const d = m.display;
      return `<li><a href="/live/${esc(m.code)}" class="status-${esc(m.status)}"><span>${esc(d.sides[0].name)}</span><strong>${m.status === 'scheduled' ? t('vs') : `${esc(d.sides[0].score)}–${esc(d.sides[1].score)}`}</strong><span>${esc(d.sides[1].name)}</span><small>${m.status === 'live' ? t('live') : esc(m.surface ?? '')}</small></a></li>`;
    }).join('')}</ul></section>`).join('')}`;
}

rt.on((m) => {
  if (m.t === 'match' && kind === 'live' && m.match.code === code) {
    detail = { ...detail, ...m.match };
    renderMatch();
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(loadMatch, 800); // timeline + stats, throttled
  }
  if (m.t === 'tournament' && kind === 't') {
    tour = m.tournament;
    renderTournament();
    for (const x of tour.matches.filter((y: any) => y.status !== 'completed').slice(0, 40)) rt.sub(`match:${x.code}`);
  }
  if (m.t === 'match' && kind === 't' && tour) {
    tour.matches = tour.matches.map((x: any) => (x.code === m.match.code ? m.match : x));
    renderTournament();
  }
});

if (kind === 'live') {
  loadMatch();
  rt.sub(`match:${code}`);
} else {
  rt.sub(`tournament:${code}`);
}
