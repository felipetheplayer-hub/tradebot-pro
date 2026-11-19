import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { openDemoBroker, BrokerError } from '../dist/demo-broker.js';
import { DemoEngine, validateLimits } from '../dist/demo-engine.js';
import { DemoStore } from '../dist/demo-store.js';

const epoch = 1800000000;
const limits = { stake: 1, maxLoss: 1, maxTrades: 1, strategy: 'range_multiplier', test: true };

test('multiplicador rejeita teste sem limite de uma compra e valores inválidos', () => {
  assert.deepEqual(validateLimits(limits), limits);
  for (const value of [
    { ...limits, maxTrades: 2 }, { ...limits, stake: .35 },
    { ...limits, strategy: 'range_retest' }, { ...limits, test: false },
    { ...limits, strategy: ['range_multiplier'] },
  ]) assert.throws(() => validateLimits(value));
});

test('propostas e compra de multiplicadores enviam proteção sem duração binária e vendem o contrato conhecido', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests = [];
  let unsafe = false, sold = false;
  server.on('connection', socket => socket.on('message', raw => {
    const r = JSON.parse(raw.toString());
    requests.push(r);
    let result;
    if (r.contracts_for) result = { contracts_for: { available: [
      { underlying_symbol: 'RB100', contract_type: 'MULTUP', multiplier_range: [20,40] },
      { underlying_symbol: 'RB100', contract_type: 'MULTDOWN', multiplier_range: [400,1000] },
    ] } };
    else if (r.proposal && r.multiplier === 20) {
      socket.send(JSON.stringify({ error: { code: 'ContractBuyValidationError',
        message: 'Multiplier is not in acceptable range. Accepts 400,1000,2000.' }, req_id: r.req_id }));
      return;
    }
    else if (r.proposal) result = { proposal: {
      ask_price: 1, multiplier: 400, limit_order: {
        stop_loss: { display_order_amount: unsafe ? '-1.00' : '-0.50' },
        take_profit: { display_order_amount: '1.00' },
      },
    } };
    else if (r.buy) result = { buy: { contract_id: 456 } };
    else if (r.sell) { sold = true; result = { sell: { contract_id: 456, sold_for: 1.02 } }; }
    else result = { proposal_open_contract: {
      contract_id: 456, is_sold: sold ? 1 : 0, is_valid_to_sell: sold ? 0 : 1,
      profit: sold ? '0.02' : '-0.02', multiplier: 400, commission: '.02',
    } };
    socket.send(JSON.stringify({ ...result, req_id: r.req_id }));
  }));
  let broker;
  try {
    broker = await openDemoBroker({ id: 'DOT123', currency: 'USD', token: 'fake' }, 'app',
      async () => Response.json({ data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=fake' } }),
      () => new WebSocket('ws://127.0.0.1:' + server.address().port));
    const up = await broker.quoteMultiplier('CALL', 1);
    const down = await broker.quoteMultiplier('PUT', 1);
    assert.equal(up.parameters.contract_type, 'MULTUP');
    assert.equal(down.parameters.contract_type, 'MULTDOWN');
    assert.equal(up.parameters.duration, undefined);
    assert.equal(up.parameters.duration_unit, undefined);
    assert.deepEqual(up.parameters.limit_order, { stop_loss: .5, take_profit: 1 });
    assert.equal(up.parameters.underlying_symbol, 'RB100');
    assert.equal(up.parameters.multiplier, 400);
    unsafe = true;
    await assert.rejects(broker.quoteMultiplier('CALL', 1));
    unsafe = false;
    assert.equal(await broker.buy(up), 456);
    assert.equal((await broker.contract(456)).sellable, true);
    await broker.sell(456);
    assert.equal((await broker.contract(456)).profit, .02);
    assert.equal(requests.find(r => r.sell).sell, 456);
    assert.equal(requests.find(r => r.sell).price, 0);
    assert.deepEqual(requests.filter(r => r.proposal && r.contract_type === 'MULTUP').slice(0,2).map(r => r.multiplier), [20,400]);
  } finally {
    broker?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

function setup() {
  const store = new DemoStore(':memory:');
  let now = epoch * 1000 + 15000, valid = true, sold = false;
  let buys = 0, sells = 0, failSale = false;
  const broker = {
    balance: async () => 100,
    quoteMultiplier: async () => ({ price: 1, parameters: { multiplier: 20 } }),
    buy: async () => { buys++; return 456; },
    contract: async () => ({ id: 456, sold, sellable: !sold, profit: sold ? -.02 : null,
      audit: { underlying_symbol: 'RB100', contract_type: 'MULTUP', multiplier: 400 } }),
    sell: async () => {
      sells++;
      if (failSale) throw new BrokerError('unavailable');
      sold = true;
    },
    close() {},
  };
  const engine = new DemoEngine(store, async () => {
    const boundary = Math.floor(now / 60000) * 60;
    return [{ epoch: boundary - 120, close: 10 }, { epoch: boundary - 60, close: 11 }];
  }, () => now, false);
  return { store, engine, broker, stats: () => ({ buys, sells }),
    advance: ms => { now += ms; }, expire: () => { valid = false; },
    failSale: value => { failSale = value; },
    start: () => engine.start('DOT123', limits, () => valid, async () => broker),
    close: async () => { await engine.close(); store.close(); } };
}

test('teste técnico compra uma vez, fecha após 60 segundos e preserva auditoria', async () => {
  const h = setup();
  try {
    h.start(); await h.engine.tick('DOT123');
    assert.deepEqual(h.stats(), { buys: 1, sells: 0 });
    let trade = h.engine.status('DOT123').trades[0];
    assert.equal(trade.symbol, 'RB100');
    assert.equal(trade.audit.product, 'multiplier');
    assert.equal(trade.audit.technical_test, true);
    h.advance(59000); await h.engine.tick('DOT123');
    assert.equal(h.stats().sells, 0);
    h.advance(1000); await h.engine.tick('DOT123');
    trade = h.engine.status('DOT123').trades[0];
    assert.deepEqual(h.stats(), { buys: 1, sells: 1 });
    assert.equal(trade.state, 'settled');
    assert.equal(trade.profit, -.02);
    assert.equal(h.engine.status('DOT123').unresolved, 0);
    assert.equal(h.engine.status('DOT123').running, false);
  } finally { await h.close(); }
});

test('falha de venda preserva contrato e reconciliação fecha posição sem recomprar', async () => {
  const h = setup();
  try {
    h.start(); await h.engine.tick('DOT123');
    h.failSale(true); h.advance(60000); await h.engine.tick('DOT123');
    assert.equal(h.engine.status('DOT123').unresolved, 1);
    assert.throws(h.start);
    h.failSale(false);
    await h.engine.reconcile('DOT123', async () => h.broker);
    assert.deepEqual(h.stats(), { buys: 1, sells: 2 });
    assert.equal(h.engine.status('DOT123').unresolved, 0);
  } finally { await h.close(); }
});

test('expiração da sessão fecha multiplicador existente sem comprar outro', async () => {
  const h = setup();
  try {
    h.start(); await h.engine.tick('DOT123');
    h.expire(); await h.engine.tick('DOT123');
    assert.deepEqual(h.stats(), { buys: 1, sells: 1 });
    assert.equal(h.engine.status('DOT123').unresolved, 0);
    assert.equal(h.engine.status('DOT123').monitoring, false);
  } finally { await h.close(); }
});
