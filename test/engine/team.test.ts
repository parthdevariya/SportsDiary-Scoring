import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, at } from './helpers.ts';

const rec = (m: any, type: string, payload: any = {}, secs = 0) => m.record({ type, payload, deviceTime: at(secs) });

test('football: goals, minute stamps, cards (2nd yellow = red), full time result', () => {
  const m = makeMatch('football', '11-a-side', {}, 16);
  assert.throws(() => rec(m, 'GOAL', { side: 0 }), /not in play/);
  rec(m, 'PERIOD_START', { kickoff: 0 });
  rec(m, 'GOAL', { side: 0, player: 'a9', assist: 'a10' }, 12 * 60 + 5);
  assert.match(m.timeline.at(-1)!.text, /^13' GOAL! A Player 9 scores for Alpha, assisted by A Player 10 · 1–0/);
  rec(m, 'CARD', { side: 1, player: 'b4', color: 'yellow' }, 60);
  rec(m, 'CARD', { side: 1, player: 'b4', color: 'yellow' }, 60);
  assert.throws(() => rec(m, 'FOUL', { side: 1, player: 'b4' }), /sent off/);
  assert.throws(() => rec(m, 'GOAL', { side: 1, player: 'a2' }), /does not play/);
  rec(m, 'GOAL', { side: 1, player: 'a2', ownGoal: true }, 60);
  rec(m, 'PERIOD_END', {}, 30 * 60);
  assert.equal(m.display().phase, 'HALF TIME');
  rec(m, 'PERIOD_START', { kickoff: 1 }, 15 * 60);
  rec(m, 'GOAL', { side: 0, player: 'a11', penalty: true }, 20 * 60);
  assert.match(m.timeline.at(-1)!.text, /^66' .*from the spot/);
  rec(m, 'PERIOD_END', {}, 26 * 60);
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 0);
  assert.equal(m.display().resultText, 'Alpha won 2–1');
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.deepEqual(st.red, [0, 1]);
  assert.deepEqual(st.yellow, [0, 2]);
  const scorer = m.statistics().players.find((p) => p.playerId === 'a9')!;
  assert.equal(scorer.stats.goals, 1);
});

test('football: possession is time-weighted while ball is in play', () => {
  const m = makeMatch('football', '5-a-side');
  rec(m, 'PERIOD_START', { kickoff: 0 }, 1);
  rec(m, 'POSSESSION', { side: 1 }, 30); // A had it 30s
  rec(m, 'POSSESSION', { side: 0 }, 90); // B had it 90s
  rec(m, 'PERIOD_END', {}, 0);
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.deepEqual(st.possession, ['25%', '75%']);
});

test('football knockout: level after 90 → extra time → penalty shoot-out with sudden death', () => {
  const m = makeMatch('football', '11-a-side-knockout');
  rec(m, 'PERIOD_START', {});
  rec(m, 'PERIOD_END', {}, 2700);
  rec(m, 'PERIOD_START', {});
  rec(m, 'PERIOD_END', {}, 2700);
  assert.equal(m.display().phase, 'END OF NORMAL TIME');
  rec(m, 'PERIOD_START', {});
  rec(m, 'PERIOD_END', {}, 900);
  rec(m, 'PERIOD_START', {});
  rec(m, 'PERIOD_END', {}, 900);
  assert.equal(m.display().phase, 'PENALTIES');
  assert.throws(() => rec(m, 'PERIOD_START', {}));
  const kick = (side: 0 | 1, scored: boolean) => rec(m, 'SHOOTOUT_KICK', { side, scored });
  for (let i = 0; i < 5; i++) {
    kick(0, true);
    kick(1, true);
  }
  assert.equal(m.status, 'live', '5-5 goes to sudden death');
  assert.throws(() => kick(1, true), /must take the next kick/);
  kick(0, false);
  kick(1, true);
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 1);
  assert.match(m.display().resultText!, /Bravo won 0–0 \(6–5 pens\)/);
});

