import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBridge,validBridgeKey} from '../dist/bridge.js';
import {createApp} from '../dist/server.js';
const key='test-only-bridge-key-'.repeat(3);
test('ponte transmite cookies, Origin e corpo sem expor credencial; preserva redirecionamento OAuth',async()=>{
  let calls=0;
  const app=createBridge('https://vps.test/tradebot-upstream/',key,async(url,options)=>{
    calls++;
    assert.equal(url,'https://vps.test/tradebot-upstream/auth/callback?code=fake');
    assert.equal(options.headers.get('X-Tradebot-Bridge'),key);
    assert.equal(options.headers.get('cookie'),'session=fake');
    assert.equal(options.headers.get('origin'),'https://tradebot-pro.onrender.com');
    assert.equal(options.redirect,'manual');
    assert.equal(new TextDecoder().decode(options.body),'{}');
    return new Response('',{status:303,headers:{Location:'/', 'Set-Cookie':'__Host-tradebot_session=fake; Secure; HttpOnly; Path=/'}});
  });
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/auth/callback?code=fake',{
      method:'POST',redirect:'manual',headers:{Cookie:'session=fake',Origin:'https://tradebot-pro.onrender.com','Content-Type':'application/json'},body:'{}'});
    assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/');
    assert.match(r.headers.get('set-cookie'),/Secure; HttpOnly/);
    assert.equal(r.headers.has('X-Tradebot-Bridge'),false);assert.equal(calls,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('ponte nunca repete POST em timeout e não retorna segredo',async()=>{
  let calls=0;
  const app=createBridge('https://vps.test/bridge/',key,async()=>{calls++;throw Error(key);});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/start',{method:'POST'});
    assert.equal(r.status,502);assert.equal((await r.text()).includes(key),false);assert.equal(calls,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('backend VPS bloqueia acesso sem chave, inclusive caracteres multibyte',async()=>{
  assert.equal(validBridgeKey('á'.repeat(key.length),key),false);
  const app=createApp({appId:'fake',bridgeKey:key,executionEnabled:false});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(url+'/api/status')).status,403);
    assert.equal((await fetch(url+'/api/status',{headers:{'X-Tradebot-Bridge':key}})).status,200);
    assert.equal((await fetch(url+'/healthz')).status,200);
  }finally{await app.locals.shutdown();await new Promise(resolve=>server.close(resolve));}
});
