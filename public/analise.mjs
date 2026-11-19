import { summarizeDemo } from './metricas.mjs';

const el = id => document.getElementById(id);
const numbers = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const count = new Intl.NumberFormat('pt-BR');
const labels = { dois_fechamentos: 'Dois fechamentos', rompimento_20: 'Rompimento de 20 velas', rsi2_media200: 'RSI de 2 períodos + média de 200' };
function row(values) {
  const tr = document.createElement('tr');
  for (const v of values) tr.insertCell().textContent = v;
  return tr;
}
async function refresh() {
  el('refresh').disabled = true;
  el('market').disabled = true;
  el('demo-table').hidden = true;
  el('demo-rows').replaceChildren();
  el('timing').textContent = '';
  try {
    const res = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error();
    const status = await res.json();
    if (!status.connected) {
      el('demo-status').textContent = 'Conecte sua conta demo pelo painel para ver os contratos liquidados.';
      return;
    }
    const history = status.execution?.trades;
    const trades = Array.isArray(history) ? history.filter(t => {
      const market = t.audit?.product === 'multiplier' ? 'RB100_MULT' : (t.symbol || '1HZ100V');
      return market === el('market').value && !t.audit?.technical_test;
    }) : null;
    if (!Array.isArray(trades)) {
      el('demo-status').textContent = 'O histórico de execução está indisponível para esta sessão.';
      return;
    }
    const { rows, median, timed } = summarizeDemo(trades);
    el('demo-status').textContent = rows[0].count + ' contratos liquidados entre os ' + trades.length +
      ' registros deste mercado entre os últimos 100 da conta.';
    if (!rows[0].count) return;
    el('demo-rows').replaceChildren(...rows.map(r => row([r.label, r.count, r.wins, r.losses, r.neutral,
      r.accuracy === null ? '—' : percent.format(r.accuracy), numbers.format(r.net) + ' ' + status.currency])));
    el('demo-table').hidden = false;
    el('timing').textContent = median === null ? 'Sem horários de entrada auditados nos contratos liquidados.' :
      'Atraso mediano entre fechamento do sinal e entrada na Deriv: ' + numbers.format(median) + ' s (' + timed + ' contratos com horários registrados).';
  } catch {
    el('demo-status').textContent = 'Não foi possível consultar a conta. Tente atualizar.';
  } finally { el('refresh').disabled = false; el('market').disabled = false; }
}
el('market').addEventListener('change', refresh);
el('refresh').addEventListener('click', refresh);
void refresh();

try {
  const response = await fetch('/estudo-1m.json', { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error();
  const { periods } = await response.json();
  function renderStudy() {
    const payout = el('payout').valueAsNumber;
    const valid = Number.isFinite(payout) && payout > 0 && el('payout').validity.valid;
    el('threshold').textContent = valid ? 'Para empatar: ' + percent.format(1 / (1 + payout)) + ' de acerto.' :
      'Informe um lucro positivo com até duas casas decimais.';
    if (valid) {
      const above = Object.values(periods.reservado.rules).filter(r => r.signals && r.accuracy > 1 / (1 + payout)).length;
      el('threshold').textContent += ' Regras com acerto observado acima desse patamar: ' + above + ' de 3.';
    }
    el('study-rows').replaceChildren(...Object.entries(periods.reservado.rules).map(([key, r]) => {
      const interval = r.daily_interval?.map(v => percent.format(v)).join(' a ') ?? '—';
      const net = valid && r.signals ? numbers.format((r.wins * payout - r.losses) * 100 / r.signals) : '—';
      return row([labels[key], count.format(r.signals), r.accuracy === null ? '—' : percent.format(r.accuracy),
        interval, r.coverage === null ? '—' : percent.format(r.coverage), net]);
    }));
  }
  el('payout').addEventListener('input', renderStudy);
  renderStudy();
} catch {
  el('threshold').textContent = 'Não foi possível carregar o estudo histórico.';
}
