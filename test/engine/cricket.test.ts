import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './helpers.ts';
import type { MatchAggregate } from '../../packages/engine/src/index.ts';

const ball = (m: MatchAggregate, payload: any = {}) => m.record({ type: 'BALL', payload: { runs: 0, ...payload } });
const bowler = (m: MatchAggregate, id: string) => m.record({ type: 'NEW_BOWLER', payload: { player: id } });
const batter = (m: MatchAggregate, id: string) => m.record({ type: 'NEW_BATTER', payload: { player: id } });
const inn = (m: MatchAggregate) => (m.statistics().detail as any).innings.at(-1);
const card = (m: MatchAggregate, id: string) => inn(m).batting.find((b: any) => b.playerId === id);
const bcard = (m: MatchAggregate, id: string) => inn(m).bowling.find((b: any) => b.playerId === id);

function t20(overs = 2, extra: any = {}) {
  const m = makeMatch('cricket', 't20', { oversPerInnings: overs, maxOversPerBowler: null, ...extra }, 11);
  m.record({ type: 'TOSS', payload: { winner: 1, decision: 'bowl' } });
  m.record({ type: 'INNINGS_START', payload: { striker: 'a1', nonStriker: 'a2', bowler: 'b11' } });
  return m;
}

test('cricket: toss decides batting side; strike rotates on odd runs and at over end', () => {
  const m = t20();
  assert.equal(m.display().sides[0].serving, true, 'Alpha batting after Bravo chose to bowl');
  ball(m, { runs: 1 });
  assert.equal(inn(m).batting.find((b: any) => b.onStrike).playerId, 'a2');
  ball(m, { runs: 4 });
  ball(m, { runs: 2 });
  ball(m, { runs: 3 });
  assert.equal(inn(m).batting.find((b: any) => b.onStrike).playerId, 'a1');
  ball(m);
  ball(m, { runs: 6 }); // end of over, a1 hit six => a2 on strike next over
  assert.equal(inn(m).batting.find((b: any) => b.onStrike).playerId, 'a2');
  assert.equal(m.display().sides[0].score, '16/0');
  assert.match(m.display().sides[0].detail![0], /OVERS 1\.0\/2/);
  assert.equal(card(m, 'a1').runs, 7);
  assert.equal(card(m, 'a2').runs, 9);
  assert.equal(card(m, 'a1').sixes, 1);
  assert.equal(card(m, 'a2').fours, 1);
  // over complete: new bowler required, cannot be same bowler
  assert.throws(() => ball(m), /Select the bowler/);
  assert.throws(() => bowler(m, 'b11'), /consecutive/);
  bowler(m, 'b10');
});

test('cricket: extras — wides and no-balls are re-bowled, byes/leg-byes not charged to bowler', () => {
  const m = t20();
  ball(m, { extra: 'wide' });
  ball(m, { extra: 'wide', runs: 4 }); // 5 wides
  ball(m, { extra: 'noball', runs: 4 }); // 1 nb + 4 to batter
  ball(m, { extra: 'bye', runs: 2 });
  ball(m, { extra: 'legbye', runs: 1 });
  const i = inn(m);
  assert.equal(i.total, '14/0');
  assert.equal(i.overs, '0.2');
  assert.deepEqual([i.extras.wd, i.extras.nb, i.extras.b, i.extras.lb], [6, 1, 2, 1]);
  const b = bcard(m, 'b11');
  assert.equal(b.runs, 6 + 5); // wides + (nb + bat runs), byes not charged
  assert.equal(b.wides, 6);
  assert.equal(b.noBalls, 1);
  assert.equal(card(m, 'a1').balls, 3, 'no-ball, bye and leg-bye count as balls faced; wides do not');
});

