/**
 * Offline-first scorer.
 *
 * The scoring device runs the SAME rule engine as the server. Every tap is validated and
 * applied locally first (instant feedback, works with no signal), queued with a stable
 * event id + idempotency key, and flushed in order when the network allows. The server
 * re-validates against the authoritative log; anything it refuses comes back as a
 * conflict for the scorer to review instead of silently changing the score.
 */
import '../../../packages/engine/src/index.ts';
import { MatchAggregate, type EventInput, type MatchEvent, type ScorerAction } from '../../../packages/engine/src/index.ts';
import { api, session, toast, uuid } from './lib/api.ts';
import { esc, renderBoard, startClockTicker } from './lib/board.ts';
import { Realtime } from './lib/rt.ts';
import { openCastSheet } from './lib/cast.ts';

interface Saved {
  def: any;
  code: string;
  title: string;
  meta: any;
  serverEvents: MatchEvent[];
  pending: (EventInput & { id: string; clientEventId: string; deviceTime: string })[];
  conflicts: { input: EventInput; error: string; at: string }[];
}

if (!session.token) location.href = `/?next=${encodeURIComponent(location.pathname)}`;
const matchId = location.pathname.split('/')[2];
const KEY = `arena.score.${matchId}`;
const app = document.getElementById('app')!;
let saved: Saved | null = load();
let agg: MatchAggregate | null = null;
let flushing = false;
let retryMs = 1000;
let retryTimer: any = null;
let online = navigator.onLine;
const rt = new Realtime(session.token);
startClockTicker(() => rt.serverNow());

function load(): Saved | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    toast('Device storage is full — scoring continues, but offline safety is reduced', 'error');
  }
}

const lastSeq = () => (saved?.serverEvents.length ? saved.serverEvents[saved.serverEvents.length - 1].seq : 0);

/** Local state = authoritative server log + this device's queued events. */
function rebuild() {
  if (!saved) return;
  agg = new MatchAggregate(saved.def, saved.serverEvents);
  const keep: Saved['pending'] = [];
  for (const p of saved.pending) {
    try {
      agg.append(agg.createEvent(p, p.deviceTime));
      keep.push(p);
    } catch (e: any) {
      saved.conflicts.push({ input: p, error: e.message, at: new Date().toISOString() });
    }
  }
  saved.pending = keep;
}

async function refreshFromServer() {
  try {
    const r = await api('GET', `/api/matches/${matchId}`);
    const events = await api<MatchEvent[]>('GET', `/api/matches/${matchId}/events`);
    const m = r.match;
    saved = {
      def: { id: m.id, sport: m.sport, discipline: m.discipline, config: m.config, participants: m.participants },
      code: m.code,
      title: m.participants.map((p: any) => p.name).join(' vs '),
      meta: r.meta,
      serverEvents: events,
      pending: saved?.pending ?? [],
      conflicts: saved?.conflicts ?? [],
    };
    rebuild();
    save();
    rt.sub(`match:${m.code}`);
    online = true;
    render();
    flush();
  } catch (e: any) {
    online = false;
    if (!saved) app.innerHTML = `<div class="empty"><h1>Can't load this match</h1><p>${esc(e.message)}</p><p>Reconnect to the internet to open a match for the first time on this device. After that, it works offline.</p><a class="btn" href="/">Back to console</a></div>`;
    else render();
    setTimeout(refreshFromServer, 5000);
  }
}

/** Send queued events in order. Safe to call any time; retries with backoff. */
async function flush() {
  if (!saved || flushing || !saved.pending.length) return;
  flushing = true;
  const batch = saved.pending.slice(0, 200);
  const since = lastSeq();
  try {
    const r = await api('POST', `/api/matches/${matchId}/events`, { events: batch, since });
    online = true;
    retryMs = 1000;
    const done = new Set<string>();
    for (const res of r.results) {
      done.add(res.clientEventId);
      if (res.status === 'rejected') {
        const input = batch.find((b) => b.clientEventId === res.clientEventId)!;
        saved.conflicts.push({ input, error: res.error, at: new Date().toISOString() });
        toast(`Not recorded: ${res.error}`, 'error');
      }
    }
    saved.serverEvents = saved.serverEvents.filter((e) => e.seq <= since).concat(r.events);
    saved.pending = saved.pending.filter((p) => !done.has(p.clientEventId));
    rebuild();
    save();
  } catch (e: any) {
    if (e.status && e.status < 500 && e.status !== 429) {
      // Permanent refusal (e.g. permission): surface it, don't spin.
      for (const p of batch) saved.conflicts.push({ input: p, error: e.message, at: new Date().toISOString() });
      saved.pending = saved.pending.filter((p) => !batch.includes(p));
      rebuild();
      save();
      toast(e.message, 'error');
    } else {
      online = false;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    }
  } finally {
    flushing = false;
    render();
    if (saved.pending.length && online) flush();
  }
}

