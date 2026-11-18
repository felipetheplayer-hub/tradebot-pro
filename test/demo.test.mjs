import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DemoStore, accountKey } from '../dist/demo-store.js';
import { DemoEngine, validateLimits } from '../dist/demo-engine.js';
import { BrokerError, validateDemoUrl, openDemoBroker } from '../dist/demo-broker.js';
import { createApp } from '../dist/server.js';
import WebSocket, {WebSocketServer} from 'ws';

const limits = { stake: 1, maxLoss: 3, maxTrades: 3 };
function harness(options = {}) {
  let now = 1_800_000_000_000;
  let valid = true;
  let buys = 0;
  let sold = false;
  let profit = -1;
  let candles;
  const store = options.store || new DemoStore(':memory:');
  const fake = {
    balance: async () => 10000,
    quote: async () => ({price: 1, parameters: {}}),
    buy: async () => { buys++; return 123; },
    contract: async id => ({id, sold, profit: sold ? profit : null}),
    close() {}, ...options.broker,
  };
  const engine = new DemoEngine(store, async () => candles || [
    {epoch: Math.floor(now / 60000) * 60 - 120, close: 100},
    {epoch: Math.floor(now / 60000) * 60 - 60, close: 101},
  ], () => now, false);
  const id = 'DOT123';
  return { engine, store, fake, id, buys: () => buys,
    start: (l = limits) => engine.start(id, l, () => valid, async () => fake),
    advance: (ms = 60000) => now += ms, expire: () => valid = false,
    setSold: (p = -1) => { sold = true; profit = p; }, setCandles: v => candles = v,
    close: async () => { await engine.close(); store.close(); },
  };
}

