export function summarizeDemo(trades) {
  const eligible = trades.filter(t => t.state === 'settled' && Number.isFinite(t.profit));
  const groups = [['Todas', eligible], ['Alta', eligible.filter(t => t.direction === 'CALL')],
    ['Baixa', eligible.filter(t => t.direction === 'PUT')]];
  const rows = groups.map(([label, group]) => {
    const wins = group.filter(t => t.profit > 0).length;
    const losses = group.filter(t => t.profit < 0).length;
    return { label, count: group.length, wins, losses, neutral: group.length - wins - losses,
      accuracy: group.length ? wins / group.length : null,
      net: group.reduce((sum, t) => sum + t.profit, 0) };
  });
  const delays = [];
  for (const t of eligible) {
    const c = t.audit?.contract;
    const entry = c?.entry_spot_time ?? c?.entry_tick_time;
    if (!Number.isFinite(entry) || !Number.isFinite(t.signal_epoch)) continue;
    const delay = entry - (t.signal_epoch + 60);
    if (delay >= 0) delays.push(delay);
  }
  delays.sort((a, b) => a - b);
  const middle = Math.floor(delays.length / 2);
  const median = delays.length ? (delays[middle] + delays[Math.floor((delays.length - 1) / 2)]) / 2 : null;
  return { rows, median, timed: delays.length };
}
