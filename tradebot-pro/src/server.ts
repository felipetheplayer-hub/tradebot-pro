import 'dotenv/config';
import express from 'express';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(express.json());
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
app.use(express.static(path.join(root, 'public')));
const PORT = Number(process.env.PORT || 3000);
const enabled = process.env.ENABLE_DEMO_TRADING === 'true';
const appId = process.env.DERIV_APP_ID || '';
const token = process.env.DERIV_DEMO_TOKEN || '';
const state = { mode: 'DEMO_ONLY', connected: false, running: false, balance: null as number | null, currency: '', trades: [] as unknown[], message: 'Aguardando configuração da conta demo' };
let socket: WebSocket | undefined;
let reqId = 0;
const pending = new Map<number, (value: any) => void>();
function request(payload: Record<string, unknown>): Promise<any> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WebSocket desconectado'));
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Tempo de resposta esgotado')); }, 12000);
    pending.set(id, (data) => { clearTimeout(timeout); if (data.error) reject(new Error(data.error.message)); else resolve(data); });
    socket!.send(JSON.stringify({ ...payload, req_id: id }));
  });
}
async function connect() {
  if (!appId || !token) throw new Error('Configure DERIV_APP_ID e DERIV_DEMO_TOKEN no ambiente');
  if (socket?.readyState === WebSocket.OPEN) return;
  socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`);
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
  socket.on('message', (raw) => {
    try { const data = JSON.parse(raw.toString()); if (data.req_id && pending.has(data.req_id)) { pending.get(data.req_id)!(data); pending.delete(data.req_id); } } catch { /* malformed message */ }
  });
  socket.on('close', () => { state.connected = false; state.running = false; state.message = 'Conexão encerrada'; });
  const auth = await request({ authorize: token });
  const account = auth.authorize;
  // Fail closed: no account other than a virtual account is ever accepted.
  if (!account?.is_virtual) { socket.close(); throw new Error('Conta real recusada. Use exclusivamente token de conta virtual.'); }
  state.connected = true;
  state.currency = account.currency || '';
  const balance = await request({ balance: 1 });
  state.balance = Number(balance.balance?.balance ?? account.balance ?? 0);
  state.message = 'Conta demo conectada. Execução automática ainda desativada.';
}
app.get('/api/status', (_req, res) => res.json({ ...state, configured: Boolean(appId && token), executionEnabled: enabled }));
app.post('/api/connect', async (_req, res) => { try { await connect(); res.json(state); } catch (error) { state.message = String(error); res.status(400).json({ error: state.message }); } });
app.post('/api/start', (_req, res) => res.status(403).json({ error: 'Execução automática indisponível neste MVP. Primeiro valide a estratégia em simulação.' }));
app.post('/api/stop', (_req, res) => { state.running = false; res.json(state); });
app.get('/api/market/:symbol', async (req, res) => {
  try {
    if (!state.connected) await connect();
    const symbol = req.params.symbol;
    if (!/^[A-Za-z0-9_]{2,25}$/.test(symbol)) return res.status(400).json({ error: 'Símbolo inválido' });
    const data = await request({ ticks_history: symbol, count: 100, end: 'latest', style: 'candles', granularity: 60 });
    res.json({ symbol, candles: data.candles || [], mode: 'READ_ONLY' });
  } catch (error) { res.status(400).json({ error: String(error) }); }
});
app.listen(PORT, '0.0.0.0', () => console.log(`TradeBot Pro em http://localhost:${PORT}`));
