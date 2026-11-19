import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DemoStore, accountKey } from '../dist/demo-store.js';
import { DemoEngine } from '../dist/demo-engine.js';
import { contractAudit, BrokerError } from '../dist/demo-broker.js';

test('migration preserves legacy rows, is repeatable and does not invent audit facts', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'tradebot-audit-'));
  const filename = path.join(folder, 'demo.sqlite');
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE trades (
      id TEXT PRIMARY KEY,run_id TEXT,account TEXT,signal_epoch INTEGER,direction TEXT,
      stake REAL,contract_id INTEGER,state TEXT,profit REAL,created_at INTEGER,
      UNIQUE(account,signal_epoch));`);
    legacy.prepare('INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('old', 'run', accountKey('DOT123'), 60, 'CALL', 1, 123, 'settled', -1, 120000);
    legacy.close();
    for (let i = 0; i < 2; i++) {
      const store = new DemoStore(filename);
      try {
        const trade = store.summary(accountKey('DOT123')).trades[0];
        assert.equal(trade.id, 'old'); assert.equal(trade.profit, -1); assert.equal(trade.audit, null);
      } finally { store.close(); }
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('contract metadata whitelist normalizes numeric strings and excludes credentials', () => {
  assert.deepEqual(contractAudit({ underlying_symbol:'1HZ100V', contract_type:'CALL', currency:'USD',
    entry_spot:'1496.14', entry_spot_time:1795019463, exit_spot:'bad', date_expiry:Infinity,
    token:'secret', echo_req:{token:'secret'}, url:'wss://secret' }), {
    underlying_symbol:'1HZ100V', contract_type:'CALL', currency:'USD',
    entry_spot:1496.14, entry_spot_time:1795019463,
  });
});

test('current Deriv spot fields preserve zero and ignore null or invalid values', () => {
  assert.deepEqual(contractAudit({entry_spot:'0',entry_spot_time:0,
    exit_spot:'1518.36',exit_spot_time:1795031820}), {
    entry_spot:0,entry_spot_time:0,exit_spot:1518.36,exit_spot_time:1795031820,
  });
  assert.deepEqual(contractAudit({entry_spot:null,exit_spot:'NaN',entry_spot_time:null,
    exit_spot_time:Infinity,entry_tick:999}), {});
});

test('engine persists signal facts, buy confirmation and Deriv settlement without extra purchases', async () => {
  const store = new DemoStore(':memory:'); let now = 1800000000000; let buys = 0;
  const broker = { balance:async()=>100, quote:async()=>({price:1,parameters:{}}),
    buy:async()=>{ buys++; now += 350; return 123; }, close(){},
    contract:async()=>({id:123,sold:true,profit:0.88,audit:{entry_spot:100.5,exit_spot:101,date_start:1800000060}}) };
  const engine = new DemoEngine(store,async()=>[
    {epoch:1800000000-60,close:100},{epoch:1800000000,close:101}],()=>now,false);
  try {
    engine.start('DOT123',{stake:1,maxLoss:3,maxTrades:1},()=>true,async()=>broker);
    now += 60000; await engine.tick('DOT123');
    let trade = engine.status('DOT123').trades[0];
    assert.equal(trade.audit.previous_close,100); assert.equal(trade.audit.signal_close,101);
    assert.equal(trade.audit.signal_closed_at,1800000060000);
    assert.equal(trade.audit.buy_confirmed_at-trade.audit.buy_requested_at,350);
    await engine.tick('DOT123'); trade = engine.status('DOT123').trades[0];
    assert.equal(trade.state,'settled'); assert.equal(trade.audit.contract.entry_spot,100.5);
    assert.equal(trade.audit.settlement_observed_at,now); assert.equal(buys,1);
  } finally { await engine.close(); store.close(); }
});

test('ambiguous buy logs a safe category, retains intent and blocks resubmission', async () => {
  const store = new DemoStore(':memory:'); let now = 1800000000000; let buys = 0;
  const broker = { balance:async()=>100, quote:async()=>({price:1,parameters:{}}),
    buy:async()=>{ buys++; throw new BrokerError('unavailable'); },close(){}, contract:async()=>{throw Error();} };
  const engine = new DemoEngine(store,async()=>[
    {epoch:1799999940,close:100},{epoch:1800000000,close:101}],()=>now,false);
  try {
    engine.start('DOT123',{stake:1,maxLoss:3,maxTrades:3},()=>true,async()=>broker);
    now += 60000; await engine.tick('DOT123');
    const trade = engine.status('DOT123').trades[0];
    assert.equal(trade.audit.buy_error,'unavailable'); assert.equal(trade.state,'pending');
    assert.equal(trade.audit.buy_confirmed_at,undefined);
    assert.throws(()=>engine.start('DOT123',{stake:1,maxLoss:3,maxTrades:3},()=>true,async()=>broker));
    assert.equal(buys,1);
  } finally { await engine.close(); store.close(); }
});