/** Another device scored: pull new events (unless we have our own in flight). */
rt.on(async (m) => {
  if (m.t !== 'match' || !saved || m.match.code !== saved.code) return;
  if (m.match.display.version <= lastSeq()) return;
  if (saved.pending.length) return flush();
  try {
    const evs = await api<MatchEvent[]>('GET', `/api/matches/${matchId}/events?since=${lastSeq()}`);
    saved.serverEvents.push(...evs);
    rebuild();
    save();
    render();
  } catch { /* next update will catch up */ }
});
rt.onState((s) => {
  if (s === 'connected') {
    online = true;
    flush();
  }
});
window.addEventListener('online', () => ((online = true), flush()));
window.addEventListener('offline', () => ((online = false), render()));

function record(input: EventInput) {
  if (!saved || !agg) return;
  const p = { ...input, id: uuid(), clientEventId: uuid(), deviceTime: new Date(rt.serverNow()).toISOString() };
  try {
    agg.append(agg.createEvent(p, p.deviceTime));
  } catch (e: any) {
    toast(e.message, 'error');
    navigator.vibrate?.([30, 40, 30]);
    return;
  }
  navigator.vibrate?.(12);
  saved.pending.push(p);
  save();
  render();
  flush();
}

// ---------------------------------------------------------------- rendering
function syncLabel() {
  const n = saved?.pending.length ?? 0;
  if (!online) return { cls: 'sync-offline', text: n ? `Offline · ${n} saved on this device` : 'Offline' };
  if (n) return { cls: 'sync-pending', text: `Sending ${n}…` };
  return { cls: 'sync-ok', text: 'All saved' };
}

function parseValue(v: string): any {
  if (v === '') return undefined;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}
function setPath(obj: any, key: string, val: any) {
  if (val === undefined) return;
  const parts = key.split('.');
  let o = obj;
  parts.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
  o[parts[parts.length - 1]] = val;
}

function actionButton(a: ScorerAction, i: number) {
  return `<button class="act act-${a.group} tone-${a.tone ?? 'neutral'}" data-i="${i}">${esc(a.label)}${a.inputs?.some((x) => !x.optional) ? '<span class="more" aria-hidden="true">…</span>' : ''}</button>`;
}

function render() {
  if (!saved || !agg) return;
  const view = { code: saved.code, status: agg.status, display: agg.display(), surface: saved.meta?.surface, tournament: saved.meta?.tournament, label: saved.meta?.label };
  const acts = agg.actions();
  const sync = syncLabel();
  const side = (s: 0 | 1) => acts.map((a, i) => [a, i] as const).filter(([a]) => a.group === 'primary' && a.side === s);
  const center = acts.map((a, i) => [a, i] as const).filter(([a]) => (a.group === 'primary' && a.side == null) || a.group === 'setup');
  const group = (g: string) => acts.map((a, i) => [a, i] as const).filter(([a]) => a.group === g);
  const timeline = agg.timeline.slice(-12).reverse();
  const focus = (document.activeElement as HTMLElement | null)?.dataset?.i;
  app.innerHTML = `
    <header class="score-top">
      <a class="back" href="/" aria-label="Back to console">‹</a>
      <div class="score-title"><strong>${esc(saved.title)}</strong><span>${esc([agg.engine.name, saved.meta?.surface].filter(Boolean).join(', '))} <b class="sync ${sync.cls}" role="status">${esc(sync.text)}</b></span></div>
      <button class="btn btn-cast" data-cmd="cast">Cast to TV</button>
    </header>
    <section class="score-board" id="board"></section>
    <nav class="score-tools">
      <button class="btn" data-cmd="undo" ${agg.lastUndoable() ? '' : 'disabled'}>Undo</button>
      <button class="btn" data-cmd="redo" ${agg.redoTarget() ? '' : 'disabled'}>Redo</button>
      <a class="btn" href="/live/${esc(saved.code)}" target="_blank" rel="noopener">Public page</a>
    </nav>
    ${saved.conflicts.length ? `<section class="conflicts" role="alert"><h2>Needs review</h2><p>These actions were not recorded because the match had moved on. Re-enter them if they still apply.</p><ul>${saved.conflicts.slice(-5).reverse().map((c) => `<li><strong>${esc(c.input.type)}</strong> ${esc(JSON.stringify(c.input.payload ?? {}))} — ${esc(c.error)}</li>`).join('')}</ul><button class="btn" data-cmd="clear-conflicts">Dismiss</button></section>` : ''}
    ${agg.issues.length ? `<section class="conflicts"><h2>Corrections changed later events</h2><p>${agg.issues.length} later event(s) no longer apply after a correction and are excluded from the score.</p></section>` : ''}
    <section class="pad">
      ${side(0).length ? `<div class="pad-side side-0"><h2>${esc(saved.def.participants[0].name)}</h2>${side(0).map(([a, i]) => actionButton(a, i)).join('')}</div>` : ''}
      ${center.length ? `<div class="pad-center">${center.map(([a, i]) => actionButton(a, i)).join('')}</div>` : ''}
      ${side(1).length ? `<div class="pad-side side-1"><h2>${esc(saved.def.participants[1].name)}</h2>${side(1).map(([a, i]) => actionButton(a, i)).join('')}</div>` : ''}
    </section>
    ${[['secondary', 'More actions'], ['stat', 'Statistics'], ['control', 'Match control']].map(([g, label]) => group(g).length ? `<details class="drawer" ${g === 'control' ? 'open' : ''}><summary>${label}</summary><div class="drawer-grid">${group(g).map(([a, i]) => actionButton(a, i)).join('')}</div></details>` : '').join('')}
    <section class="timeline"><h2>Timeline</h2><ol>${timeline.map((tl) => `<li><span>${esc(tl.text)}</span></li>`).join('') || '<li class="muted">Nothing recorded yet.</li>'}</ol></section>`;
  renderBoard(document.getElementById('board')!, view, 'page');
  app.querySelectorAll<HTMLButtonElement>('.act').forEach((b) => b.addEventListener('click', () => onAction(acts[Number(b.dataset.i)])));
  if (focus != null) app.querySelector<HTMLElement>(`[data-i="${focus}"]`)?.focus();
}

