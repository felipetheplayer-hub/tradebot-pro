import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDemo } from '../public/metricas.mjs';

test('métricas usam só liquidações finitas, incluem neutros e aceitam histórico sem auditoria', () => {
  const { rows, timed, median } = summarizeDemo([
    { state: 'settled', direction: 'CALL', profit: 0.88 },
    { state: 'settled', direction: 'PUT', profit: -1, signal_epoch: 60, audit: { contract: { entry_tick_time: 125 } } },
    { state: 'settled', direction: 'CALL', profit: 0, signal_epoch: 120, audit: { contract: { entry_spot_time: 187 } } },
    { state: 'open', direction: 'PUT', profit: 1 },
    { state: 'settled', direction: 'CALL', profit: null },
  ]);
  assert.deepEqual(rows.map(r => [r.count, r.wins, r.losses, r.neutral]), [[3, 1, 1, 1], [2, 1, 0, 1], [1, 0, 1, 0]]);
  assert.equal(rows[0].accuracy, 1 / 3);
  assert.ok(Math.abs(rows[0].net + .12) < 1e-10);
  assert.equal(timed, 2);
  assert.equal(median, 6);
  assert.equal(summarizeDemo([]).rows[0].accuracy, null);
});
