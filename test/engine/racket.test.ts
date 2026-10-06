import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, points } from './helpers.ts';

test('badminton: 21-point games, deuce to 30 cap, rally-winner serves', () => {
  const m = makeMatch('badminton', 'singles');
  points(m, 0, 20);
  points(m, 1, 20);
  assert.equal(m.display().headline, 'DEUCE');
  points(m, 0, 1); // 21-20: not won (win by 2)
  assert.match(m.display().headline!, /GAME POINT · ALP/);
  assert.equal(m.display().sides[0].serving, true);
  points(m, 1, 1);
  points(m, 0, 1);
  points(m, 1, 1); // 22-22
  // extend to 29-29 then the 30th point wins
  for (let i = 0; i < 7; i++) {
    points(m, 0, 1);
    points(m, 1, 1);
  }
  assert.equal(m.display().sides[0].score, '29');
  points(m, 1, 1); // 30-29 cap
  assert.equal(m.display().phase, 'GAME 2');
  assert.equal(m.display().periods!.rows[1][0], '30');
  assert.equal(m.display().sides[1].serving, true, 'game winner serves first in next game');
});

test('badminton: match completes best of 3', () => {
  const m = makeMatch('badminton', 'doubles');
  points(m, 0, 21);
  points(m, 1, 21);
  assert.match(m.display().headline ?? '', /^$|POINT/);
  points(m, 0, 20);
  assert.match(m.display().headline!, /MATCH POINT · ALP/);
  points(m, 0, 1);
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 0);
  assert.equal(m.score().text.join('-'), '2-1');
  assert.match(m.display().resultText!, /Alpha won 2–1/);
});

test('table tennis: serve alternates every 2, every point at deuce, best of 5', () => {
  const m = makeMatch('table-tennis', 'singles');
  const servers: number[] = [];
  const srv = () => (m.display().sides[0].serving ? 0 : 1);
  servers.push(srv());
  for (let i = 0; i < 4; i++) {
    points(m, i % 2 === 0 ? 0 : 1, 1);
    servers.push(srv());
  }
  assert.deepEqual(servers, [0, 0, 1, 1, 0]);
  // to 10-10
  const g = m.display();
  void g;
  points(m, 0, 8);
  points(m, 1, 8); // 10-10
  const a = srv();
  points(m, 0, 1);
  const b = srv();
  assert.notEqual(a, b, 'deuce: serve changes every point');
  points(m, 0, 1); // 12-10
  assert.equal(m.display().phase, 'GAME 2');
  assert.equal(srv(), 1, 'receiver of game 1 serves first in game 2');
  for (let gm = 0; gm < 2; gm++) points(m, 0, 11);
  assert.equal(m.status, 'completed');
  assert.equal(m.score().text.join('-'), '3-0');
});

test('table tennis: timeout once per match', () => {
  const m = makeMatch('table-tennis', 'singles');
  m.record({ type: 'TIMEOUT', payload: { side: 1 } });
  assert.throws(() => m.record({ type: 'TIMEOUT', payload: { side: 1 } }), /timeouts/i);
});

test('volleyball: 25-point sets, deciding set to 15, rotation on side-out, stats', () => {
  const m = makeMatch('volleyball', 'indoor', {}, 8);
  // A serves first. B wins a rally => side-out, B rotates
  m.record({ type: 'POINT', payload: { side: 1, how: 'kill', player: 'b4' } });
  assert.equal(m.display().sides[1].detail![0], 'Rotation 2');
  assert.equal(m.display().sides[1].serving, true);
  m.record({ type: 'POINT', payload: { side: 1, how: 'ace', player: 'b1' } });
  assert.equal(m.display().sides[1].detail![0], 'Rotation 2', 'serving team does not rotate');
  m.record({ type: 'POINT', payload: { side: 0, how: 'serve_error' } }); // B served into the net
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.deepEqual(st.ace, [0, 1]);
  assert.deepEqual(st.kill, [0, 1]);
  assert.deepEqual(st.serve_error, [0, 1], 'error is attributed to the side that made it');
  // play sets: A 25-?, B, A, B → 2-2, deciding to 15
  points(m, 0, 24); // A 25-2
  points(m, 1, 25);
  points(m, 0, 25);
  points(m, 1, 25);
  assert.equal(m.display().phase, 'SET 5');
  points(m, 0, 14);
  assert.match(m.display().headline!, /MATCH POINT/);
  points(m, 0, 1);
  assert.equal(m.status, 'completed');
  assert.equal(m.score().text.join('-'), '3-2');
});

test('volleyball: two timeouts per set', () => {
  const m = makeMatch('volleyball', 'indoor');
  m.record({ type: 'TIMEOUT', payload: { side: 0 } });
  m.record({ type: 'TIMEOUT', payload: { side: 0 } });
  assert.throws(() => m.record({ type: 'TIMEOUT', payload: { side: 0 } }));
  points(m, 0, 25);
  m.record({ type: 'TIMEOUT', payload: { side: 0 } }); // reset each set
});

test('tennis: love/15/30/40, deuce, advantage, break point', () => {
  const m = makeMatch('tennis', 'singles');
  const sc = () => m.display().sides.map((s) => s.score).join('-');
  points(m, 0, 1);
  assert.equal(sc(), '15-0');
  points(m, 1, 3);
  assert.equal(sc(), '15-40');
  assert.match(m.display().headline!, /BREAK POINT · BRV/);
  points(m, 0, 2);
  assert.equal(m.display().headline, 'DEUCE');
  points(m, 1, 1);
  assert.equal(sc(), '40-AD');
  points(m, 0, 1);
  points(m, 0, 2); // A holds
  assert.equal(m.display().sides[0].detail![0], 'Games 1');
  assert.equal(m.display().sides[1].serving, true, 'serve alternates each game');
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.deepEqual(st.bpSaved, ['3/3', '0/0']);
});

