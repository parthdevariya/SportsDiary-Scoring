import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, registerOrg, Socket, type Harness } from './harness.ts';

let h: Harness;
let orgA: string;
let orgB: string;
before(async () => {
  h = await start();
  orgA = await registerOrg(h, 'Org A');
  orgB = await registerOrg(h, 'Org B');
});
after(async () => h.close());

test('tenant isolation: another org cannot read, score or display my match', async () => {
  const m = await h.api('POST', '/api/matches', { sport: 'cricket', discipline: 't20', participants: [{ name: 'A XI' }, { name: 'B XI' }] }, orgA);
  await assert.rejects(h.api('GET', `/api/matches/${m.id}`, undefined, orgB), /not found/i);
  await assert.rejects(h.api('POST', `/api/matches/${m.id}/events`, { type: 'MATCH_START' }, orgB), /not found/i);
  await assert.rejects(h.api('PATCH', `/api/displays/whatever`, { assignment: { mode: 'match', matchId: m.id } }, orgB), /not found/i);
  const list = await h.api('GET', '/api/matches', undefined, orgB);
  assert.equal(list.length, 0);
});

test('authentication and RBAC', async () => {
  await assert.rejects(h.api('POST', '/api/matches', { sport: 'football', discipline: '5-a-side', participants: [{ name: 'x' }, { name: 'y' }] }), /Sign in/);
  await h.api('POST', '/api/users', { email: 'spec@x.io', name: 'Spectator', password: 'spectator-1', role: 'spectator' }, orgA);
  const spec = (await h.api('POST', '/api/auth/login', { email: 'spec@x.io', password: 'spectator-1' })).token;
  await assert.rejects(h.api('POST', '/api/matches', { sport: 'football', discipline: '5-a-side', participants: [{ name: 'x' }, { name: 'y' }] }, spec), /permission/);
  await assert.rejects(h.api('POST', '/api/auth/login', { email: 'spec@x.io', password: 'wrong-password' }), /Incorrect/);
});

test('scorers can only score matches assigned to them', async () => {
  await h.api('POST', '/api/users', { email: 's1@x.io', name: 'S1', password: 'scorer-one', role: 'scorer' }, orgA);
  await h.api('POST', '/api/users', { email: 's2@x.io', name: 'S2', password: 'scorer-two', role: 'scorer' }, orgA);
  const s1 = (await h.api('POST', '/api/auth/login', { email: 's1@x.io', password: 'scorer-one' })).token;
  const s2 = (await h.api('POST', '/api/auth/login', { email: 's2@x.io', password: 'scorer-two' })).token;
  const s1id = (await h.api('GET', '/api/me', undefined, s1)).user.id;
  const m = await h.api('POST', '/api/matches', { sport: 'table-tennis', discipline: 'singles', participants: [{ name: 'Ma' }, { name: 'Fan' }], scorerUserId: s1id }, orgA);
  await h.api('POST', `/api/matches/${m.id}/events`, { type: 'MATCH_START' }, s1);
  await assert.rejects(h.api('POST', `/api/matches/${m.id}/events`, { type: 'POINT', payload: { side: 0 } }, s2), /different scorer/);
});

test('private matches are hidden from public URLs and public sockets', async () => {
  const m = await h.api('POST', '/api/matches', { sport: 'snooker', discipline: 'best-of-5', visibility: 'private', participants: [{ name: 'Advani' }, { name: 'Mehta' }] }, orgA);
  await assert.rejects(h.api('GET', `/api/public/m/${m.code}`), /not found/i);
  const s = new Socket(h.wsUrl);
  await s.opened;
  s.send({ t: 'sub', topic: `match:${m.code}` });
  await s.next((x) => x.t === 'error');
  s.close();
});

test('input validation and illegal scoring events are rejected with reasons', async () => {
  await assert.rejects(h.api('POST', '/api/matches', { sport: 'quidditch', discipline: 'x', participants: [{ name: 'a' }, { name: 'b' }] }, orgA), /Unknown sport/);
  await assert.rejects(h.api('POST', '/api/matches', { sport: 'tennis', discipline: 'singles', participants: [{ name: 'a' }] }, orgA), /two participants/);
  const m = await h.api('POST', '/api/matches', { sport: 'tennis', discipline: 'singles', participants: [{ name: 'a' }, { name: 'b' }] }, orgA);
  const r = await h.api('POST', `/api/matches/${m.id}/events`, { type: 'POINT', payload: { side: 0 } }, orgA);
  assert.equal(r.results[0].status, 'rejected');
  assert.match(r.results[0].error, /not started/);
});

