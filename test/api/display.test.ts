import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, registerOrg, pairTv, Socket, type Harness } from './harness.ts';

let h: Harness;
let admin: string;
before(async () => {
  h = await start();
  admin = await registerOrg(h);
});
after(async () => h.close());

const mkMatch = (sport = 'basketball', discipline = '5x5', a = 'Tigers', b = 'Hawks') =>
  h.api('POST', '/api/matches', { sport, discipline, participants: [{ name: a }, { name: b }] }, admin);
const ev = (id: string, type: string, payload: any = {}, clientEventId?: string) => h.api('POST', `/api/matches/${id}/events`, { type, payload, clientEventId }, admin);

test('pairing: unpaired TV shows a 6-digit PIN; wrong PIN is rejected; PIN pairs exactly once', async () => {
  const reg = await h.api('POST', '/api/displays/register', {});
  assert.match(reg.pairingCode, /^\d{6}$/);
  await assert.rejects(h.api('POST', '/api/displays/pair', { code: '000000x' }, admin), /not found/);
  const tv = new Socket(h.wsUrl);
  await tv.opened;
  tv.send({ t: 'display.hello', deviceId: reg.deviceId, secret: reg.secret });
  const cfg = await tv.next((m) => m.t === 'display.config', 2000, true);
  assert.equal(cfg.device.paired, false);
  assert.equal(cfg.device.pairingCode, reg.pairingCode);
  await h.api('POST', '/api/displays/pair', { code: reg.pairingCode, name: 'Court 9' }, admin);
  await assert.rejects(h.api('POST', '/api/displays/pair', { code: reg.pairingCode }, admin), /not found/);
  // wrong secret cannot impersonate the device
  const evil = new Socket(h.wsUrl);
  await evil.opened;
  evil.send({ t: 'display.hello', deviceId: reg.deviceId, secret: 'nope' });
  await evil.next((m) => m.t === 'display.unknown');
  tv.close();
  evil.close();
});

test('TV: score change reaches the screen without refresh; reconnect restores latest state', async () => {
  const m = await mkMatch();
  const { tv, deviceId, secret } = await pairTv(h, admin, 'Court 1', { mode: 'match', matchId: m.id });
  await ev(m.id, 'MATCH_START');
  await ev(m.id, 'PERIOD_START');
  const got = tv.next((x) => x.t === 'match' && x.match.display.sides[0].score === '3');
  await ev(m.id, 'SCORE', { side: 0, points: 3 });
  await got;

  // Network drops: TV goes away, scoring continues
  tv.close();
  await ev(m.id, 'SCORE', { side: 1, points: 2 });
  await ev(m.id, 'SCORE', { side: 1, points: 2 });

  // Network returns: TV reconnects with its stored credentials and gets authoritative state
  const tv2 = new Socket(h.wsUrl);
  await tv2.opened;
  tv2.send({ t: 'display.hello', deviceId, secret });
  const cfg = await tv2.next((x) => x.t === 'display.config', 2000, true);
  const view = cfg.matches[cfg.views[0].match];
  assert.equal(view.display.sides[0].score, '3');
  assert.equal(view.display.sides[1].score, '4');
  // …and keeps receiving live updates after reconnecting
  const live = tv2.next((x) => x.t === 'match' && x.match.display.sides[1].score === '7');
  await ev(m.id, 'SCORE', { side: 1, points: 3 });
  await live;
  tv2.close();
});

test('one match on multiple TVs; reassigning a TV switches its feed', async () => {
  const m1 = await mkMatch('tennis', 'singles', 'Rao', 'Iyer');
  const m2 = await mkMatch('padel', 'doubles', 'Shah / Jain', 'Bose / Das');
  const a = await pairTv(h, admin, 'Lobby A', { mode: 'match', matchId: m1.id });
  const b = await pairTv(h, admin, 'Lobby B', { mode: 'match', matchId: m1.id });
  await ev(m1.id, 'MATCH_START');
  const both = [a, b].map((x) => x.tv.next((msg) => msg.t === 'match' && msg.match.display.sides[0].score === '15'));
  await ev(m1.id, 'POINT', { side: 0 });
  await Promise.all(both);

  const switched = b.tv.next((msg) => msg.t === 'display.config' && msg.views[0].match === m2.code);
  await h.api('PATCH', `/api/displays/${b.deviceId}`, { assignment: { mode: 'match', matchId: m2.id } }, admin);
  await switched;
  // B no longer receives m1 updates; A still does
  b.tv.messages.length = 0;
  const aGot = a.tv.next((msg) => msg.t === 'match' && msg.match.display.sides[0].score === '30');
  await ev(m1.id, 'POINT', { side: 0 });
  await aGot;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.tv.messages.filter((x) => x.t === 'match' && x.match.code === m1.code).length, 0);
  a.tv.close();
  b.tv.close();
});

