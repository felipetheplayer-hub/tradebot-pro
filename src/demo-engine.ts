import type { Broker, Direction, DemoSymbol } from './demo-broker.js';
import { BrokerError } from './demo-broker.js';
import { accountKey, DemoStore, type Limits } from './demo-store.js';

import { rangeRetest, type SignalCandle } from './range-signal.js';
type Active = {
  account: string; id: string; limits: Limits; valid: () => boolean; open: () => Promise<Broker>;
  started: number; lastEpoch: number; running: boolean; busy: boolean;
  broker?: Broker; timer?: NodeJS.Timeout; message: string;
};
export function validateLimits(value: unknown): Limits {
  const v = value as Limits;
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).some(key => !['stake', 'maxLoss', 'maxTrades', 'strategy'].includes(key)) ||
      ('strategy' in v && v.strategy !== 'range_retest') ||
      typeof v.stake !== 'number' || !Number.isFinite(v.stake) || v.stake < 0.35 || v.stake > 10 ||
      Math.abs(v.stake * 100 - Math.round(v.stake * 100)) > 1e-8 ||
      typeof v.maxLoss !== 'number' || !Number.isFinite(v.maxLoss) || v.maxLoss < v.stake || v.maxLoss > 50 ||
      Math.abs(v.maxLoss * 100 - Math.round(v.maxLoss * 100)) > 1e-8 ||
      !Number.isInteger(v.maxTrades) || v.maxTrades < 1 || v.maxTrades > 20) {
    throw new Error('Informe valor entre 0,35 e 10,00, perda máxima até 50,00 e de 1 a 20 operações.');
  }
  return { stake: v.stake, maxLoss: v.maxLoss, maxTrades: v.maxTrades, ...(v.strategy ? { strategy: v.strategy } : {}) };
}