test('limites rejeitam valores inválidos e parâmetros de conta/contrato arbitrários', () => {
  for (const l of [null, {}, {...limits, stake:NaN}, {...limits, stake:'1'}, {...limits, stake:0.34},
    {...limits, stake:10.01}, {...limits, stake:1.001}, {...limits, maxLoss:0.5},
    {...limits, maxLoss:Infinity}, {...limits, maxTrades:21}, {...limits, maxTrades:1.5},
    {...limits, account_type:'real'}, {...limits, symbol:'other'}]) assert.throws(() => validateLimits(l));
  assert.deepEqual(validateLimits(limits), limits);
});
test('OTP aceita exclusivamente o host e caminho demo oficiais', async () => {
  assert.match(validateDemoUrl('wss://api.derivws.com/trading/v1/options/ws/demo?otp=fake'), /\/demo\?/);
  for (const url of ['wss://api.derivws.com/trading/v1/options/ws/real?otp=fake',
    'wss://evil.test/trading/v1/options/ws/demo?otp=fake', 'ws://api.derivws.com/trading/v1/options/ws/demo?otp=fake',
    'wss://api.derivws.com:8443/trading/v1/options/ws/demo?otp=fake',
    'wss://user:secret@api.derivws.com/trading/v1/options/ws/demo?otp=fake',
    'wss://api.derivws.com/trading/v1/options/ws/demo?otp=fake&redirect=real', null]) assert.throws(() => validateDemoUrl(url));
  let calls = 0;
  await assert.rejects(openDemoBroker({id:'CR123', currency:'USD', token:'fake'}, 'app', async () => { calls++; }));
  assert.equal(calls, 0);
  await assert.rejects(openDemoBroker({id:'DOT123', currency:'USD', token:'fake'}, 'app', async () =>
    Response.json({data:{url:'wss://api.derivws.com/trading/v1/options/ws/real?otp=fake'}})));
});
test('protocolo V2 consulta identidade, limita preço e compra por parâmetros; mensagens ficam sem credenciais', async () => {
  const ws = new WebSocketServer({host:'127.0.0.1',port:0});await once(ws,'listening');
  const requests=[];
  let wrongAccount=false;
  ws.on('connection',socket=>socket.on('message',raw=>{
    const request=JSON.parse(raw.toString());requests.push(request);
    let result;
    if(request.balance) result={balance:{balance:10000,currency:'USD',loginid:wrongAccount?'CR123':'DOT123'}};
    else if(request.proposal) result={proposal:{id:'informational-only',ask_price:1}};
    else if(request.buy) result={buy:{contract_id:123}};
    else result={proposal_open_contract:{contract_id:123,is_sold:1,profit:'0.80'}};
    socket.send(JSON.stringify({...result,req_id:request.req_id}));
  }));
  let broker;
  try {
    broker=await openDemoBroker({id:'DOT123',currency:'USD',token:'fake-secret'},'fake-app',async(url,opts)=>{
      assert.equal(url,'https://api.derivws.com/trading/v1/options/accounts/DOT123/otp');
      assert.equal(opts.redirect,'error');
      return Response.json({data:{url:'wss://api.derivws.com/trading/v1/options/ws/demo?otp=fake'}});
    },url=>{assert.match(url,/\/demo\?/);return new WebSocket('ws://127.0.0.1:'+ws.address().port);});
    assert.equal(await broker.balance(),10000);
    const quote=await broker.quote('CALL',1);assert.equal(await broker.buy(quote),123);
    assert.deepEqual(await broker.contract(123),{id:123,sold:true,profit:0.8});
    const buy=requests.find(r=>r.buy);
    assert.equal(buy.buy,'1');assert.equal(buy.price,1);assert.equal(buy.parameters.underlying_symbol,'1HZ100V');
    assert.equal(buy.parameters.duration,1);assert.equal(buy.parameters.duration_unit,'m');
    assert.equal(buy.parameters.basis,'stake');assert.equal(JSON.stringify(requests).includes('fake-secret'),false);
    wrongAccount=true;await assert.rejects(broker.balance());
  } finally {broker?.close();for(const socket of ws.clients)socket.terminate();await new Promise(resolve=>ws.close(resolve));}
});
test('espera próxima vela, impede concorrência e mantém uma compra por sinal', async () => {
  const h = harness();
  try {
    h.start();
    assert.throws(() => h.start());
    await h.engine.tick(h.id);
    assert.equal(h.buys(), 0);
    h.advance();
    await Promise.all([h.engine.tick(h.id),h.engine.tick(h.id)]);
    assert.equal(h.buys(), 1);
    await h.engine.tick(h.id);
    assert.equal(h.buys(), 1);
    h.setSold(0.8);
    await h.engine.tick(h.id);
    assert.equal(h.buys(), 1);
    assert.equal(h.engine.status(h.id).trades[0].profit, 0.8);
  } finally { await h.close(); }
});
test('máximo de operações e pior perda possível interrompem novas compras', async () => {
  for (const l of [{...limits,maxTrades:1}, {...limits,maxLoss:1.5}]) {
    const h = harness();
    try {
      h.start(l); h.advance(); await h.engine.tick(h.id);
      h.setSold(); h.advance(); await h.engine.tick(h.id);
      assert.equal(h.buys(), 1);
      assert.equal(h.engine.status(h.id).running, false);
    } finally { await h.close(); }
  }
});
test('parada durante cotação impede compra; contrato comprado continua sendo acompanhado', async () => {
  let release;
  const h = harness({broker:{quote:() => new Promise(resolve => {release=resolve;})}});
  try {
    h.start(); h.advance();
    const task = h.engine.tick(h.id);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    h.engine.stop(h.id);
    release({price:1,parameters:{}});
    await task;
    assert.equal(h.buys(),0);
  } finally { await h.close(); }
  const purchased = harness();
  try {
    purchased.start(); purchased.advance(); await purchased.engine.tick(purchased.id);
    purchased.engine.stop(purchased.id);
    assert.equal(purchased.engine.status(purchased.id).running,false);
    assert.equal(purchased.engine.status(purchased.id).monitoring,true);
    purchased.setSold(); await purchased.engine.tick(purchased.id);
    assert.equal(purchased.engine.status(purchased.id).trades[0].state,'settled');
    assert.equal(purchased.buys(),1);
  } finally { await purchased.close(); }
});
test('sessão expirada, saldo insuficiente, sinal antigo e limite de duração não compram', async () => {
  for (const setup of [h => h.expire(), h => h.setCandles([{epoch:100,close:1},{epoch:160,close:2}]),
    h => h.advance(20*60000), h => h.advance(11000)]) {
    const h = harness();
    try { h.start(); h.advance(); setup(h); await h.engine.tick(h.id); assert.equal(h.buys(),0); }
    finally { await h.close(); }
  }
  const h = harness({broker:{balance:async()=>0}});
  try {h.start();h.advance();await h.engine.tick(h.id);assert.equal(h.buys(),0);assert.equal(h.engine.status(h.id).running,false);}
  finally {await h.close();}
});
test('compra sem resposta permanece pendente, bloqueia reinício e nunca é reenviada', async () => {
  let attempts = 0;
  const h = harness({broker:{buy:async()=>{attempts++;throw new BrokerError('unavailable');}}});
  try {
    h.start();h.advance();await h.engine.tick(h.id);
    assert.equal(h.engine.status(h.id).trades[0].state,'pending');
    assert.equal(h.engine.status(h.id).running,false);
    assert.throws(()=>h.start());
    await assert.rejects(h.engine.reconcile(h.id,async()=>h.fake));
    h.advance();await h.engine.tick(h.id);
    assert.equal(attempts,1);
  } finally {await h.close();}
});
test('rejeição explícita da corretora não é tratada como contrato aberto', async () => {
  const h = harness({broker:{buy:async()=>{throw new BrokerError('rejected');}}});
  try {h.start();h.advance();await h.engine.tick(h.id);assert.equal(h.engine.status(h.id).trades[0].state,'rejected');h.start();}
  finally {await h.close();}
});
test('histórico persiste, exige início manual e reconcilia contrato após reinício', async () => {
  const folder = mkdtempSync(path.join(tmpdir(),'tradebot-test-'));
  const filename = path.join(folder,'demo.sqlite');
  const h = harness({store:new DemoStore(filename)});
  try {
    h.start();h.advance();await h.engine.tick(h.id);
    assert.throws(()=>new DemoStore(filename));
    await h.close();
    const store = new DemoStore(filename);
    const restored = harness({store});
    try {
      assert.equal(restored.engine.status(restored.id).running,false);
      assert.equal(restored.engine.status(restored.id).trades[0].contract_id,123);
      assert.throws(()=>restored.start());
      restored.setSold(0.8);
      await restored.engine.reconcile(restored.id,async()=>restored.fake);
      assert.equal(restored.engine.status(restored.id).unresolved,0);
      assert.equal(restored.engine.status('DOT999').trades.length,0);
      assert.equal(restored.buys(),0);
      restored.start();
    } finally {await restored.close();}
  } finally {rmSync(folder,{recursive:true,force:true});}
});
test('falha de gravação da intenção impede envio de compra', async () => {
  const h = harness();
  try {
    h.start();h.store.reserve=()=>{throw Error('disk full');};h.advance();await h.engine.tick(h.id);
    assert.equal(h.buys(),0);
    assert.equal(h.engine.status(h.id).running,false);
  } finally {await h.close();}
});
test('API isola sessões, valida Origin e exige demo identificada; logout interrompe execução', async () => {
  const store = new DemoStore(':memory:');
  let account = {account_id:'DOT123',account_type:'demo',status:'active',balance:'10000',currency:'USD'};
  let opened = 0;
  const app = createApp({appId:'fake-app',executionEnabled:true,store,automatic:false,
    fetcher:async url=>Response.json(url.includes('/oauth2/token')
      ? {access_token:'fake-secret',expires_in:3600} : {data:[account]}),
    broker:async()=>{opened++;throw Error('should not open');},
  });
  const server = app.listen(0,'127.0.0.1');await once(server,'listening');
  const base = 'http://127.0.0.1:'+server.address().port;
  const request = (route,options={})=>fetch(base+route,{redirect:'manual',...options});
  async function login() {
    const login = await request('/auth/login');
    const url = new URL(login.headers.get('location'));
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const callback = await request('/auth/callback?code=fake&state='+url.searchParams.get('state'),{headers:{Cookie:cookie}});
    return callback.headers.getSetCookie().find(c=>c.startsWith('__Host-tradebot_session='))?.split(';')[0];
  }
  try {
    const session = await login();
    const headers = {Cookie:session,Origin:'https://tradebot-pro.onrender.com','Content-Type':'application/json'};
    const start = () => request('/api/start',{method:'POST',headers,body:JSON.stringify(limits)});
    assert.equal((await request('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(limits)})).status,403);
    assert.equal((await request('/api/start',{method:'POST',headers:{Origin:headers.Origin},body:'{}'})).status,401);
    assert.equal((await start()).status,200);
    assert.equal((await start()).status,409);
    const status = await (await request('/api/status',{headers})).json();
    assert.equal(status.running,true);assert.equal(status.realExecutionEnabled,false);
    assert.equal(JSON.stringify(status).includes('fake-secret'),false);
    assert.equal((await (await request('/api/status')).json()).execution,null);
    const otherSession = await login();
    assert.equal((await request('/api/start',{method:'POST',headers:{...headers,Cookie:otherSession},body:JSON.stringify(limits)})).status,409);
    assert.equal((await request('/auth/logout',{method:'POST',headers})).status,303);
    assert.equal((await (await request('/api/status',{headers})).json()).connected,false);
    assert.equal(opened,0);
    account = {...account,account_id:'CR999',account_type:'real'};
    assert.equal(await login(),undefined);
  } finally {await app.locals.shutdown();store.close();await new Promise(resolve=>server.close(resolve));}
});
