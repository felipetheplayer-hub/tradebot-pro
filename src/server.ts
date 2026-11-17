import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import WebSocket from 'ws';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1';
const APP_ID = process.env.DERIV_APP_ID?.trim();
const CALLBACK = 'https://tradebot-pro.onrender.com/auth/callback';
const AUTHORIZE_URL = 'https://auth.deriv.com/oauth2/auth';
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const ACCOUNTS_URL = 'https://api.derivws.com/trading/v1/options/accounts';
const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const SYMBOL = '1HZ100V';
const GRANULARITY = 60;
const SESSION_COOKIE = '__Host-tradebot_session';
const LOGIN_COOKIE = '__Host-tradebot_login';

type Account = { balance: number; currency: string; expiresAt: number };
type Login = { state: string; verifier: string; expiresAt: number };
type Candle = { epoch: number; open: number; high: number; low: number; close: number };

function randomId() {
  return randomBytes(32).toString('base64url');
}

function readCookie(req: Request, name: string) {
  return req.headers.cookie?.split(';').map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(name + '='))?.slice(name.length + 1) ?? '';
}

function writeCookie(res: Response, name: string, value: string, maxAge: number) {
  res.append('Set-Cookie', [
    name + '=' + value, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + maxAge,
  ].join('; '));
}

function getActive<T extends { expiresAt: number }>(entries: Map<string, T>, id: string) {
  const value = entries.get(id);
  if (value && value.expiresAt > Date.now()) return value;
  entries.delete(id);
}

function prune<T extends { expiresAt: number }>(entries: Map<string, T>) {
  for (const id of entries.keys()) getActive(entries, id);
}

async function fetchJson(fetcher: typeof fetch, url: string, options: RequestInit) {
  const response = await fetcher(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Falha na API da Deriv');
  return response.json();
}

type DemoLookup =
  | { account: { balance: number; currency: string } }
  | { error: 'account-response' | 'no-demo' | 'demo-inactive' | 'demo-balance' };

function findDemoAccount(data: unknown): DemoLookup {
  if (!Array.isArray(data)) return { error: 'account-response' };
  const demoAccounts = data.filter(account => account?.account_type === 'demo');
  const activeAccounts = demoAccounts.filter(account => account.status === 'active');
  for (const { balance, currency } of activeAccounts) {
    const amount = typeof balance === 'string' && /^-?\d+(?:\.\d+)?$/.test(balance)
      ? Number(balance) : balance;
    if (Number.isFinite(amount) && typeof currency === 'string' && /^[A-Z]{3,6}$/.test(currency)) {
      return { account: { balance: amount, currency } };
    }
  }
  if (activeAccounts.length) return { error: 'demo-balance' };
  if (demoAccounts.length) return { error: 'demo-inactive' };
  return { error: 'no-demo' };
}

export function readCandles(symbol: string): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(PUBLIC_WS, { handshakeTimeout: 5000, maxPayload: 256 * 1024 });
    const timer = setTimeout(() => fail(), 8000);

    function fail() {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error('Dados de mercado indisponíveis no momento.'));
    }

    socket.once('error', fail);
    socket.once('close', fail);
    socket.once('open', () => {
      socket.send(JSON.stringify({
        ticks_history: symbol, end: 'latest', style: 'candles',
        count: 100, granularity: GRANULARITY, req_id: 1,
      }), error => { if (error) fail(); });
    });
    socket.once('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.req_id !== 1 || message.error || !Array.isArray(message.candles)) {
          fail();
          return;
        }
        clearTimeout(timer);
        socket.removeListener('close', fail);
        resolve(message.candles.filter((candle: Candle) =>
          candle && Number.isInteger(candle.epoch) && Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) && Number.isFinite(candle.low) &&
          Number.isFinite(candle.close)));
        socket.close();
      } catch {
        fail();
      }
    });
  });
}

export function simulate(candles: Candle[], now = Math.floor(Date.now() / 1000)) {
  const byEpoch = new Map(candles.filter(candle => candle.epoch + GRANULARITY <= now)
    .map(candle => [candle.epoch, candle]));
  const closed = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  if (closed.length < 3) throw new Error('Histórico insuficiente');

  const startingBalance = 100;
  let balance = startingBalance;
  const trades = [];
  // Use only completed candles for the signal. Enter at the next open.
  for (let i = 2; i < closed.length && balance >= 1; i++) {
    const previous = closed[i - 2];
    const signal = closed[i - 1];
    const next = closed[i];
    if (signal.epoch - previous.epoch !== GRANULARITY || next.epoch - signal.epoch !== GRANULARITY) continue;
    const direction = Math.sign(signal.close - previous.close);
    if (!direction) continue;
    const move = Math.sign(next.close - next.open);
    const result = move === direction ? 0.8 : move === 0 ? 0 : -1;
    balance = Math.round((balance + result) * 100) / 100;
    trades.push({
      epoch: next.epoch, direction: direction > 0 ? 'Alta' : 'Baixa',
      entry: next.open, exit: next.close, result,
    });
  }
  return {
    mode: 'SIMULATION', symbol: SYMBOL, startingBalance, balance,
    result: Math.round((balance - startingBalance) * 100) / 100, trades,
  };
}

