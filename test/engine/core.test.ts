import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchAggregate, EventRejected, catalog, listSports } from '../../packages/engine/src/index.ts';
import { makeMatch, points } from './helpers.ts';

test('all 11 sports are registered with disciplines', () => {
  const ids = listSports().map((s) => s.id).sort();
  assert.deepEqual(ids, ['badminton', 'basketball', 'billiards', 'cricket', 'football', 'padel', 'pickleball', 'snooker', 'table-tennis', 'tennis', 'volleyball']);
  for (const s of catalog()) assert.ok(s.disciplines.length >= 1, s.id);
});

test('scoring before MATCH_START is rejected', () => {
  const m = new MatchAggregate({ id: 'x', sport: 'badminton', discipline: 'singles', config: {}, participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  assert.throws(() => m.record({ type: 'POINT', payload: { side: 0 } }), EventRejected);
  assert.equal(m.status, 'scheduled');
});

test('undo voids the last event and redo restores it (LIFO)', () => {
  const m = makeMatch('badminton', 'singles');
  points(m, 0, 3);
  points(m, 1, 1);
  assert.equal(m.display().sides[0].score, '3');
  m.record(m.undoInput()!); // undo B point
  m.record(m.undoInput()!); // undo A 3rd point
  assert.equal(m.display().sides[0].score, '2');
  assert.equal(m.display().sides[1].score, '0');
  m.record(m.redoInput()!); // redo A 3rd point
  assert.equal(m.display().sides[0].score, '3');
  m.record(m.redoInput()!); // redo B point
  assert.equal(m.display().sides[1].score, '1');
  assert.equal(m.redoInput(), null);
});

test('a new action after undo clears the redo stack', () => {
  const m = makeMatch('badminton', 'singles');
  points(m, 0, 2);
  m.record(m.undoInput()!);
  points(m, 1, 1);
  assert.equal(m.redoInput(), null);
});

test('log is append-only: undo never deletes events, replay reproduces state', () => {
  const m = makeMatch('table-tennis', 'singles');
  points(m, 0, 5);
  m.record(m.undoInput()!);
  const n = m.events.length;
  assert.equal(n, 1 + 5 + 1);
  const replay = new MatchAggregate(m.match, m.events);
  assert.deepEqual(replay.display(), m.display());
  assert.equal(replay.version, m.version);
});

test('duplicate clientEventId is idempotent (safe offline retries)', () => {
  const m = makeMatch('badminton', 'singles');
  const e = m.createEvent({ type: 'POINT', payload: { side: 0 }, clientEventId: 'dev1-0001' });
  m.append(e);
  const r = m.append({ ...e, id: 'other-id' });
  assert.equal(r.duplicate, true);
  assert.equal(m.display().sides[0].score, '1');
});

test('correction: voiding an early event re-validates later events', () => {
  const m = makeMatch('badminton', 'singles', { bestOf: 1, pointsToWin: 3, cap: 5 });
  const first = m.record({ type: 'POINT', payload: { side: 0 } });
  points(m, 0, 2); // 3-0, match over
  assert.equal(m.status, 'completed');
  m.record({ type: 'VOID', payload: { targetId: first.id } });
  assert.equal(m.status, 'live');
  assert.equal(m.display().sides[0].score, '2');
});

test('events after completion are rejected, but corrections are allowed', () => {
  const m = makeMatch('badminton', 'singles', { bestOf: 1, pointsToWin: 2, cap: 3 });
  points(m, 1, 2);
  assert.equal(m.status, 'completed');
  assert.equal(m.winner(), 1);
  assert.throws(() => m.record({ type: 'POINT', payload: { side: 0 } }), /finished/);
  m.record(m.undoInput()!);
  assert.equal(m.status, 'live');
});

test('every engine produces a renderable display + actions right after start', () => {
  for (const s of catalog()) {
    for (const d of s.disciplines) {
      const m = makeMatch(s.id, d.id);
      const disp = m.display();
      assert.equal(disp.sides.length, 2, `${s.id}/${d.id}`);
      assert.ok(m.actions().length > 0, `${s.id}/${d.id} has actions`);
      assert.ok(Array.isArray(m.statistics().team));
    }
  }
});
