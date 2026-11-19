import type { Direction } from './demo-broker.js';

export type SignalCandle = { epoch: number; close: number; high?: number; low?: number };

// Input is sorted, deduplicated and closed by the engine.
export function rangeRetest(closed: SignalCandle[]): Direction | null {
  const window = closed.slice(-61);
  if (window.length !== 61) return null;
  const signal = window[60];
  let floor = Infinity, ceiling = -Infinity, floorTouches = 0, ceilingTouches = 0;
  for (const [i, bar] of window.entries()) {
    const { high, low, close } = bar;
    if (typeof high !== 'number' || typeof low !== 'number' || !Number.isFinite(high) ||
        !Number.isFinite(low) || !Number.isFinite(close) || low <= 0 || close < low || close > high ||
        (i > 0 && bar.epoch - window[i - 1].epoch !== 60)) return null;
    if (i === 60) break;
    if (low < floor) { floor = low; floorTouches = 1; }
    else if (low === floor) floorTouches++;
    if (high > ceiling) { ceiling = high; ceilingTouches = 1; }
    else if (high === ceiling) ceilingTouches++;
  }
  if (floor >= ceiling) return null;
  if (signal.close === floor && floorTouches >= 2) return 'CALL';
  if (signal.close === ceiling && ceilingTouches >= 2) return 'PUT';
  return null;
}
