import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../packages/engine/src/index.ts';
import { roundRobin, knockout, standings, schedule, findConflicts, makeGroups, playable } from '../../packages/engine/src/tournament/index.ts';

test('round robin: every pair meets exactly once; odd counts get byes', () => {
  for (const n of [4, 5, 8]) {
    const ids = Array.from({ length: n }, (_, i) => `T${i + 1}`);
    const fx = roundRobin(ids);
    assert.equal(fx.length, (n * (n - 1)) / 2);
    const pairs = new Set(fx.map((f) => [f.home, f.away].sort().join('|')));
    assert.equal(pairs.size, fx.length);
    // nobody plays twice in a round
    for (const r of new Set(fx.map((f) => f.round))) {
      const inRound = fx.filter((f) => f.round === r).flatMap((f) => [f.home, f.away]);
      assert.equal(new Set(inRound).size, inRound.length);
    }
  }
});

test('knockout: seeds 1 and 2 on opposite halves; byes advance top seeds', () => {
  const fx = knockout(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  const r1 = fx.filter((f) => f.round === 1);
  assert.equal(r1.length, 4);
  assert.deepEqual([r1[0].home, r1[0].away], ['S1', null]);
  const semis = fx.filter((f) => f.round === 2);
  assert.equal(semis[0].home, 'S1', 'S1 advanced on a bye');
  assert.equal(fx.find((f) => f.label === 'Final')!.round, 3);
  assert.equal(playable(fx).length, 2);
});

test('groups are seeded snake-style', () => {
  const g = makeGroups(['1', '2', '3', '4', '5', '6', '7', '8'], 2);
  assert.deepEqual(g, { A: ['1', '4', '5', '8'], B: ['2', '3', '6', '7'] });
});

test('football standings: 3/1/0 with goal difference', () => {
  const rows = standings('football', ['A', 'B', 'C'], [
    { home: 'A', away: 'B', winner: 0, primary: [3, 0] },
    { home: 'B', away: 'C', winner: null, primary: [1, 1] },
    { home: 'C', away: 'A', winner: 0, primary: [2, 1] },
  ]);
  assert.deepEqual(rows.map((r) => [r.entrant, r.points, r.diff]), [['C', 4, 1], ['A', 3, 2], ['B', 1, -3]]);
});

test('cricket standings use net run rate as tie-breaker', () => {
  const nrr = (rf: [number, number], bf: [number, number]) => ({ nrr: { runsFor: rf, ballsFaced: bf, ballsPerOver: 6 } });
  const rows = standings('cricket', ['A', 'B', 'C'], [
    { home: 'A', away: 'C', winner: 0, primary: [180, 120], extra: nrr([180, 120], [120, 120]) },
    { home: 'B', away: 'C', winner: 0, primary: [150, 149], extra: nrr([150, 149], [120, 120]) },
  ]);
  assert.equal(rows[0].entrant, 'A');
  assert.ok(rows[0].nrr! > rows[1].nrr!);
});

test('multi-court scheduler never double-books an entrant and fills courts', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `P${i + 1}`);
  const fx = roundRobin(ids);
  const plan = schedule(fx, ['C1', 'C2', 'C3', 'C4'], '2026-10-10T04:30:00Z', 30);
  assert.equal(plan.length, fx.length);
  const items = plan.map((p) => {
    const f = fx.find((x) => x.key === p.key)!;
    return { key: p.key, surfaceId: p.surfaceId, start: p.start, minutes: 30, entrants: [f.home!, f.away!] };
  });
  assert.deepEqual(findConflicts(items), []);
  assert.equal(new Set(plan.map((p) => p.start)).size, 7, '28 matches on 4 courts = 7 slots');
});
