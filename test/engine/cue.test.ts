import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './helpers.ts';
import type { MatchAggregate } from '../../packages/engine/src/index.ts';

const pot = (m: MatchAggregate, ball: string, extra: any = {}) => m.record({ type: 'POT', payload: { ball, ...extra } });

test('snooker: red/colour sequence, breaks, points remaining, fouls', () => {
  const m = makeMatch('snooker', 'best-of-5');
  assert.match(m.display().headline!, /ON: RED · REMAINING 147/);
  assert.throws(() => pot(m, 'black'), /on a red/);
  pot(m, 'red');
  assert.throws(() => pot(m, 'red'), /on a colour/);
  pot(m, 'black');
  pot(m, 'red');
  pot(m, 'pink');
  assert.deepEqual(m.display().sides[0].detail!.slice(0, 1), ['BREAK 15']);
  assert.match(m.display().headline!, /REMAINING 131/);
  m.record({ type: 'MISS' });
  assert.equal(m.display().sides[1].serving, true);
  m.record({ type: 'FOUL', payload: { points: 4 } }); // B fouls
  assert.equal(m.display().sides[0].score, '19');
  assert.equal(m.display().sides[0].serving, true);
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.deepEqual(st.highBreak, [15, 0]);
  assert.deepEqual(st.fouls, [0, 1]);
});

test('snooker: six-red clearance in order, frame + match result, snookers required', () => {
  const m = makeMatch('snooker', 'six-red', { bestOf: 1 });
  for (let i = 0; i < 6; i++) {
    pot(m, 'red');
    pot(m, 'black');
  }
  assert.match(m.display().headline!, /ON: YELLOW · REMAINING 27/);
  assert.match(m.display().headline!, /BRV NEEDS SNOOKERS/);
  assert.throws(() => pot(m, 'pink'), /On the yellow/);
  for (const c of ['yellow', 'green', 'brown', 'blue', 'pink', 'black']) pot(m, c);
  assert.equal(m.status, 'completed');
  assert.equal(m.statistics().team.find((l) => l.key === 'highBreak')!.values[0], 75);
});

test('snooker: century break counted; re-spotted black when level', () => {
  const m = makeMatch('snooker', 'best-of-7');
  for (let i = 0; i < 15; i++) {
    pot(m, 'red');
    pot(m, 'black');
  }
  m.record({ type: 'MISS' }); // break of 120 ends
  assert.equal(m.statistics().team.find((l) => l.key === 'centuries')!.values[0], 1);

  // Re-spotted black: A gives away 75 in fouls, then clears 6 reds+blacks and colours = 75 → level.
  const r = makeMatch('snooker', 'six-red', { bestOf: 3 });
  for (const v of [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 5]) {
    r.record({ type: 'FOUL', payload: { points: v } }); // A fouls, B to table
    r.record({ type: 'MISS' }); // B misses, A back
  }
  for (let i = 0; i < 6; i++) {
    pot(r, 'red');
    pot(r, 'black');
  }
  for (const c of ['yellow', 'green', 'brown', 'blue', 'pink', 'black']) pot(r, c);
  assert.match(r.display().headline!, /RE-SPOTTED BLACK/);
  assert.equal(r.display().sides[0].score, '75');
  assert.equal(r.display().sides[1].score, '75');
  r.record({ type: 'MISS' });
  pot(r, 'black'); // B pots the re-spotted black
  assert.equal(r.display().phase, 'FRAME 2');
  assert.equal(r.display().sides[1].badges![0], 'FRAMES 1');
});

test('snooker: concession awards frame to opponent', () => {
  const m = makeMatch('snooker', 'best-of-5');
  m.record({ type: 'CONCEDE', payload: { side: 0 } });
  assert.equal(m.display().sides[1].badges![0], 'FRAMES 1');
  assert.equal(m.display().phase, 'FRAME 2');
  assert.equal(m.display().sides[1].serving, true, 'players alternate breaking');
});

test('billiards english: configurable shots, target points, fouls to opponent', () => {
  const m = makeMatch('billiards', 'english-points', { targetPoints: 10, framesToWin: 1 });
  m.record({ type: 'SCORE', payload: { shot: 'pot_red' } });
  m.record({ type: 'SCORE', payload: { shot: 'cannon' } });
  m.record({ type: 'END_VISIT' });
  m.record({ type: 'FOUL' }); // B fouls: 2 to A
  assert.equal(m.display().sides[0].score, '7');
  assert.throws(() => m.record({ type: 'SCORE', payload: { shot: 'massé' } }), /shot must be one of/);
  m.record({ type: 'SCORE', payload: { shot: 'pot_red' } });
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 0);
});

test('billiards organiser-defined discipline: custom shot table via config override', () => {
  const m = makeMatch('billiards', 'english-points', { shots: { kiss: 5, jump: 10 }, targetPoints: 15, framesToWin: 1 });
  m.record({ type: 'SCORE', payload: { shot: 'jump' } });
  m.record({ type: 'SCORE', payload: { shot: 'kiss' } });
  assert.equal(m.status, 'completed');
});

test('pool race: racks to win', () => {
  const m = makeMatch('billiards', 'pool-9-ball', { framesToWin: 3 });
  for (const s of [0, 1, 0, 0] as const) m.record({ type: 'RACK_WON', payload: { side: s } });
  assert.equal(m.status, 'completed');
  assert.equal(m.score().text.join('-'), '3-1');
});
