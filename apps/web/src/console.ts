/** Organizer console: live overview, matches, tournaments, venues, screens, people. */
import { api, session, toast } from './lib/api.ts';
import { boardHtml, esc, startClockTicker } from './lib/board.ts';
import { Realtime } from './lib/rt.ts';
import { openCastSheet } from './lib/cast.ts';
import { logo } from './lib/brand.ts';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
let me: any = null;
let sports: any[] = [];
let venues: any[] = [];
let rt: Realtime | null = null;

const sportName = (id: string) => sports.find((s) => s.id === id)?.name ?? id;
const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not scheduled');
const surfaces = () => venues.flatMap((v) => v.surfaces.map((s: any) => ({ ...s, venue: v.name })));
const formData = (f: HTMLFormElement) => Object.fromEntries(new FormData(f).entries()) as Record<string, string>;

// ------------------------------------------------------------------ auth
function renderAuth(mode: 'login' | 'register' = 'login') {
  document.body.className = 'console auth';
  app.innerHTML = `
  <main class="auth-wrap">
    <section class="auth-pitch">
      ${logo()}
      <h1>Score any sport. Put it on every screen.</h1>
      <p>Football to snooker, one scorer app. Pair a TV with a six-digit code and it follows the match on its own.</p>
    </section>
    <form class="card auth-card" id="auth">
      <h2>${mode === 'login' ? 'Sign in' : 'Create your organization'}</h2>
      ${mode === 'register' ? `<label>Club, school or league<input name="orgName" required autocomplete="organization"></label><label>Your name<input name="name" required autocomplete="name"></label>` : ''}
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Password<input name="password" type="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
      <button class="btn btn-primary">${mode === 'login' ? 'Sign in' : 'Create organization'}</button>
      <p class="muted">${mode === 'login' ? 'New here? <a href="#" data-mode="register">Create an organization</a>' : 'Already have an account? <a href="#" data-mode="login">Sign in</a>'}</p>
      <p class="muted">Setting up a TV? Open <a href="/tv">/tv</a> on it.</p>
    </form>
  </main>`;
  app.querySelector('[data-mode]')?.addEventListener('click', (e) => {
    e.preventDefault();
    renderAuth((e.target as HTMLElement).dataset.mode as any);
  });
  app.querySelector<HTMLFormElement>('#auth')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register', formData(e.target as HTMLFormElement));
      session.token = r.token;
      const next = params.get('next');
      if (next && next.startsWith('/')) location.href = next;
      else boot();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ------------------------------------------------------------------ shell
const NAV = [
  ['live', 'Live now'], ['matches', 'Matches'], ['tournaments', 'Tournaments'], ['screens', 'Screens'], ['venues', 'Venues & courts'], ['people', 'Teams & people'],
] as const;

function shell(active: string, body: string) {
  document.body.className = 'console';
  app.innerHTML = `
  <div class="shell">
    <aside class="nav">
      ${logo()}
      <p class="org-name">${esc(me.organization.name)}</p>
      <nav>${NAV.map(([id, label]) => `<a href="#${id}" class="${id === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="nav-foot"><span>${esc(me.user.name)}<small>${esc(me.user.role.replace('_', ' '))}</small></span><button class="link" data-cmd="logout">Sign out</button></div>
    </aside>
    <main class="main" id="main">${body}</main>
  </div>`;
  app.querySelector('[data-cmd="logout"]')!.addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    session.token = null;
    location.href = '/';
  });
}

async function route() {
  if (!me) return; // hash changes before sign-in completes are handled by boot()
  const page = (location.hash.slice(1) || 'live').split('/')[0];
  try {
    if (page === 'matches') await pageMatches();
    else if (page === 'tournaments') await pageTournaments();
    else if (page === 'screens') await pageScreens();
    else if (page === 'venues') await pageVenues();
    else if (page === 'people') await pagePeople();
    else await pageLive();
  } catch (e: any) {
    toast(e.message, 'error');
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ live now
async function pageLive() {
  const ms = await api<any[]>('GET', '/api/matches');
  const live = ms.filter((m) => m.status === 'live' || m.status === 'paused');
  const next = ms.filter((m) => m.status === 'scheduled').slice(0, 8);
  shell('live', `
    <header class="page-head"><h1>Live now</h1><a class="btn btn-primary" href="#matches">New match</a></header>
    ${live.length ? `<div class="tiles">${live.map(matchTile).join('')}</div>` : `<div class="empty-inline"><p>No matches are live. Start one from <a href="#matches">Matches</a>, or open a scheduled match below to score it.</p></div>`}
    <h2 class="section">Up next</h2>
    ${next.length ? `<ul class="rows">${next.map(matchRow).join('')}</ul>` : '<p class="muted">Nothing scheduled.</p>'}`);
  bindMatchButtons(ms);
  live.forEach((m) => rt?.sub(`match:${m.code}`));
}

function matchTile(m: any) {
  return `<article class="tile-card"><div data-live="${esc(m.code)}">${boardHtml({ ...m, display: m.display }, 'tile', { surface: surfaceName(m.surfaceId) })}</div>
    <div class="tile-actions"><a class="btn btn-primary" href="/score/${esc(m.id)}">Score</a><button class="btn" data-cast="${esc(m.id)}">Cast to TV</button><a class="btn" href="/live/${esc(m.code)}" target="_blank" rel="noopener">Public page</a></div></article>`;
}
function matchRow(m: any) {
  const names = m.participants.map((p: any) => p.name).join(' vs ');
  return `<li class="row"><span class="row-main"><strong>${esc(names)}</strong><small>${esc(sportName(m.sport))}${m.label ? `, ${esc(m.label)}` : ''}</small></span>
    <span class="row-meta">${esc(surfaceName(m.surfaceId) ?? '')}<small>${esc(fmtTime(m.scheduledAt))}</small></span>
    <span class="row-score">${m.status === 'scheduled' ? '' : `${esc(m.display.sides[0].score)}–${esc(m.display.sides[1].score)}`}</span>
    <span class="status status-${esc(m.status)}">${esc(m.status)}</span>
    <span class="row-actions"><a class="btn btn-small" href="/score/${esc(m.id)}">${m.status === 'completed' ? 'Review' : 'Score'}</a><button class="btn btn-small" data-cast="${esc(m.id)}">Cast</button></span></li>`;
}
const surfaceName = (sid?: string | null) => (sid ? surfaces().find((s) => s.id === sid)?.name ?? null : null);
function bindMatchButtons(ms: any[]) {
  document.querySelectorAll<HTMLButtonElement>('[data-cast]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = ms.find((x) => x.id === b.dataset.cast)!;
      openCastSheet({ id: m.id, code: m.code, title: m.participants.map((p: any) => p.name).join(' vs ') });
    }),
  );
}

// ------------------------------------------------------------------ matches
function sportFields(prefix = '') {
  return `<label>Sport<select name="${prefix}sport" data-sport>${sports.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label>Format<select name="${prefix}discipline" data-discipline></select></label>`;
}
function wireSport(form: HTMLElement) {
  const sSel = form.querySelector<HTMLSelectElement>('[data-sport]')!;
  const dSel = form.querySelector<HTMLSelectElement>('[data-discipline]')!;
  const fill = () => {
    const s = sports.find((x) => x.id === sSel.value)!;
    dSel.innerHTML = s.disciplines.map((d: any) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  };
  sSel.addEventListener('change', fill);
  fill();
}
function courtSelect(name = 'surfaceId') {
  return `<label>Court / table / field<select name="${name}"><option value="">None</option>${surfaces().map((s) => `<option value="${s.id}">${esc(s.venue)}: ${esc(s.name)}</option>`).join('')}</select></label>`;
}

async function pageMatches() {
  const [ms, users] = await Promise.all([api<any[]>('GET', '/api/matches'), api<any[]>('GET', '/api/users').catch(() => [])]);
  const scorers = users.filter((u) => ['scorer', 'referee', 'umpire'].includes(u.role));
  shell('matches', `
    <header class="page-head"><h1>Matches</h1></header>
    <details class="card create" ${ms.length ? '' : 'open'}><summary>New match</summary>
      <form id="new-match" class="form-grid">
        ${sportFields()}
        <label>Side 1<input name="a" required placeholder="Team or player"></label>
        <label>Side 2<input name="b" required placeholder="Team or player"></label>
        ${courtSelect()}
        <label>Starts<input name="scheduledAt" type="datetime-local"></label>
        <label>Scorer<select name="scorerUserId"><option value="">Anyone in the organization</option>${scorers.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
        <label>Visibility<select name="visibility"><option value="public">Public — anyone with the link</option><option value="private">Private — your screens and staff only</option></select></label>
        <div class="form-actions"><button class="btn btn-primary">Create match</button></div>
      </form>
    </details>
    <ul class="rows">${ms.map(matchRow).join('') || '<li class="muted">No matches yet.</li>'}</ul>`);
  const f = document.querySelector<HTMLFormElement>('#new-match')!;
  wireSport(f);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f);
    try {
      const m = await api('POST', '/api/matches', {
        sport: d.sport, discipline: d.discipline, participants: [{ name: d.a }, { name: d.b }], surfaceId: d.surfaceId || undefined,
        scheduledAt: d.scheduledAt ? new Date(d.scheduledAt).toISOString() : undefined, scorerUserId: d.scorerUserId || undefined, visibility: d.visibility,
      });
      toast('Match created');
      location.href = `/score/${m.id}`;
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  bindMatchButtons(ms);
}

// ------------------------------------------------------------------ tournaments
async function pageTournaments() {
  const [ts, teams] = await Promise.all([api<any[]>('GET', '/api/tournaments'), api<any[]>('GET', '/api/teams')]);
  const open = location.hash.split('/')[1];
  if (open) return tournamentDetail(open);
  shell('tournaments', `
    <header class="page-head"><h1>Tournaments</h1></header>
    <details class="card create" ${ts.length ? '' : 'open'}><summary>New tournament</summary>
      <form id="new-t" class="form-grid">
        <label class="wide">Name<input name="name" required placeholder="Winter Open 2026"></label>
        ${sportFields()}
        <label>Format<select name="format"><option value="round_robin">League (round robin)</option><option value="double_round_robin">League, home and away</option><option value="knockout">Knockout</option><option value="groups_knockout">Groups</option></select></label>
        <label>Venue<select name="venueId"><option value="">None</option>${venues.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
        <label class="wide">Entrants, one per line, in seed order${teams.length ? ' — or pick teams below' : ''}<textarea name="entrants" rows="6" placeholder="Aarav Shah\nDiya Patel\n…"></textarea></label>
        ${teams.length ? `<fieldset class="wide"><legend>Teams</legend><div class="checks">${teams.map((t) => `<label><input type="checkbox" name="team" value="${t.id}"> ${esc(t.name)}</label>`).join('')}</div></fieldset>` : ''}
        <div class="form-actions"><button class="btn btn-primary">Create tournament</button></div>
      </form>
    </details>
    <ul class="rows">${ts.map((t) => `<li class="row"><a class="row-main" href="#tournaments/${t.id}"><strong>${esc(t.name)}</strong><small>${esc(sportName(t.sport))}, ${esc(t.format.replace(/_/g, ' '))}</small></a><span class="status status-${esc(t.status)}">${esc(t.status)}</span><span class="row-actions"><a class="btn btn-small" href="/t/${esc(t.public_code)}" target="_blank" rel="noopener">Public page</a></span></li>`).join('') || '<li class="muted">No tournaments yet.</li>'}</ul>`);
  const f = document.querySelector<HTMLFormElement>('#new-t')!;
  wireSport(f);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f);
    const teamIds = [...f.querySelectorAll<HTMLInputElement>('input[name="team"]:checked')].map((x) => x.value);
    const names = (d.entrants ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    const entrants = [...teamIds.map((teamId) => ({ teamId })), ...names.map((name) => ({ name }))];
    try {
      const t = await api('POST', '/api/tournaments', { name: d.name, sport: d.sport, discipline: d.discipline, format: d.format, venueId: d.venueId || undefined, entrants });
      location.hash = `tournaments/${t.id}`;
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

async function tournamentDetail(tid: string) {
  const t = await api('GET', `/api/tournaments/${tid}`);
  const v = venues.find((x) => x.id === t.venue_id);
  shell('tournaments', `
    <header class="page-head"><div><a class="crumb" href="#tournaments">Tournaments</a><h1>${esc(t.name)}</h1><p class="muted">${esc(sportName(t.sport))}, ${esc(t.format.replace(/_/g, ' '))}, ${t.entrants.length} entrants</p></div>
      <div class="head-actions"><a class="btn" href="/t/${esc(t.public_code)}" target="_blank" rel="noopener">Public page</a><a class="btn" href="/tv/t/${esc(t.public_code)}" target="_blank" rel="noopener">Tournament TV board</a></div></header>
    ${!t.matches.length ? `<form id="gen" class="card form-grid"><h2 class="wide">Generate fixtures</h2>
      <label>First match<input type="datetime-local" name="startAt" required></label><label>Minutes per match slot<input type="number" name="slotMinutes" value="30" min="5"></label>
      ${v ? `<fieldset class="wide"><legend>Courts to use at ${esc(v.name)}</legend><div class="checks">${v.surfaces.map((s: any) => `<label><input type="checkbox" name="surface" value="${s.id}" checked> ${esc(s.name)}</label>`).join('')}</div></fieldset>` : '<p class="wide muted">No venue set — fixtures will be created without courts or times.</p>'}
      <div class="form-actions"><button class="btn btn-primary">Generate fixtures</button></div></form>` : ''}
    ${t.standings.tables.map((g: any) => `<section class="card"><h2>${g.group ? `Group ${esc(g.group)}` : 'Standings'}</h2><table class="table"><thead><tr><th>#</th><th>Entrant</th><th>P</th><th>W</th><th>D</th><th>L</th><th>For</th><th>Agst</th><th>+/−</th>${g.rows.some((r: any) => r.nrr != null) ? '<th>NRR</th>' : ''}<th>Pts</th></tr></thead><tbody>${g.rows.map((r: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td><td>${r.for}</td><td>${r.against}</td><td>${r.diff}</td>${r.nrr != null ? `<td>${r.nrr}</td>` : ''}<td><strong>${r.points}</strong></td></tr>`).join('')}</tbody></table></section>`).join('')}
    <h2 class="section">Fixtures</h2><ul class="rows">${t.matches.map(matchRow).join('') || '<li class="muted">Generate fixtures to see them here.</li>'}</ul>`);
  document.querySelector<HTMLFormElement>('#gen')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const d = formData(f);
    const surfaceIds = [...f.querySelectorAll<HTMLInputElement>('input[name="surface"]:checked')].map((x) => x.value);
    try {
      const r = await api('POST', `/api/tournaments/${tid}/generate`, { startAt: new Date(d.startAt).toISOString(), slotMinutes: Number(d.slotMinutes), surfaceIds });
      toast(`${r.created} matches scheduled`);
      tournamentDetail(tid);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  bindMatchButtons(t.matches);
}

// ------------------------------------------------------------------ screens
let screensTimer: any = null;
async function pageScreens() {
  const [ds, ms, ts, pls] = await Promise.all([api<any[]>('GET', '/api/displays'), api<any[]>('GET', '/api/matches'), api<any[]>('GET', '/api/tournaments'), api<any[]>('GET', '/api/playlists')]);
  const openMs = ms.filter((m) => m.status !== 'completed' && m.status !== 'abandoned');
  const mLabel = (m: any) => `${m.participants.map((p: any) => p.name).join(' vs ')} (${sportName(m.sport)}${surfaceName(m.surfaceId) ? `, ${surfaceName(m.surfaceId)}` : ''})`;
  const counts = { online: ds.filter((d) => d.status === 'online').length, total: ds.length };
  shell('screens', `
    <header class="page-head"><div><h1>Screens</h1><p class="muted">${counts.online} of ${counts.total} online</p></div><button class="btn btn-primary" data-cmd="pair">Pair a screen</button></header>
    <form id="announce" class="card announce-form"><label class="grow">Message to every screen<input name="text" required maxlength="200" placeholder="Court 3 is closed for 10 minutes"></label>
      <label>Type<select name="level"><option value="notice">Notice</option><option value="emergency">Emergency</option><option value="sponsor">Sponsor</option></select></label>
      <label>Show for<select name="seconds"><option value="30">30 s</option><option value="60" selected>1 min</option><option value="300">5 min</option><option value="900">15 min</option></select></label>
      <button class="btn btn-danger">Send now</button></form>
    ${ds.length ? `<ul class="screens">${ds.map((d) => `
      <li class="screen card" data-id="${esc(d.id)}">
        <header><span class="dot dot-${esc(d.status)}" aria-label="${esc(d.status)}"></span><input class="screen-name" value="${esc(d.name)}" aria-label="Screen name"><span class="muted">${esc(d.status)}${d.lastHeartbeat ? `, seen ${new Date(d.lastHeartbeat).toLocaleTimeString()}` : ''}</span></header>
        <p class="assigned">${esc(d.assignmentLabel)}</p>
        <div class="screen-ctl">
          <select data-assign aria-label="What this screen shows" ${d.locked ? 'disabled' : ''}>
            <option value="">Change what it shows…</option>
            <optgroup label="One match">${openMs.map((m) => `<option value="match:${m.id}">${esc(mLabel(m))}</option>`).join('')}</optgroup>
            <optgroup label="Every court at a venue">${venues.map((v) => `<option value="venue:${v.id}">${esc(v.name)}</option>`).join('')}</optgroup>
            <optgroup label="Tournament">${ts.flatMap((t) => [`<option value="tournament:${t.id}:standings">${esc(t.name)}: standings</option>`]).join('')}</optgroup>
            <optgroup label="Playlist">${pls.map((p) => `<option value="playlist:${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>
            <option value="multi">All live matches</option><option value="idle">Nothing (logo)</option>
          </select>
          <select data-orient aria-label="Orientation"><option value="landscape" ${d.orientation === 'landscape' ? 'selected' : ''}>Landscape</option><option value="portrait" ${d.orientation === 'portrait' ? 'selected' : ''}>Portrait</option></select>
          <button class="btn btn-small" data-act="lock">${d.locked ? 'Unlock' : 'Lock'}</button>
          <button class="btn btn-small" data-act="refresh">Reload screen</button>
          <button class="btn btn-small btn-quiet" data-act="unpair">Unpair</button>
        </div>
      </li>`).join('')}</ul>` : `<div class="empty-inline"><p>No screens yet. On any TV, smart-TV browser or HDMI laptop, open <code>${esc(location.host)}/tv</code>. It shows a six-digit code — choose <strong>Pair a screen</strong> and enter it.</p></div>`}
    ${pls.length || ms.length ? `<details class="card"><summary>New playlist</summary><form id="pl" class="form-grid">
      <label class="wide">Name<input name="name" required placeholder="Lobby loop"></label>
      <label>Live match (optional)<select name="match"><option value="">—</option>${openMs.map((m) => `<option value="${m.id}">${esc(mLabel(m))}</option>`).join('')}</select></label>
      <label>Venue courts (optional)<select name="venue"><option value="">—</option>${venues.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
      <label>Standings (optional)<select name="tournament"><option value="">—</option>${ts.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
      <label>Seconds per view<input type="number" name="seconds" value="12" min="3" max="600"></label>
      <fieldset class="wide"><div class="checks"><label><input type="checkbox" name="upcoming" checked> Upcoming matches</label><label><input type="checkbox" name="sponsor" checked> Sponsors</label></div></fieldset>
      <div class="form-actions"><button class="btn btn-primary">Save playlist</button></div></form></details>` : ''}`);

  const assign = async (did: string, body: any) => {
    try {
      await api('PATCH', `/api/displays/${did}`, body);
      toast('Screen updated');
      pageScreens();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  document.querySelectorAll<HTMLElement>('.screen').forEach((el) => {
    const did = el.dataset.id!;
    el.querySelector<HTMLSelectElement>('[data-assign]')!.addEventListener('change', (e) => {
      const [kind, ref, view] = (e.target as HTMLSelectElement).value.split(':');
      if (!kind) return;
      const a =
        kind === 'match' ? { mode: 'match', matchId: ref } :
        kind === 'venue' ? { mode: 'venue', venueId: ref } :
        kind === 'tournament' ? { mode: 'tournament', tournamentId: ref, view } :
        kind === 'playlist' ? { mode: 'playlist', playlistId: ref } :
        kind === 'multi' ? { mode: 'multi', matchIds: ms.filter((m) => m.status === 'live').slice(0, 16).map((m) => m.id), title: 'Live now' } : { mode: 'idle' };
      if (a.mode === 'multi' && !(a as any).matchIds.length) return toast('No matches are live right now', 'error');
      assign(did, { assignment: a });
    });
    el.querySelector<HTMLSelectElement>('[data-orient]')!.addEventListener('change', (e) => assign(did, { orientation: (e.target as HTMLSelectElement).value }));
    el.querySelector<HTMLInputElement>('.screen-name')!.addEventListener('change', (e) => assign(did, { name: (e.target as HTMLInputElement).value }));
    el.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', async () => {
        const act = b.dataset.act;
        if (act === 'lock') return assign(did, { locked: b.textContent === 'Lock' });
        if (act === 'unpair' && !confirm('Unpair this screen? It will show a new pairing code.')) return;
        try {
          await api('POST', `/api/displays/${did}/${act}`, {});
          toast(act === 'refresh' ? 'Reload sent' : 'Screen unpaired');
          if (act === 'unpair') pageScreens();
        } catch (e: any) {
          toast(e.message, 'error');
        }
      }),
    );
  });
  document.querySelector('[data-cmd="pair"]')!.addEventListener('click', () => pairDialog());
  document.querySelector<HTMLFormElement>('#announce')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target as HTMLFormElement);
    try {
      await api('POST', '/api/displays/announce', { text: d.text, level: d.level, seconds: Number(d.seconds) });
      toast('Sent to all screens');
      (e.target as HTMLFormElement).reset();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  document.querySelector<HTMLFormElement>('#pl')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const d = formData(f);
    const s = Number(d.seconds) || 12;
    const items: any[] = [];
    if (d.match) items.push({ kind: 'match', matchId: d.match, seconds: s * 2 });
    if (d.venue) items.push({ kind: 'venue', venueId: d.venue, seconds: s * 2 });
    if (d.tournament) items.push({ kind: 'standings', tournamentId: d.tournament, seconds: s });
    if (f.querySelector<HTMLInputElement>('[name="upcoming"]')!.checked) items.push({ kind: 'upcoming', seconds: s });
    if (f.querySelector<HTMLInputElement>('[name="sponsor"]')!.checked) items.push({ kind: 'sponsor', seconds: Math.max(5, Math.round(s / 2)) });
    try {
      await api('POST', '/api/playlists', { name: d.name, items });
      toast('Playlist saved — assign it to a screen');
      pageScreens();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  clearTimeout(screensTimer);
  screensTimer = setTimeout(() => location.hash === '#screens' && !document.querySelector('dialog[open]') && !document.activeElement?.closest('form, .screen') && pageScreens(), 8000);
}

function pairDialog(code = '') {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form method="dialog" class="sheet-body">
    <header class="sheet-head"><h2>Pair a screen</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></header>
    <p class="muted">Open <code>${esc(location.host)}/tv</code> on the screen and type the code it shows.</p>
    <label>Code on the screen<input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" value="${esc(code)}"></label>
    <label>Name<input name="name" placeholder="Court 1 TV"></label>
    <label>Venue<select name="venueId"><option value="">—</option>${venues.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
    <div class="sheet-actions"><button class="btn btn-primary" value="ok">Pair screen</button></div></form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') {
      const d = formData(dlg.querySelector('form')!);
      try {
        const r = await api('POST', '/api/displays/pair', { code: d.code, name: d.name || undefined, venueId: d.venueId || undefined, assignment: d.venueId ? { mode: 'venue', venueId: d.venueId } : undefined });
        toast(`${r.name} paired`);
        history.replaceState(null, '', '/#screens');
        pageScreens();
      } catch (e: any) {
        toast(e.message, 'error');
      }
    }
    dlg.remove();
  });
  dlg.showModal();
}

// ------------------------------------------------------------------ venues
async function pageVenues() {
  venues = await api('GET', '/api/venues');
  shell('venues', `
    <header class="page-head"><h1>Venues and courts</h1></header>
    <details class="card create" ${venues.length ? '' : 'open'}><summary>New venue</summary>
      <form id="new-v" class="form-grid">
        <label>Name<input name="name" required placeholder="Sports Complex"></label>
        <label>Address<input name="address"></label>
        <label class="wide">Courts, tables and fields, one per line<textarea name="surfaces" rows="5" placeholder="Court 1\nCourt 2\nSnooker Table 1"></textarea></label>
        <div class="form-actions"><button class="btn btn-primary">Create venue</button></div>
      </form>
    </details>
    ${venues.map((v) => `<section class="card venue"><header class="venue-head"><h2>${esc(v.name)}</h2><span class="muted">${esc(v.address ?? '')}</span></header>
      <ul class="chips">${v.surfaces.map((s: any) => `<li>${esc(s.name)}</li>`).join('')}</ul>
      <form class="inline-add" data-venue="${v.id}"><input name="name" required placeholder="Add a court, table or field" aria-label="New court name"><select name="kind" aria-label="Type"><option value="court">Court</option><option value="table">Table</option><option value="field">Field</option></select><button class="btn btn-small">Add</button></form></section>`).join('')}`);
  document.querySelector<HTMLFormElement>('#new-v')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target as HTMLFormElement);
    const lines = d.surfaces.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await api('POST', '/api/venues', { name: d.name, address: d.address || undefined, surfaces: lines.map((name) => ({ name, kind: /table/i.test(name) ? 'table' : /field|pitch|ground/i.test(name) ? 'field' : 'court' })) });
      toast('Venue created');
      pageVenues();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  document.querySelectorAll<HTMLFormElement>('.inline-add').forEach((f) =>
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/venues/${f.dataset.venue}/surfaces`, formData(f));
        pageVenues();
      } catch (err: any) {
        toast(err.message, 'error');
      }
    }),
  );
}

// ------------------------------------------------------------------ people
async function pagePeople() {
  const [teams, players, users] = await Promise.all([api<any[]>('GET', '/api/teams'), api<any[]>('GET', '/api/players'), api<any[]>('GET', '/api/users').catch(() => null)]);
  shell('people', `
    <header class="page-head"><h1>Teams and people</h1></header>
    <div class="two-col">
      <section class="card"><h2>Teams</h2>
        <form id="new-team" class="form-grid"><label>Name<input name="name" required></label><label>Short name<input name="short" maxlength="6"></label>
          <label>Sport<select name="sport">${sports.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
          <label class="wide">Players, one per line — number then name<textarea name="roster" rows="4" placeholder="10 Sunil Chhetri\n1 Gurpreet Singh"></textarea></label>
          <div class="form-actions"><button class="btn btn-primary">Add team</button></div></form>
        <ul class="rows compact">${teams.map((t) => `<li class="row"><span class="row-main"><strong>${esc(t.name)}</strong><small>${t.players} players${t.sport ? `, ${esc(sportName(t.sport))}` : ''}</small></span></li>`).join('')}</ul>
      </section>
      <section class="card"><h2>Players</h2>
        <form id="new-player" class="form-grid"><label>Name<input name="name" required></label><label>City<input name="city"></label>
          <div class="form-actions"><button class="btn btn-primary">Add player</button></div></form>
        <ul class="rows compact">${players.slice(0, 200).map((p) => `<li class="row"><span class="row-main"><strong>${esc(p.name)}</strong><small>${esc([p.city, Object.entries(p.rating ?? {}).map(([s, r]) => `${sportName(s)} ${r}`).join(', ')].filter(Boolean).join(' · '))}</small></span></li>`).join('')}</ul>
      </section>
      ${users ? `<section class="card"><h2>Staff accounts</h2>
        <form id="new-user" class="form-grid"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
          <label>Temporary password<input name="password" type="text" minlength="8" required></label>
          <label>Role<select name="role"><option value="scorer">Scorer</option><option value="referee">Referee</option><option value="umpire">Umpire</option><option value="tournament_admin">Tournament admin</option><option value="coach">Coach</option><option value="team_manager">Team manager</option><option value="org_admin">Organization admin</option></select></label>
          <div class="form-actions"><button class="btn btn-primary">Add account</button></div></form>
        <ul class="rows compact">${users.map((u) => `<li class="row"><span class="row-main"><strong>${esc(u.name)}</strong><small>${esc(u.email)}, ${esc(u.role.replace('_', ' '))}</small></span></li>`).join('')}</ul>
      </section>` : ''}
    </div>`);
  const submit = (sel: string, fn: (d: Record<string, string>) => Promise<any>, done: string) =>
    document.querySelector<HTMLFormElement>(sel)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await fn(formData(e.target as HTMLFormElement));
        toast(done);
        pagePeople();
      } catch (err: any) {
        toast(err.message, 'error');
      }
    });
  submit('#new-team', (d) => api('POST', '/api/teams', {
    name: d.name, short: d.short || undefined, sport: d.sport,
    players: d.roster.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(\d+)\s+(.+)$/);
      return m ? { number: m[1], name: m[2] } : { name: l };
    }),
  }), 'Team added');
  submit('#new-player', (d) => api('POST', '/api/players', { name: d.name, city: d.city || undefined }), 'Player added');
  submit('#new-user', (d) => api('POST', '/api/users', d), 'Account created — share the email and temporary password with them');
}

// ------------------------------------------------------------------ boot
async function boot() {
  if (!session.token) return renderAuth();
  try {
    [me, sports, venues] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/sports'), api('GET', '/api/venues')]);
  } catch {
    return renderAuth();
  }
  rt = new Realtime(session.token);
  startClockTicker(() => rt!.serverNow());
  // One listener for the whole session: live tiles update in place wherever they are shown.
  rt.on((msg) => {
    if (msg.t !== 'match') return;
    const host = document.querySelector<HTMLElement>(`[data-live="${msg.match.code}"]`);
    if (host) host.innerHTML = boardHtml(msg.match, 'tile', { surface: msg.match.surface });
  });
  if (location.pathname === '/pair') {
    location.hash = 'screens';
    await route();
    return pairDialog(params.get('code') ?? '');
  }
  route();
}
boot();
