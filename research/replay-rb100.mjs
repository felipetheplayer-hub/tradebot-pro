// Replay using the same signal function compiled for the demo engine.
import { readFileSync } from 'node:fs';
import { rangeRetest } from '../dist/range-signal.js';

const [file, startDate, endDate, ticksFile] = process.argv.slice(2);
const start = Date.parse(startDate) / 1000, end = Date.parse(endDate) / 1000;
if (!file || !(start < end)) throw Error('Uso: node research/replay-rb100.mjs velas.jsonl inicioUTC fimUTC [ticks.jsonl]');
const pages = file => readFileSync(file, 'utf8').trim().split('\n').map(s => JSON.parse(s));
const bars = new Map();
for (const page of pages(file)) for (const b of page) {
  if (!Number.isInteger(b.epoch) || b.epoch % 60 !== 0) continue;
  if (![b.open,b.high,b.low,b.close].every(Number.isFinite) || b.low <= 0 ||
      b.low > Math.min(b.open,b.close) || Math.max(b.open,b.close) > b.high) throw Error('OHLC inválido');
  const old = bars.get(b.epoch);
  if (old && ['open','high','low','close'].some(k => old[k] !== b[k])) throw Error('Velas conflitantes');
  bars.set(b.epoch, b);
}
const ordered = [...bars.values()].sort((a, b) => a.epoch - b.epoch);
const prices = new Map();
const listSignals = ticksFile === '--signals';
if (ticksFile && !listSignals) for (const page of pages(ticksFile)) {
  for (const [t, p] of page.ticks ?? page) {
    if (!Number.isInteger(t) || !Number.isFinite(p) || p <= 0) throw Error('Tick inválido');
    if (prices.has(t) && prices.get(t) !== p) throw Error('Ticks conflitantes');
    prices.set(t, p);
  }
}
function tickAtOrAfter(time, tolerance) {
  for (let t = time; t <= time + tolerance; t++) if (prices.has(t)) return t;
}
const signals = [];
for (let i = 60; i < ordered.length; i++) {
  const epoch = ordered[i].epoch + 60;
  if (epoch < start || epoch + 60 >= end) continue;
  const direction = rangeRetest(ordered.slice(i - 60, i + 1));
  if (direction) signals.push({epoch, direction});
}
if (listSignals) {
  console.log(JSON.stringify(signals));
  process.exit(0);
}
function score(delay, singleContract) {
  let n = 0, wins = 0, equal = 0, lastExit = -Infinity;
  for (const {epoch, direction} of signals) {
    if (singleContract && epoch + (delay ?? 0) <= lastExit) continue;
    let entry, exit, exitTime;
    if (delay === null) {
      entry = bars.get(epoch)?.open; exit = bars.get(epoch + 60)?.open; exitTime = epoch + 60;
    } else {
      const entryTime = tickAtOrAfter(epoch + delay + 1, 1);
      if (entryTime === undefined) continue;
      exitTime = tickAtOrAfter(entryTime + 60, 1);
      if (exitTime === undefined || exitTime >= end) continue;
      entry = prices.get(entryTime); exit = prices.get(exitTime);
    }
    if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
    n++; wins += direction === 'CALL' ? Number(exit > entry) : Number(exit < entry);
    equal += Number(exit === entry); lastExit = exitTime;
  }
  return { n, wins, equal, accuracy: n ? wins / n : null };
}
const results = { candles: score(null, false) };
if (ticksFile) {
  for (const delay of [0, 1, 2, 3, 4, 5, 10]) results['delay_' + delay] = score(delay, false);
  results.one_contract_delay_2 = score(2, true);
}
console.log(JSON.stringify(results, null, 2));