app.addEventListener('click', (e) => {
  const cmd = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
  if (!cmd || !agg || !saved) return;
  if (cmd === 'undo') {
    const u = agg.undoInput();
    if (u) record(u);
  } else if (cmd === 'redo') {
    const r = agg.redoInput();
    if (r) record(r);
  } else if (cmd === 'cast') openCastSheet({ id: matchId, code: saved.code, title: saved.title });
  else if (cmd === 'clear-conflicts') {
    saved.conflicts = [];
    save();
    render();
  }
});

function onAction(a: ScorerAction) {
  if (a.type === 'MATCH_ABANDON' && !confirm('Abandon this match? It can be undone, but every screen will show it as abandoned.')) return;
  // Optional details (scorer, how the point was won) never slow live scoring: a tap records
  // immediately; a long-press opens the detail form. Required inputs always open the form.
  if (a.inputs?.some((x) => !x.optional)) return openForm(a);
  record({ type: a.type, payload: { ...(a.payload ?? {}) } });
}

let longPressed = false;
let pressTimer: any = null;
app.addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.act');
  longPressed = false;
  if (!b || !agg) return;
  const a = agg.actions()[Number(b.dataset.i)];
  if (!a?.inputs?.length) return;
  pressTimer = setTimeout(() => {
    longPressed = true;
    navigator.vibrate?.(25);
    openForm(a);
  }, 450);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => app.addEventListener(ev, () => clearTimeout(pressTimer)));
// The click that ends a long-press must not also record a plain event.
app.addEventListener('click', (e) => {
  if (longPressed && (e.target as HTMLElement).closest('.act')) {
    e.stopImmediatePropagation();
    longPressed = false;
  }
}, true);

function openForm(a: ScorerAction) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet action-form';
  dlg.innerHTML = `<form method="dialog" class="sheet-body">
    <header class="sheet-head"><h2>${esc(a.label)}</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></header>
    ${a.inputs!.map((inp, k) => {
      const id = `f${k}`;
      const req = inp.optional ? '' : 'required';
      let control: string;
      if ((inp.kind === 'select' || inp.kind === 'player') && inp.options?.length)
        control = `<select id="${id}" name="${esc(inp.key)}" ${req}>${inp.optional || inp.default == null ? '<option value="">—</option>' : ''}${inp.options.map((o) => `<option value="${esc(o.value)}" ${String(inp.default ?? '') === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      else if (inp.kind === 'number') control = `<input id="${id}" name="${esc(inp.key)}" type="number" inputmode="numeric" value="${esc(inp.default ?? '')}" ${req}>`;
      else control = `<input id="${id}" name="${esc(inp.key)}" type="text" value="${esc(inp.default ?? '')}" ${req} placeholder="${inp.kind === 'player' ? 'Player name' : ''}">`;
      return `<label for="${id}">${esc(inp.label)}${inp.optional ? ' <span class="muted">(optional)</span>' : ''}</label>${control}`;
    }).join('')}
    <div class="sheet-actions"><button class="btn btn-primary" value="ok">Record</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'ok') {
      const payload: any = JSON.parse(JSON.stringify(a.payload ?? {}));
      dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]').forEach((el) => {
        const v = parseValue(el.value.trim());
        if (v !== undefined) setPath(payload, el.name, el.type === 'text' ? el.value.trim() : v);
      });
      record({ type: a.type, payload });
    }
    dlg.remove();
  });
  dlg.showModal();
  dlg.querySelector<HTMLElement>('select, input')?.focus();
}

// ---------------------------------------------------------------- boot
if (saved) {
  rebuild();
  render();
  rt.sub(`match:${saved.code}`);
}
refreshFromServer();