test('cricket: free hit after no-ball limits dismissals', () => {
  const m = t20();
  ball(m, { extra: 'noball' });
  assert.match(m.display().headline!, /FREE HIT/);
  assert.throws(() => ball(m, { wicket: { kind: 'bowled' } }), /Free hit/);
  ball(m, { extra: 'wide' }); // free hit carries over a wide
  assert.match(m.display().headline!, /FREE HIT/);
  ball(m, { runs: 1 });
  assert.doesNotMatch(m.display().headline!, /FREE HIT/);
  assert.throws(() => ball(m, { extra: 'wide', wicket: { kind: 'lbw' } }), /off a wide/);
});

test('cricket: dismissals, bowler credit, caught => new batter on strike, fall of wickets', () => {
  const m = t20();
  ball(m, { runs: 1 }); // a2 on strike
  ball(m, { wicket: { kind: 'caught', fielder: 'b3' } });
  assert.equal(card(m, 'a2').dismissal, 'c B Player 3 b B Player 11');
  assert.throws(() => ball(m), /new batter/);
  batter(m, 'a3');
  assert.equal(inn(m).batting.find((b: any) => b.onStrike).playerId, 'a3', 'new batter faces after a catch');
  ball(m, { runs: 1, wicket: { kind: 'run_out', playerOut: 'a1', fielder: 'b7' } }); // a1 run out going for 2nd
  assert.equal(card(m, 'a1').dismissal, 'run out (B Player 7)');
  assert.equal(bcard(m, 'b11').wickets, 1, 'run out not credited to bowler');
  batter(m, 'a4');
  assert.equal(inn(m).fallOfWickets.length, 2);
  assert.equal(inn(m).fallOfWickets[1].runs, 2);
  assert.throws(() => batter(m, 'a5'), /already in/);
});

test('cricket: maiden over and bowler over limits', () => {
  const m = makeMatch('cricket', 't20', { oversPerInnings: 5, maxOversPerBowler: 1 }, 11);
  m.record({ type: 'INNINGS_START', payload: { battingSide: 0, striker: 'a1', nonStriker: 'a2', bowler: 'b11' } });
  for (let i = 0; i < 6; i++) ball(m);
  assert.equal(bcard(m, 'b11').maidens, 1);
  bowler(m, 'b10');
  for (let i = 0; i < 6; i++) ball(m, { extra: 'legbye', runs: 1 });
  assert.equal(bcard(m, 'b10').maidens, 1, 'leg byes do not spoil a maiden');
  assert.throws(() => bowler(m, 'b11'), /maximum 1 overs/);
});

test('cricket: chase — target, required rate, win by wickets with balls left', () => {
  const m = t20(2);
  for (let i = 0; i < 12; i++) {
    if (i === 6) bowler(m, 'b10');
    ball(m, { runs: 1 });
  }
  assert.equal(m.display().phase, 'INNINGS BREAK');
  assert.equal(m.display().sides[0].score, '12/0');
  m.record({ type: 'INNINGS_START', payload: { striker: 'b1', nonStriker: 'b2', bowler: 'a11' } });
  assert.match(m.display().headline!, /NEED 13 OFF 12 BALLS · RRR 6\.50/);
  ball(m, { runs: 6 });
  ball(m, { runs: 6 });
  ball(m, { runs: 1 });
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 1);
  assert.equal(m.display().resultText, 'Bravo won by 10 wickets (9 balls left)');
});

test('cricket: defending total — win by runs; all out ends innings', () => {
  const m = makeMatch('cricket', 'custom-6-a-side', { oversPerInnings: 5 }, 6);
  m.record({ type: 'INNINGS_START', payload: { battingSide: 0, striker: 'a1', nonStriker: 'a2', bowler: 'b6' } });
  ball(m, { runs: 4 });
  m.record({ type: 'INNINGS_END', payload: { reason: 'declared' } });
  m.record({ type: 'INNINGS_START', payload: { striker: 'b1', nonStriker: 'b2', bowler: 'a6' } });
  const next = ['b3', 'b4', 'b5', 'b6'];
  for (let w = 0; w < 5; w++) {
    ball(m, { wicket: { kind: 'bowled' } });
    if (w < 4) batter(m, next[w]);
  }
  assert.equal(m.status, 'completed');
  assert.equal(m.display().resultText, 'Alpha won by 4 runs');
  const nrr = m.score().extra!.nrr;
  assert.equal(nrr.ballsFaced[1], 30, 'all-out side deemed to have faced full quota for NRR');
});

