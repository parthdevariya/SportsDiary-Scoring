/**
 * Property test: every discipline of every sport, played randomly through the scorer's
 * own action list, must reach a completed state, and replaying its log must reproduce
 * the exact same result (event sourcing is deterministic).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, MatchAggregate } from '../../packages/engine/src/index.ts';
import { simulate } from '../../packages/engine/src/sim.ts';
import { makeMatch } from './helpers.ts';

for (const s of catalog()) {
  for (const d of s.disciplines) {
    test(`fuzz: ${s.id}/${d.id} completes and replays identically`, () => {
      for (const seed of [1, 2, 3]) {
        const cfg = s.id === 'cricket' && d.id === 'test' ? { oversPerInnings: 3 } : s.id === 'cricket' ? { oversPerInnings: Math.min(d.defaults.oversPerInnings, 4) } : {};
        const m = makeMatch(s.id, d.id, cfg, d.sideSize && d.sideSize > 1 ? Math.max(d.sideSize, 6) : 1);
        const r = simulate(m, { seed, maxSteps: 20000 });
        assert.equal(r.stuck, null, `${s.id}/${d.id} seed ${seed} got stuck (${m.applied.length} events)`);
        assert.equal(m.status, 'completed');
        const replay = new MatchAggregate(m.match, m.events);
        assert.deepEqual(replay.display(), m.display());
        assert.deepEqual(replay.score(), m.score());
      }
    });
  }
}
