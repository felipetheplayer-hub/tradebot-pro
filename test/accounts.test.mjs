import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../dist/server.js';

let accountData;
const app = createApp({
  appId: 'test-app',
  fetcher: async url => Response.json(url.endsWith('/token')
    ? { access_token: 'test-only', expires_in: 3600 }
    : { data: accountData }),
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const demo = { account_type: 'demo', status: 'active', balance: 10000, currency: 'USD' };
const cases = [
  [undefined, 'account-response'],
  [[], 'no-demo'],
  [[{ ...demo, account_type: 'real' }], 'no-demo'],
  [[{ ...demo, status: 'inactive' }], 'demo-inactive'],
  [[{ ...demo, balance: null }], 'demo-balance'],
  [[{ ...demo, balance: '' }], 'demo-balance'],
  [[{ ...demo, balance: 'not-a-number' }], 'demo-balance'],
  [[{ ...demo, balance: '10000.00' }], null],
  [[{ ...demo, balance: 0 }], null],
];

try {
  for (const [data, expectedError] of cases) {
    accountData = data;
    const login = await fetch(origin + '/auth/login', { redirect: 'manual' });
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const callback = await fetch(origin + '/auth/callback?code=test&state=' + state, {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    assert.equal(callback.headers.get('location'), expectedError ? '/?login=' + expectedError : '/');
    const session = callback.headers.getSetCookie().find(value => value.startsWith('__Host-tradebot_session='));
    assert.equal(Boolean(session), !expectedError);
  }
  console.log('PASS 9 cenários de contas demo, conta real, saldo textual, saldo zero e dados inválidos.');
} finally {
  await app.locals.shutdown(); server.close();
}