test('cricket: tie goes to a Super Over; side batting second bats first', () => {
  const m = t20(1);
  for (let i = 0; i < 6; i++) ball(m, { runs: 1 });
  m.record({ type: 'INNINGS_START', payload: { striker: 'b1', nonStriker: 'b2', bowler: 'a11' } });
  for (let i = 0; i < 6; i++) ball(m, { runs: 1 });
  assert.equal(m.status, 'live');
  const start = m.actions().find((a) => a.type === 'INNINGS_START')!;
  assert.equal(start.payload!.battingSide, 1);
  m.record({ type: 'INNINGS_START', payload: { battingSide: 1, striker: 'b1', nonStriker: 'b2', bowler: 'a10' } });
  assert.equal(m.display().phase, 'SUPER OVER');
  ball(m, { wicket: { kind: 'bowled' } });
  batter(m, 'b3');
  ball(m, { wicket: { kind: 'bowled' } }); // 2 wickets = all out in a super over
  m.record({ type: 'INNINGS_START', payload: { striker: 'a1', nonStriker: 'a2', bowler: 'b10' } });
  ball(m, { runs: 1 });
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 0);
  assert.equal(m.display().resultText, 'Alpha won the Super Over');
});

test('cricket: revised target (DLS hook) applies to the chase', () => {
  const m = t20(2);
  for (let i = 0; i < 12; i++) {
    if (i === 6) bowler(m, 'b10');
    ball(m, { runs: 2 });
  }
  m.record({ type: 'INNINGS_START', payload: { striker: 'b1', nonStriker: 'b2', bowler: 'a11' } });
  m.record({ type: 'REVISED_TARGET', payload: { target: 10, overs: 1 } });
  assert.match(m.display().headline!, /NEED 10 OFF 6 BALLS/);
});

test('cricket test match: innings victory after three innings', () => {
  const m = makeMatch('cricket', 'test', { playersPerSide: 3 }, 3);
  const allOut = () => {
    ball(m, { wicket: { kind: 'bowled' } });
    batter(m, 'x');
    ball(m, { wicket: { kind: 'lbw' } });
  };
  m.record({ type: 'INNINGS_START', payload: { battingSide: 0, striker: 'a1', nonStriker: 'a2', bowler: 'b1' } });
  ball(m, { runs: 4 });
  allOut();
  m.record({ type: 'INNINGS_START', payload: { striker: 'b1', nonStriker: 'b2', bowler: 'a1' } });
  ball(m, { runs: 6 });
  ball(m, { runs: 6 });
  m.record({ type: 'INNINGS_END', payload: { reason: 'declared' } });
  assert.match(m.display().phase, /INNINGS BREAK/);
  // Alpha bats again (follow-on enforced by passing battingSide)
  m.record({ type: 'INNINGS_START', payload: { battingSide: 0, striker: 'a1', nonStriker: 'a2', bowler: 'b1' } });
  assert.match(m.display().headline!, /TRAIL BY 8/);
  ball(m, { runs: 1 });
  ball(m, { wicket: { kind: 'bowled' } });
  batter(m, 'x');
  ball(m, { wicket: { kind: 'bowled' } });
  assert.equal(m.status, 'completed');
  assert.equal(m.display().resultText, 'Bravo won by an innings and 7 runs');
});

test('cricket: correction voids an event and later dependent events are flagged, not silently applied', () => {
  const m = t20();
  for (let i = 0; i < 6; i++) ball(m);
  const nb = bowler(m, 'b10');
  ball(m, { runs: 1 });
  m.record({ type: 'VOID', payload: { targetId: nb.id } });
  assert.equal(m.issues.length, 1);
  assert.match(m.issues[0].error, /bowler/);
  assert.equal(m.display().sides[0].score, '0/0');
});