export class DemoEngine {
  private active = new Map<string, Active>();
  private verifying = new Set<string>();
  private tasks = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private store: DemoStore, private market: (symbol: DemoSymbol) => Promise<SignalCandle[]>,
    private now = Date.now, private automatic = true) {}

  start(id: string, limits: Limits, valid: () => boolean, open: () => Promise<Broker>) {
    const account = accountKey(id);
    if (!valid()) throw new Error('Reconecte a conta demo.');
    if (this.closing || this.active.has(account) || this.verifying.has(account)) throw new Error('Já há uma execução ou verificação nesta conta.');
    if (this.store.unresolved(account).length) throw new Error('Há compras pendentes. Verifique antes de iniciar novamente.');
    const started = this.now();
    const run = this.store.createRun(account, limits, started);
    const item: Active = { account, id: run, limits, valid, open, started,
      lastEpoch: Math.floor(started / 60000) * 60 - 60,
      running: true, busy: false, message: 'Aguardando o fechamento da próxima vela.' };
    this.active.set(account, item);
    if (this.automatic) this.schedule(item);
    return run;
  }
  private schedule(item: Active) {
    item.timer = setTimeout(() => { void this.track(item).catch(() => this.cleanup(item)); }, 2000);
    item.timer.unref();
  }
  private finish(item: Active, reason: string) {
    item.running = false;
    item.message = reason;
    this.store.stop(item.id, reason);
  }
  stop(id: string, reason = 'Parada solicitada. Contratos já comprados aguardam liquidação.') {
    const item = this.active.get(accountKey(id));
    if (!item) return;
    this.finish(item, reason);
    if (!item.busy && !this.store.unresolved(item.account).length) this.cleanup(item);
  }
  private cleanup(item: Active) {
    clearTimeout(item.timer);
    item.broker?.close();
    this.active.delete(item.account);
  }
  status(id: string) {
    const account = accountKey(id);
    const item = this.active.get(account);
    return { ...this.store.summary(account), running: item?.running ?? false,
      monitoring: Boolean(item) || this.verifying.has(account), message: item?.message };
  }
  // Reconciliation is read-only. A purchase with no receipt is never resubmitted automatically.
  reconcile(id: string, open: () => Promise<Broker>) {
    const task = this.reconcileAccount(id, open);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  private async reconcileAccount(id: string, open: () => Promise<Broker>) {
    const account = accountKey(id);
    if (this.closing || this.active.has(account) || this.verifying.has(account)) throw new Error('Aguarde a execução ou verificação atual.');
    const pending = this.store.unresolved(account);
    if (!pending.length) return;
    if (pending.some(trade => trade.contract_id === null)) {
      throw new Error('Compra sem confirmação: confira o extrato Deriv. Novas compras permanecem bloqueadas; não há reenvio automático.');
    }
    // Reserve the account synchronously before opening the connection.
    this.verifying.add(account);
    let broker: Broker | undefined;
    try {
      broker = await open();
      await broker.balance();
      for (const trade of pending) {
        const contract = await broker.contract(trade.contract_id!);
        if (contract.sold && contract.profit !== null) this.store.settle(trade.id, contract.profit, contract.audit, this.now());
      }
    } finally { broker?.close(); this.verifying.delete(account); }
  }
  async tick(id: string) {
    const item = this.active.get(accountKey(id));
    if (item) await this.track(item);
  }
  private track(item: Active) {
    const task = this.tickAccount(item);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  private async tickAccount(item: Active) {
    if (item.busy) return;
    item.busy = true;
    try {
      if (!item.valid()) {
        this.finish(item, 'Sessão encerrada. Reconecte para verificar contratos pendentes.');
        this.cleanup(item);
        return;
      }
      if (this.now() - item.started >= 20 * 60_000 && item.running) this.finish(item, 'Limite de 20 minutos atingido.');
      item.broker ??= await item.open();
      const pending = this.store.unresolved(item.account);
      for (const trade of pending) {
        if (!trade.contract_id) throw new Error('Compra sem confirmação');
        const contract = await item.broker.contract(trade.contract_id);
        if (!contract.sold) { item.message = 'Aguardando liquidação do contrato demo.'; return; }
        if (contract.profit === null || !Number.isFinite(contract.profit)) throw new Error('Liquidação inválida');
        this.store.settle(trade.id, contract.profit, contract.audit, this.now());
      }
      if (!item.running) { this.cleanup(item); return; }
      const totals = this.store.totals(item.id);
      const { stake, maxLoss, maxTrades } = item.limits;
      if (totals.count >= maxTrades || Math.round((totals.net - stake) * 100) < -Math.round(maxLoss * 100)) {
        this.finish(item, 'Limite de operações ou de perda atingido.'); this.cleanup(item); return;
      }
      const retest = item.limits.strategy === 'range_retest';
      const symbol = retest ? 'RB100' : '1HZ100V';
      const maxDelay = retest ? 5 : 10;
      const candles = await this.market(symbol);
      const now = Math.floor(this.now() / 1000);
      const boundary = Math.floor(now / 60) * 60;
      const closed = [...new Map(candles.filter(c => Number.isInteger(c.epoch) && Number.isFinite(c.close) &&
        c.epoch + 60 <= now).map(c => [c.epoch, c])).values()].sort((a, b) => a.epoch - b.epoch);
      const signal = closed.at(-1), previous = closed.at(-2);
      if (!signal || !previous || signal.epoch <= item.lastEpoch) return;
      item.lastEpoch = signal.epoch;
      if (signal.epoch !== boundary - 60 || signal.epoch - previous.epoch !== 60 || now - boundary > maxDelay) return;
      const direction: Direction | null = retest ? rangeRetest(closed) :
        signal.close > previous.close ? 'CALL' : signal.close < previous.close ? 'PUT' : null;
      if (!direction) {
        if (retest) item.message = 'Aguardando fechamento em um limite com dois toques anteriores.';
        return;
      }
      const signalObservedAt = this.now();
      const balance = await item.broker.balance();
      if (balance < stake) { this.finish(item, 'Saldo demo insuficiente.'); this.cleanup(item); return; }
      const quote = await item.broker.quote(direction, stake, symbol);
      const quoteReceivedAt = this.now();
      // Stop/logout/expiry may happen during any await. Recheck immediately before committing intent.
      if (!item.running || !item.valid() || this.now() - item.started >= 20 * 60_000 ||
          this.now() / 1000 - boundary > maxDelay) return;
      if (!Number.isFinite(quote.price) || quote.price <= 0 || quote.price > stake) throw new Error('Cotação inválida');
      if (retest && (typeof quote.payout !== 'number' || !Number.isFinite(quote.payout) ||
          quote.payout < 1.9 * quote.price - 1e-12)) {
        item.message = 'Sinal ignorado. O pagamento precisa oferecer ao menos 90% líquidos.';
        return;
      }
      const trade = this.store.reserve(item.account, item.id, signal.epoch, direction, stake, {
        version: 1, symbol, strategy: retest ? 'range_retest' : 'two_closes',
        ...(Number.isFinite(quote.payout) ? { quote_payout: quote.payout } : {}),
        signal_observed_at: signalObservedAt,
        previous_epoch: previous.epoch, previous_close: previous.close, signal_close: signal.close,
        signal_closed_at: (signal.epoch + 60) * 1000,
        quote_received_at: quoteReceivedAt, quote_price: quote.price, buy_requested_at: this.now(),
      });
      try {
        // A synchronous ledger write can consume the rest of the entry window.
        if (retest && this.now() / 1000 - boundary > maxDelay) {
          this.store.reject(trade);
          item.message = 'Sinal expirou antes do envio da compra.';
          return;
        }
        const contract = await item.broker.buy(quote);
        if (!Number.isSafeInteger(contract) || contract <= 0) throw new Error('Compra sem confirmação');
        this.store.bought(trade, contract, this.now());
        item.message = item.running ? 'Contrato demo comprado; aguardando liquidação.' :
          'Parado. Aguardando liquidação do contrato já comprado.';
      } catch (error) {
        this.store.updateAudit(trade, { buy_error: error instanceof BrokerError ? error.code : 'unknown' });
        if (error instanceof BrokerError && error.code === 'rejected') this.store.reject(trade);
        throw error;
      }
    } catch {
      // No automatic reconnect/resubmit after any error, including a lost buy acknowledgement.
      this.finish(item, 'Execução interrompida. Verifique as pendências antes de reiniciar.');
      this.cleanup(item);
    } finally {
      item.busy = false;
      if (!this.closing && this.automatic && this.active.get(item.account) === item) this.schedule(item);
    }
  }
  async close() {
    this.closing = true;
    for (const item of this.active.values()) {
      if (item.id) this.finish(item, 'Servidor encerrado; início manual necessário.');
      clearTimeout(item.timer);
      item.broker?.close();
    }
    await Promise.allSettled([...this.tasks]);
    for (const item of this.active.values()) this.cleanup(item);
  }
}
