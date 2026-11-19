import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoEngine, validateLimits } from '../dist/demo-engine.js';
import { DemoStore } from '../dist/demo-store.js';
import { rangeRetest } from '../dist/range-signal.js';

const epoch = 1800000000;
const limits = { stake: 1, maxLoss: 3, maxTrades: 3, strategy: 'range_retest' };
function candles(boundary, close = 10) {
  return Array.from({ length: 61 }, (_, i) => ({
    epoch: boundary - (61 - i) * 60, low: 10, high: 20, close: i === 60 ? close : 15,
  }));
}
test('reteste exige coincidência exata, duas velas anteriores e uma hora sem lacunas', () => {
  assert.equal(rangeRetest(candles(epoch)), 'CALL');
  assert.equal(rangeRetest(candles(epoch, 20)), 'PUT');
  assert.equal(rangeRetest(candles(epoch, 11)), null);
  const one = candles(epoch);
  for (const c of one.slice(1, 60)) c.low = 11;
  assert.equal(rangeRetest(one), null);
  one[1].low = 10;
  assert.equal(rangeRetest(one), 'CALL');
  one[17].epoch += 1;
  assert.equal(rangeRetest(one), null);
  assert.equal(rangeRetest(candles(epoch).slice(1)), null);
  assert.throws(() => validateLimits({ ...limits, strategy: 'anything' }));
  assert.throws(() => validateLimits({ ...limits, symbol: 'RB100' }));
});
test('fluxo demo do RB100 usa o mercado correto, veta atraso e pagamento insuficiente e preserva histórico', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb100-'));
  const path = join(dir, 'demo.sqlite');
  let store = new DemoStore(path);
  let now = epoch * 1000, payout = 1.88, lag = 0, buys = 0, sold = false;
  const broker = {
    balance: async () => 20,
    quote: async (direction, stake, symbol) => {
      assert.equal(symbol, 'RB100'); assert.equal(direction, 'CALL'); assert.equal(stake, 1);
      now += lag;
      return { price: 1, payout, parameters: {} };
    },
    buy: async () => { buys++; return 456; },
    contract: async () => ({ id: 456, sold, profit: sold ? 0.95 : null }),
    close() {},
  };
  const engine = new DemoEngine(store, async symbol => {
    assert.equal(symbol, 'RB100');
    const boundary = Math.floor(now / 60000) * 60;
    return [...candles(boundary), {epoch: boundary, low:10, high:20, close:20}];
  }, () => now, false);
  const id = 'DOT123';
  const step = async min => { now = (epoch + min * 60) * 1000; await engine.tick(id); };
  try {
    engine.start(id, validateLimits(limits), () => true, async () => broker);
    await step(1);
    assert.equal(buys, 0);
    payout = NaN; await step(2); assert.equal(buys, 0);
    payout = 1.8999; await step(3); assert.equal(buys, 0);
    payout = 1.95; lag = 5100; await step(4); assert.equal(buys, 0);
    lag = 0; payout = 1.90; await step(5); assert.equal(buys, 1);
    await step(6); assert.equal(buys, 1);
    engine.stop(id); sold = true; await step(7);
    assert.equal(engine.status(id).trades[0].symbol, 'RB100');
    assert.equal(engine.status(id).trades[0].profit, .95);
    assert.equal(engine.status(id).trades[0].audit.symbol, 'RB100');
    assert.equal(engine.status(id).trades[0].audit.strategy, 'range_retest');
    assert.equal(engine.status(id).trades[0].audit.quote_payout, 1.90);
    await engine.close(); store.close();
    store = new DemoStore(path);
    const restored = new DemoEngine(store, async () => [], () => now, false);
    assert.equal(restored.status(id).run.symbol, 'RB100');
    assert.equal(restored.status(id).trades[0].audit.quote_payout, 1.90);
    restored.start(id, { stake: 1, maxLoss: 2, maxTrades: 2 }, () => true, async () => broker);
    assert.equal(restored.status(id).run.symbol, '1HZ100V');
    assert.equal(restored.status(id).trades[0].symbol, 'RB100');
    await restored.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
