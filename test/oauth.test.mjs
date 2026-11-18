import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp, readCandles } from '../dist/server.js';

let realOnly = false;
let exchanges = 0;
let challenge;
const app = createApp({
  appId: 'testing-app', executionEnabled: false, market: async () => Array.from({length:100}, (_, i) => ({epoch:Math.floor(Date.now()/60000)*60-(101-i)*60,open:100+i,high:102+i,low:99+i,close:101+i})),
  fetcher: async (url, options) => {
    if (url === 'https://auth.deriv.com/oauth2/token') {
      exchanges++;
      assert.equal(options.body.get('redirect_uri'), 'https://tradebot-pro.onrender.com/auth/callback');
      assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), challenge);
      return Response.json({access_token: 'test-credential', expires_in: 5400});
    }
    assert.equal(url, 'https://api.derivws.com/trading/v1/options/accounts');
    assert.equal(options.headers['Deriv-App-ID'], 'testing-app');
    assert.equal(options.headers.Authorization, 'Bearer test-credential');
    return Response.json({data: [
      {account_type: 'real', status: 'active', balance: 123456, currency: 'USD'},
      ...realOnly ? [] : [{account_type: 'demo', status: 'active', balance: 172.3, currency: 'EUR'}],
    ]});
  },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const request = (path, options) => fetch(origin + path, { redirect: 'manual', ...options });
const cookiePart = value => value.split(';')[0];

try {
  async function login() {
    const response = await request('/auth/login');
    assert.equal(response.status, 303);
    const cookie = response.headers.getSetCookie()[0];
    assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
    const authUrl = new URL(response.headers.get('location'));
    assert.equal(authUrl.origin, 'https://auth.deriv.com');
    assert.equal(authUrl.searchParams.get('scope'), 'trade');
    challenge = authUrl.searchParams.get('code_challenge');
    return {
      state: authUrl.searchParams.get('state'),
      headers: {Cookie: cookiePart(cookie)},
    };
  }

  const {state, headers} = await login();
  const callback = '/auth/callback?code=test-code&state=';
  assert.equal((await request(callback + 'forged', {headers})).headers.get('location'), '/?login=expired');
  assert.equal(exchanges, 0);
  const verified = await request(callback + state, {headers});
  assert.equal(verified.headers.get('location'), '/');
  assert.equal(exchanges, 1);
  const session = cookiePart(verified.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-tradebot_session=')));
  const ownHeaders = {Cookie: session};
  assert.doesNotMatch(session, /test-credential/);
  const status = await (await request('/api/status', {headers: ownHeaders})).json();
  assert.equal(status.balance, 172.3);
  assert.equal(status.currency, 'EUR');
  assert.equal(status.executionEnabled, false);
  assert.equal((await (await request('/api/status')).json()).balance, null);
  assert.equal((await request(callback + state, {headers})).headers.get('location'), '/?login=expired');
  assert.equal(exchanges, 1);

  realOnly = true;
  const denied = await login();
  assert.equal((await request(callback + denied.state, {headers: denied.headers})).headers.get('location'), '/?login=no-demo');
  assert.equal((await request('/api/start', {method: 'POST', headers: ownHeaders})).status, 403);
  assert.equal((await request('/api/buy', {method: 'POST', headers: ownHeaders})).status, 404);
  assert.equal((await request('/auth/logout', {method: 'POST', headers: ownHeaders})).status, 403);
  const logout = await request('/auth/logout', {
    method: 'POST', headers: {...ownHeaders, Origin: 'https://tradebot-pro.onrender.com'},
  });
  assert.equal(logout.status, 303);
  assert.equal((await (await request('/api/status', {headers: ownHeaders})).json()).connected, false);

  const html = await request('/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Rodar simulação/);
  const simulation = await request('/api/simulate', {method: 'POST'});
  assert.equal(simulation.status, 200);
  const result = await simulation.json();
  assert.equal(result.mode, 'SIMULATION');
  assert.equal(result.symbol, '1HZ100V');
  assert.ok(result.trades.length > 0);
  assert.equal(result.result, Math.round(result.trades.reduce((sum, t) => sum + t.result, 0) * 100) / 100);
  console.log('PASS OAuth PKCE, CSRF, replay, isolamento, demo, logout, bloqueio e simulação Deriv com', result.trades.length, 'operações.');
} finally {
  await app.locals.shutdown(); server.close();
}