test('football shoot-out ends early when one side cannot catch up', () => {
  const m = makeMatch('football', '11-a-side-knockout', { extraTime: false });
  rec(m, 'PERIOD_START', {});
  rec(m, 'PERIOD_END', {});
  rec(m, 'PERIOD_START', {});
  rec(m, 'PERIOD_END', {});
  const kick = (side: 0 | 1, scored: boolean) => rec(m, 'SHOOTOUT_KICK', { side, scored });
  kick(0, true); kick(1, false);
  kick(0, true); kick(1, false);
  kick(0, true); // 3-0, B has 3 kicks left: could reach 3 -> continue
  assert.equal(m.status, 'live');
  kick(1, false); // 3-0, B can reach max 2
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 0);
});

test('basketball 5x5: scoring, box score, team fouls/bonus, foul out, overtime', () => {
  const m = makeMatch('basketball', '5x5', {}, 8);
  rec(m, 'PERIOD_START');
  rec(m, 'SCORE', { side: 0, points: 3, player: 'a1', assist: 'a2' }, 10);
  rec(m, 'SCORE', { side: 1, points: 2, player: 'b1' }, 10);
  rec(m, 'MISS', { side: 0, points: 3, player: 'a1' }, 10);
  rec(m, 'REBOUND', { side: 1, player: 'b5' }, 1);
  rec(m, 'SCORE', { side: 1, points: 1, player: 'b1' }, 10);
  assert.equal(m.display().sides.map((s) => s.score).join('-'), '3-3');
  for (let i = 0; i < 4; i++) rec(m, 'FOUL', { side: 0, player: 'a3' }, 5);
  assert.deepEqual(m.display().sides[1].badges, ['BONUS'], 'B in bonus after A commits 4 team fouls (5th = FTs)');
  rec(m, 'FOUL', { side: 0, player: 'a3' }, 5);
  assert.throws(() => rec(m, 'SCORE', { side: 0, points: 2, player: 'a3' }), /fouled out/);
  rec(m, 'PERIOD_END', {}, 400);
  rec(m, 'PERIOD_START');
  assert.equal(m.display().sides[0].detail![0], 'Fouls 0', 'team fouls reset each quarter');
  rec(m, 'PERIOD_END', {}, 600);
  rec(m, 'PERIOD_START');
  rec(m, 'PERIOD_END', {}, 600);
  rec(m, 'PERIOD_START');
  rec(m, 'PERIOD_END', {}, 600);
  assert.equal(m.display().phase, 'OVERTIME NEXT');
  rec(m, 'PERIOD_START');
  assert.equal(m.display().phase, 'OT');
  rec(m, 'SCORE', { side: 1, points: 2, player: 'b2' }, 30);
  rec(m, 'PERIOD_END', {}, 270);
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 1);
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.equal(st['3pt'][0], '1/2 (50%)');
  assert.equal(st.fg[1], '2/2 (100%)');
  assert.equal(st.ft[1], '1/1 (100%)');
  assert.deepEqual(st.ast, [1, 0]);
  const a1 = m.statistics().players.find((p) => p.playerId === 'a1')!;
  assert.equal(a1.stats.pts, 3);
});

test('basketball clock: stop/start banks elapsed time from device timestamps', () => {
  const m = makeMatch('basketball', '5x5');
  rec(m, 'PERIOD_START', {}, 0);
  rec(m, 'CLOCK_STOP', {}, 65);
  const c = m.display().clock!;
  assert.equal(c.running, false);
  assert.equal(c.elapsedMs, 65000);
  assert.equal(c.direction, 'down');
  rec(m, 'CLOCK_START', {}, 300); // dead time not counted
  rec(m, 'CLOCK_STOP', {}, 10);
  assert.equal(m.display().clock!.elapsedMs, 75000);
});

test('basketball 3x3: game ends on reaching 21; arc shots worth 2', () => {
  const m = makeMatch('basketball', '3x3');
  rec(m, 'PERIOD_START');
  assert.throws(() => rec(m, 'SCORE', { side: 0, points: 3 }), /points must be/);
  for (let i = 0; i < 10; i++) rec(m, 'SCORE', { side: 0, points: 2 }, 5);
  assert.equal(m.status, 'live');
  rec(m, 'SCORE', { side: 0, points: 1, fieldGoal: true }, 5);
  assert.equal(m.status, 'completed');
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.equal(st['3pt'][0], '10/10 (100%)');
  assert.equal(st.fg[0], '11/11 (100%)');
});
