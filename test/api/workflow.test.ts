/**
 * The end-to-end product test from the spec (§68):
 * register org → venue → courts → tournament → teams/players → fixtures → courts → scorer →
 * pair TV → start → score live → TV updates in real time → public score updates → finish →
 * standings/stats/rankings update → AI summary → share card → next match appears on screen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, registerOrg, pairTv, Socket, type Harness } from './harness.ts';

let h: Harness;
before(async () => (h = await start()));
after(async () => h.close());

test('full product workflow', async () => {
  // 1. Register organization
  const admin = await registerOrg(h, 'Sanand Badminton Academy');
  const me = await h.api('GET', '/api/me', undefined, admin);
  assert.equal(me.user.role, 'org_admin');

  // 2-3. Venue + courts
  const venue = await h.api('POST', '/api/venues', { name: 'Main Hall', surfaces: [1, 2, 3, 4].map((n) => ({ name: `Court ${n}`, kind: 'court', sports: ['badminton'] })) }, admin);
  const venues = await h.api('GET', '/api/venues', undefined, admin);
  assert.equal(venues[0].surfaces.length, 4);

  // 5-6. Players
  const names = ['Aarav Shah', 'Diya Patel', 'Kabir Mehta', 'Isha Desai'];
  const players: string[] = [];
  for (const n of names) players.push((await h.api('POST', '/api/players', { name: n, sports: ['badminton'] }, admin)).id);

  // 4. Tournament (round robin singles)
  const t = await h.api('POST', '/api/tournaments', {
    name: 'Diwali Open', sport: 'badminton', discipline: 'singles', format: 'round_robin', venueId: venue.id,
    entrants: players.map((p) => ({ playerIds: [p] })), matchConfig: { bestOf: 1, pointsToWin: 5, cap: 7 },
  }, admin);

  // 7-8. Fixtures generated and laid out across courts without conflicts
  const gen = await h.api('POST', `/api/tournaments/${t.id}/generate`, { startAt: '2026-10-10T04:30:00Z', slotMinutes: 20 }, admin);
  assert.equal(gen.created, 6);
  const bySlot = new Map<string, string[]>();
  for (const m of gen.matches) bySlot.set(m.scheduledAt, [...(bySlot.get(m.scheduledAt) ?? []), ...m.participants.map((p: any) => p.id)]);
  for (const ids of bySlot.values()) assert.equal(new Set(ids).size, ids.length, 'no player double-booked in a slot');
  assert.ok(gen.matches.every((m: any) => m.surfaceId), 'every match assigned a court');

  // 9. Scorer account, assigned to the first match on Court 1
  await h.api('POST', '/api/users', { email: 'scorer@academy.in', name: 'Court 1 Scorer', password: 'scorer-pass-1', role: 'scorer' }, admin);
  const scorer = (await h.api('POST', '/api/auth/login', { email: 'scorer@academy.in', password: 'scorer-pass-1' })).token;
  const scorerId = (await h.api('GET', '/api/me', undefined, scorer)).user.id;
  const court1 = venues[0].surfaces[0].id;
  const first = gen.matches.find((m: any) => m.surfaceId === court1);
  await h.api('PATCH', `/api/matches/${first.id}`, { scorerUserId: scorerId }, admin);

  // 10. Pair two TVs: one on the match, one master screen showing every court at the venue
  const matchTv = await pairTv(h, admin, 'Court 1 TV', { mode: 'match', matchId: first.id });
  const lobbyTv = await pairTv(h, admin, 'Lobby', { mode: 'venue', venueId: venue.id });
  const lobbyCfg = lobbyTv.tv.messages.filter((m) => m.t === 'display.config').at(-1);
  assert.equal(lobbyCfg.views[0].kind, 'grid');
  assert.equal(lobbyCfg.views[0].courts.length, 4);
  assert.equal(lobbyCfg.views[0].courts[0].match, first.code);

  // Spectator on the public live page
  const fan = new Socket(h.wsUrl);
  await fan.opened;
  fan.send({ t: 'sub', topic: `match:${first.code}` });
  await fan.next((m) => m.t === 'match', 2000, true);

  // 11. Start match
  await h.api('POST', `/api/matches/${first.id}/events`, { type: 'MATCH_START', clientEventId: 's-1' }, scorer);

  // 12-14. Score live → TV and public page update without refresh
  const tvUpdate = matchTv.tv.next((m) => m.t === 'match' && m.match.display.sides[0].score === '1');
  const fanUpdate = fan.next((m) => m.t === 'match' && m.match.display.sides[0].score === '1');
  const t0 = Date.now();
  const res = await h.api('POST', `/api/matches/${first.id}/events`, { type: 'POINT', payload: { side: 0 }, clientEventId: 'p-1' }, scorer);
  assert.equal(res.results[0].status, 'accepted');
  await Promise.all([tvUpdate, fanUpdate]);
  assert.ok(Date.now() - t0 < 1000, 'score reaches screens in well under a second');
  const pub = await h.api('GET', `/api/public/m/${first.code}`);
  assert.equal(pub.display.sides[0].score, '1');

  // 15. Finish the match (best of 1 to 5)
  const done = matchTv.tv.next((m) => m.t === 'match' && m.match.status === 'completed');
  for (let i = 2; i <= 5; i++) await h.api('POST', `/api/matches/${first.id}/events`, { type: 'POINT', payload: { side: 0 }, clientEventId: `p-${i}` }, scorer);
  const fin = await done;
  assert.match(fin.match.display.resultText, /won 1–0 \(5-0\)/);

  // 16. Standings update
  const td = await h.api('GET', `/api/tournaments/${t.id}`, undefined, admin);
  const winnerId = first.participants[0].id;
  const row = td.standings.tables[0].rows.find((r: any) => r.entrant === winnerId);
  assert.equal(row.won, 1);
  assert.equal(row.points, 2);
  assert.equal(td.standings.tables[0].rows[0].entrant, winnerId);

  // 17-18. Player stats + rankings (Elo)
  const p = await h.api('GET', `/api/players/${winnerId}`, undefined, admin);
  assert.equal(p.career.badminton.won, 1);
  assert.ok(p.rating.badminton > 1500);

  // 19-20. Verified AI summary + social result
  const ins = await h.api('GET', `/api/matches/${first.id}/insights`, undefined, admin);
  assert.match(ins.summary, /won/);
  assert.ok(ins.facts.keyMoments.every((k: any) => k.sources.length > 0), 'every claim cites events');
  const card = await fetch(`${h.base}/share/${first.code}`);
  assert.equal(card.headers.get('content-type'), 'image/svg+xml');
  assert.match(await card.text(), /FINAL/);

  // 21. Next match automatically appears on the Court 1 slot of the lobby screen
  const nextCfg = await lobbyTv.tv.next((m) => m.t === 'display.config' && m.views[0].courts[0].match !== first.code);
  const nextCode = nextCfg.views[0].courts[0].match;
  assert.ok(nextCode);
  assert.equal(nextCfg.matches[nextCode].status, 'scheduled');

  matchTv.tv.close();
  lobbyTv.tv.close();
  fan.close();
});