function holdGames(m: any, wins: (0 | 1)[]) {
  for (const w of wins) points(m, w, 4);
}

test('tennis: 6-6 tie-break, tie-break serving order, set to winner 7-6', () => {
  const m = makeMatch('tennis', 'singles');
  holdGames(m, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]); // 6-6
  assert.equal(m.display().headline, 'TIE-BREAK');
  const srv = () => (m.display().sides[0].serving ? 0 : 1);
  const order = [srv()];
  for (let i = 0; i < 5; i++) {
    points(m, (i % 2) as 0 | 1, 1);
    order.push(srv());
  }
  // first server serves 1 point, then 2 each: A, B, B, A, A, B
  assert.deepEqual(order, [0, 1, 1, 0, 0, 1]);
  // 3-2 to A; finish 7-3
  points(m, 0, 4);
  assert.equal(m.display().phase, 'SET 2');
  assert.equal(m.display().periods!.rows[0][0], '7');
  assert.equal(m.display().periods!.rows[1][0], '6(2)');
  assert.equal(srv(), 1, 'player who received first in the tie-break serves first next set');
});

test('tennis doubles: no-ad deciding point + match tie-break at one set all', () => {
  const m = makeMatch('tennis', 'doubles');
  points(m, 0, 3);
  points(m, 1, 3);
  assert.match(m.display().headline!, /DECIDING POINT/);
  points(m, 1, 1);
  assert.equal(m.display().sides[1].detail![0], 'Games 1');
  // finish set 1 to B 6-0-ish, set 2 to A
  for (let i = 0; i < 5; i++) points(m, 1, 4);
  for (let i = 0; i < 6; i++) points(m, 0, 4);
  assert.equal(m.display().headline, 'MATCH TIE-BREAK');
  points(m, 0, 9);
  assert.match(m.display().headline!, /MATCH POINT/);
  points(m, 0, 1);
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 0);
  assert.match(m.score().extra!.setScores, /\[10-0\]/);
});

test('tennis: ace must be won by the server; double fault by receiver', () => {
  const m = makeMatch('tennis', 'singles');
  assert.throws(() => m.record({ type: 'POINT', payload: { side: 1, how: 'ace' } }));
  m.record({ type: 'POINT', payload: { side: 0, how: 'ace', serve: 1 } });
  m.record({ type: 'POINT', payload: { side: 1, how: 'double_fault' } });
  const st = Object.fromEntries(m.statistics().team.map((l) => [l.key, l.values]));
  assert.deepEqual(st.aces, [1, 0]);
  assert.deepEqual(st.doubleFaults, [1, 0]);
  assert.deepEqual(st.firstServePct, ['50%', '–']);
});

test('padel: golden point at 40-40', () => {
  const m = makeMatch('padel', 'doubles');
  points(m, 0, 3);
  points(m, 1, 3);
  assert.match(m.display().headline!, /GOLDEN POINT/);
  points(m, 1, 1);
  assert.equal(m.display().sides[1].detail![0], 'Games 1');
});

test('padel: star point — two advantages then a deciding point', () => {
  const m = makeMatch('padel', 'doubles-star-point');
  points(m, 0, 3);
  points(m, 1, 3); // deuce 1
  assert.equal(m.display().headline, 'DEUCE');
  points(m, 0, 1);
  points(m, 1, 1); // deuce 2
  assert.equal(m.display().headline, 'DEUCE');
  points(m, 0, 1);
  points(m, 1, 1); // deuce 3 => star point
  assert.match(m.display().headline!, /STAR POINT/);
  points(m, 0, 1);
  assert.equal(m.display().sides[0].detail![0], 'Games 1');
});

test('pickleball doubles side-out: 0-0-2 start, only servers score, server numbers', () => {
  const m = makeMatch('pickleball', 'doubles');
  assert.match(m.display().headline!, /CALL 0–0–2/);
  m.record({ type: 'RALLY', payload: { side: 0 } });
  assert.match(m.display().headline!, /CALL 1–0–2/);
  m.record({ type: 'RALLY', payload: { side: 1 } }); // side out (first server exception)
  assert.match(m.display().headline!, /CALL 0–1–1/);
  m.record({ type: 'RALLY', payload: { side: 0 } }); // receiving team wins: no point, server 2
  assert.match(m.display().headline!, /CALL 0–1–2/);
  assert.equal(m.display().sides[0].score, '1');
  m.record({ type: 'RALLY', payload: { side: 0 } }); // side out to A
  assert.match(m.display().headline!, /CALL 1–0–1/);
});

test('pickleball: game to 11 win by 2, match best of 3', () => {
  const m = makeMatch('pickleball', 'singles');
  for (let i = 0; i < 11; i++) m.record({ type: 'RALLY', payload: { side: 0 } });
  assert.equal(m.display().phase, 'GAME 2');
  // B serves first in game 2
  for (let i = 0; i < 11; i++) m.record({ type: 'RALLY', payload: { side: 1 } });
  assert.equal(m.display().phase, 'GAME 3');
  assert.equal(m.display().sides[0].serving, true);
  for (let i = 0; i < 11; i++) m.record({ type: 'RALLY', payload: { side: 0 } });
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 0);
});

test('pickleball rally scoring: every rally scores', () => {
  const m = makeMatch('pickleball', 'doubles-rally');
  m.record({ type: 'RALLY', payload: { side: 1 } });
  m.record({ type: 'RALLY', payload: { side: 0 } });
  assert.equal(m.display().sides.map((s) => s.score).join('-'), '1-1');
});