test('offline sync: batch flush is idempotent, ordered, and conflicts are returned not forced', async () => {
  const m = await h.api('POST', '/api/matches', { sport: 'badminton', discipline: 'singles', config: { bestOf: 1, pointsToWin: 3, cap: 4 }, participants: [{ name: 'Sen' }, { name: 'Prannoy' }] }, orgA);
  const queue = [
    { type: 'MATCH_START', clientEventId: 'dev-1' },
    { type: 'POINT', payload: { side: 0 }, clientEventId: 'dev-2' },
    { type: 'POINT', payload: { side: 0 }, clientEventId: 'dev-3' },
  ];
  const r1 = await h.api('POST', `/api/matches/${m.id}/events`, { events: queue, since: 0 }, orgA);
  assert.deepEqual(r1.results.map((x: any) => x.status), ['accepted', 'accepted', 'accepted']);
  // device didn't get the response (network blip) and retries the same queue + one more
  const r2 = await h.api('POST', `/api/matches/${m.id}/events`, { events: [...queue, { type: 'POINT', payload: { side: 0 }, clientEventId: 'dev-4' }], since: 0 }, orgA);
  assert.deepEqual(r2.results.map((x: any) => x.status), ['duplicate', 'duplicate', 'duplicate', 'accepted']);
  assert.equal(r2.snapshot.status, 'completed');
  assert.equal(r2.events.length, 4, 'server returns authoritative log for rebasing');
  // a second offline device scored a point it thought was legal — rejected with a reason
  const r3 = await h.api('POST', `/api/matches/${m.id}/events`, { events: [{ type: 'POINT', payload: { side: 1 }, clientEventId: 'dev2-1' }] }, orgA);
  assert.equal(r3.results[0].status, 'rejected');
  assert.match(r3.results[0].error, /finished/);
});

test('undo/redo through the API is an audited append, never a delete', async () => {
  const m = await h.api('POST', '/api/matches', { sport: 'pickleball', discipline: 'doubles', participants: [{ name: 'A' }, { name: 'B' }] }, orgA);
  await h.api('POST', `/api/matches/${m.id}/events`, { type: 'MATCH_START' }, orgA);
  await h.api('POST', `/api/matches/${m.id}/events`, { type: 'RALLY', payload: { side: 0 } }, orgA);
  const u = await h.api('POST', `/api/matches/${m.id}/undo`, {}, orgA);
  assert.equal(u.snapshot.display.sides[0].score, '0');
  const r = await h.api('POST', `/api/matches/${m.id}/redo`, {}, orgA);
  assert.equal(r.snapshot.display.sides[0].score, '1');
  const evs = await h.api('GET', `/api/matches/${m.id}/events`, undefined, orgA);
  assert.deepEqual(evs.map((e: any) => e.type), ['MATCH_START', 'RALLY', 'VOID', 'UNVOID']);
});

test('knockout tournament: winners advance into the next round automatically', async () => {
  const t = await h.api('POST', '/api/tournaments', {
    name: 'Cup', sport: 'table-tennis', discipline: 'best-of-3', format: 'knockout', matchConfig: { bestOf: 1, pointsToWin: 2, winBy: 1 },
    entrants: ['S1', 'S2', 'S3', 'S4'].map((name) => ({ name })),
  }, orgA);
  const g = await h.api('POST', `/api/tournaments/${t.id}/generate`, {}, orgA);
  assert.equal(g.created, 3);
  const final = g.matches.find((m: any) => m.label === 'Final');
  assert.deepEqual(final.participants.map((p: any) => p.name), ['TBD', 'TBD']);
  const r = await h.api('POST', `/api/matches/${final.id}/events`, { type: 'MATCH_START' }, orgA);
  assert.match(r.results[0].error, /not decided/);
  for (const sf of g.matches.filter((m: any) => m.round === 1)) {
    await h.api('POST', `/api/matches/${sf.id}/events`, { events: [{ type: 'MATCH_START' }, { type: 'POINT', payload: { side: 0 } }, { type: 'POINT', payload: { side: 0 } }] }, orgA);
  }
  const f = await h.api('GET', `/api/matches/${final.id}`, undefined, orgA);
  assert.deepEqual(f.match.participants.map((p: any) => p.name).sort(), ['S1', 'S2']);
});