export function createApp({
  appId = APP_ID, fetcher = fetch, market = readCandles,
}: { appId?: string; fetcher?: typeof fetch; market?: typeof readCandles } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));
  app.use((_req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(['/auth', '/api'], (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const logins = new Map<string, Login>();
  const accounts = new Map<string, Account>();
  const candleCache = new Map<string, { value: Promise<Candle[]>; expiresAt: number }>();

  function cachedCandles(symbol: string) {
    const cached = getActive(candleCache, symbol);
    if (cached) return cached.value;
    prune(candleCache);
    if (candleCache.size >= 32) throw new Error('Limite de consultas atingido');
    const value = market(symbol);
    candleCache.set(symbol, { value, expiresAt: Date.now() + 30_000 });
    return value;
  }

  app.get('/auth/login', (req, res) => {
    if (!appId) return res.redirect(303, '/?login=config');
    prune(logins);
    if (logins.size >= 500) return res.redirect(303, '/?login=busy');
    logins.delete(readCookie(req, LOGIN_COOKIE));
    const id = randomId();
    const verifier = randomId();
    const state = randomId();
    logins.set(id, { verifier, state, expiresAt: Date.now() + 600_000 });
    writeCookie(res, LOGIN_COOKIE, id, 600);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: appId, response_type: 'code', redirect_uri: CALLBACK, scope: 'trade',
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return res.redirect(303, url.href);
  });

  app.get('/auth/callback', async (req, res) => {
    const id = readCookie(req, LOGIN_COOKIE);
    const login = getActive(logins, id);
    const { state, code, error } = req.query;
    if (!login || state !== login.state) return res.redirect(303, '/?login=expired');

    logins.delete(id);
    writeCookie(res, LOGIN_COOKIE, '', 0);
    if (!appId || error || typeof code !== 'string' || !code) {
      return res.redirect(303, '/?login=cancelled');
    }

    try {
      const token = await fetchJson(fetcher, TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, client_id: appId,
          redirect_uri: CALLBACK, code_verifier: login.verifier,
        }),
      });
      if (typeof token?.access_token !== 'string' || !token.access_token ||
          !Number.isFinite(token.expires_in) || token.expires_in < 1) {
        throw new Error('Resposta de autenticação inválida');
      }
      const result = await fetchJson(fetcher, ACCOUNTS_URL, {
        headers: { Authorization: 'Bearer ' + token.access_token, 'Deriv-App-ID': appId },
      });
      const lookup = findDemoAccount(result?.data);
      if ('error' in lookup) return res.redirect(303, '/?login=' + lookup.error);
      const demo = lookup.account;

      prune(accounts);
      if (accounts.size >= 500) return res.redirect(303, '/?login=busy');
      accounts.delete(readCookie(req, SESSION_COOKIE));
      const session = randomId();
      const maxAge = Math.floor(Math.min(token.expires_in, 3600));
      accounts.set(session, {
        balance: demo.balance, currency: demo.currency, expiresAt: Date.now() + maxAge * 1000,
      });
      writeCookie(res, SESSION_COOKIE, session, maxAge);
      return res.redirect(303, '/');
    } catch {
      return res.redirect(303, '/?login=unavailable');
    }
  });

  app.post('/auth/logout', (req, res) => {
    if (req.get('Origin') !== new URL(CALLBACK).origin) return res.sendStatus(403);
    accounts.delete(readCookie(req, SESSION_COOKIE));
    writeCookie(res, SESSION_COOKIE, '', 0);
    return res.redirect(303, '/');
  });

  app.get('/api/status', (req, res) => {
    const account = getActive(accounts, readCookie(req, SESSION_COOKIE));
    res.json({
      mode: 'DEMO_ONLY', connected: Boolean(account), running: false,
      balance: account?.balance ?? null, currency: account?.currency ?? '', trades: [],
      message: account ? 'Conta demo conectada. Saldo consultado no login.' :
        'Aguardando conexão com uma conta demo.',
      configured: Boolean(appId), executionEnabled: false,
    });
  });
  app.post('/api/connect', (_req, res) => res.status(409).json({
    error: 'Use o login OAuth para conectar uma conta demo.', loginUrl: '/auth/login',
  }));
  app.post('/api/start', (_req, res) => res.status(403).json({ error: 'Execução bloqueada.' }));
  app.post('/api/stop', (_req, res) => res.json({ running: false, executionEnabled: false }));

  app.get('/api/market/:symbol', async (req, res) => {
    const { symbol } = req.params;
    if (!/^\w{2,30}$/.test(symbol)) return res.status(400).json({ error: 'Símbolo inválido' });
    try {
      return res.json({ symbol, candles: await cachedCandles(symbol), mode: 'READ_ONLY' });
    } catch {
      return res.status(503).json({ error: 'Dados de mercado indisponíveis no momento.' });
    }
  });

  app.post('/api/simulate', async (_req, res) => {
    try {
      const candles = await cachedCandles(SYMBOL);
      return res.json(simulate(candles));
    } catch {
      return res.status(503).json({ error: 'Dados de mercado indisponíveis no momento.' });
    }
  });

  app.use(express.static(path.resolve(process.cwd(), 'public')));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(PORT, HOST, () => console.log('TradeBot Pro em ' + HOST + ':' + PORT));
}