test('10 simultaneous matches, 10 TVs, plus one master TV showing all courts', async () => {
  const ms: any[] = [];
  for (let i = 0; i < 10; i++) ms.push(await mkMatch('badminton', 'singles', `P${i}A`, `P${i}B`));
  const tvs: any[] = [];
  for (let i = 0; i < 10; i++) tvs.push(await pairTv(h, admin, `Court ${i + 1}`, { mode: 'match', matchId: ms[i].id }));
  const master = await pairTv(h, admin, 'Master', { mode: 'multi', matchIds: ms.map((m) => m.id), title: 'All courts' });
  for (const m of ms) await ev(m.id, 'MATCH_START');
  const waits = ms.map((m, i) => tvs[i].tv.next((x) => x.t === 'match' && x.match.code === m.code && x.match.display.sides[1].score === String(i + 1)));
  const masterSaw = new Set<string>();
  const masterDone = new Promise<void>((resolve) => {
    master.tv.ws.on('message', (d) => {
      const x = JSON.parse(String(d));
      if (x.t === 'match' && x.match.display.sides[1].score !== '0') masterSaw.add(x.match.code);
      if (masterSaw.size === 10) resolve();
    });
  });
  await Promise.all(ms.map(async (m, i) => {
    for (let k = 0; k <= i; k++) await ev(m.id, 'POINT', { side: 1 });
  }));
  await Promise.all(waits);
  await masterDone;
  // each court TV only received its own match
  for (let i = 0; i < 10; i++) {
    const codes = new Set(tvs[i].tv.messages.filter((x) => x.t === 'match').map((x) => x.match.code));
    assert.deepEqual([...codes], [ms[i].code]);
  }
  const list = await h.api('GET', '/api/displays', undefined, admin);
  assert.ok(list.filter((d: any) => d.status === 'online').length >= 11);
  [...tvs, master].forEach((t) => t.tv.close());
});

test('emergency announcement reaches every connected screen; health reflects disconnects', async () => {
  const x = await pairTv(h, admin, 'Gate');
  const y = await pairTv(h, admin, 'Cafe');
  const got = [x, y].map((t) => t.tv.next((m) => m.t === 'announce' && m.level === 'emergency'));
  await h.api('POST', '/api/displays/announce', { text: 'Please clear Court 3', level: 'emergency', seconds: 30 }, admin);
  await Promise.all(got);
  y.tv.close();
  await new Promise((r) => setTimeout(r, 100));
  const list = await h.api('GET', '/api/displays', undefined, admin);
  assert.equal(list.find((d: any) => d.id === y.deviceId).status, 'offline');
  assert.equal(list.find((d: any) => d.id === x.deviceId).status, 'online');
  x.tv.close();
});

test('playlist rotates match, standings and sponsor views; locked screen refuses reassignment', async () => {
  const m = await mkMatch('volleyball', 'indoor', 'Spikers', 'Blockers');
  const pl = await h.api('POST', '/api/playlists', { name: 'Hall loop', items: [{ kind: 'match', matchId: m.id, seconds: 10 }, { kind: 'upcoming', seconds: 8 }, { kind: 'sponsor', seconds: 5 }] }, admin);
  const s = await pairTv(h, admin, 'Hall', { mode: 'playlist', playlistId: pl.id });
  const cfg = s.tv.messages.filter((q) => q.t === 'display.config').at(-1);
  assert.deepEqual(cfg.views.map((v: any) => v.kind), ['match', 'upcoming', 'sponsor']);
  assert.equal(cfg.views[0].seconds, 10);
  await h.api('PATCH', `/api/displays/${s.deviceId}`, { locked: true }, admin);
  await assert.rejects(h.api('PATCH', `/api/displays/${s.deviceId}`, { assignment: { mode: 'idle' } }, admin), /locked/);
  s.tv.close();
});

test('direct TV URL for a match works without login via public subscription', async () => {
  const m = await mkMatch('football', '5-a-side', 'Reds', 'Blues');
  const anon = new Socket(h.wsUrl);
  await anon.opened;
  anon.send({ t: 'sub', topic: `match:${m.code}` });
  const snap = await anon.next((x) => x.t === 'match', 2000, true);
  assert.equal(snap.match.display.sides[0].name, 'Reds');
  assert.equal(snap.match.participants, undefined, 'no internal fields leak');
  anon.close();
});
