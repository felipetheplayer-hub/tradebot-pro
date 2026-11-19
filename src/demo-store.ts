import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ContractAudit, Direction } from './demo-broker.js';

export type TradeAudit = {
  version: 1;
  signal_observed_at: number;
  previous_epoch: number; previous_close: number; signal_close: number;
  signal_closed_at: number; quote_received_at: number; quote_price: number;
  buy_requested_at: number; buy_confirmed_at?: number;
  settlement_observed_at?: number; contract?: ContractAudit;
  symbol?: 'RB100' | '1HZ100V'; strategy?: 'range_retest' | 'range_multiplier' | 'two_closes'; quote_payout?: number;
  product?: 'multiplier'; multiplier?: number; stop_loss?: number; take_profit?: number;
  close_at?: number; close_requested_at?: number; technical_test?: boolean;
  buy_error?: 'rejected' | 'unavailable' | 'invalid' | 'unknown';
};

export type Limits = { stake: number; maxLoss: number; maxTrades: number; strategy?: 'range_retest' | 'range_multiplier'; test?: true };
export type Trade = {
  id: string; run_id: string; signal_epoch: number; direction: Direction; stake: number;
  contract_id: number | null; state: string; profit: number | null; created_at: number;
  audit?: TradeAudit | null;
};
export const accountKey = (id: string) => createHash('sha256').update('tradebot-demo:' + id).digest('hex');

export class DemoStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    // Keep the exclusive SQLite lock across commits: a second worker cannot run this database.
    try { this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
        stake REAL NOT NULL, max_loss REAL NOT NULL, max_trades INTEGER NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, account TEXT NOT NULL, signal_epoch INTEGER NOT NULL,
        direction TEXT NOT NULL, stake REAL NOT NULL, contract_id INTEGER, state TEXT NOT NULL,
        profit REAL, created_at INTEGER NOT NULL,
        UNIQUE(account, signal_epoch)
      );
      CREATE TABLE IF NOT EXISTS range_runs (run_id TEXT PRIMARY KEY REFERENCES runs(id));
      CREATE TABLE IF NOT EXISTS multiplier_runs (run_id TEXT PRIMARY KEY REFERENCES runs(id), technical_test INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS trades_account ON trades(account, created_at);
      UPDATE runs SET state='stopped', reason='Servidor reiniciado; início manual necessário.',
        ended_at=unixepoch()*1000 WHERE state='running';
      COMMIT;`);
      const columns = this.db.prepare('PRAGMA table_info(trades)').all();
      if (!columns.some(column => column.name === 'audit_json')) {
        this.db.exec('ALTER TABLE trades ADD COLUMN audit_json TEXT');
      }
    }
    catch (error) { this.db.close(); throw error; }
  }
  createRun(account: string, limits: Limits, now: number) {
    const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO runs (id,account,state,reason,stake,max_loss,max_trades,started_at)
        VALUES (?,?,'running','Aguardando próximo sinal.',?,?,?,?)`)
        .run(id, account, limits.stake, limits.maxLoss, limits.maxTrades, now);
      if (limits.strategy === 'range_retest') this.db.prepare('INSERT INTO range_runs VALUES (?)').run(id);
      if (limits.strategy === 'range_multiplier') this.db.prepare('INSERT INTO multiplier_runs VALUES (?,?)').run(id, limits.test ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return id;
  }
  stop(id: string, reason: string) {
    this.db.prepare("UPDATE runs SET state='stopped',reason=?,ended_at=? WHERE id=?")
      .run(reason, Date.now(), id);
  }
  reserve(account: string, run: string, epoch: number, direction: Direction, stake: number, audit?: TradeAudit) {
    const id = randomUUID();
    // Commit the intent before sending a buy. On ambiguous failure it remains unresolved.
    this.db.prepare(`INSERT INTO trades
      (id,run_id,account,signal_epoch,direction,stake,contract_id,state,profit,created_at,audit_json)
      VALUES (?,?,?,?,?,?,NULL,'pending',NULL,?,?)`)
      .run(id, run, account, epoch, direction, stake, Date.now(), audit ? JSON.stringify(audit) : null);
    return id;
  }
  updateAudit(id: string, patch: Partial<TradeAudit>) {
    this.db.prepare('UPDATE trades SET audit_json=? WHERE id=?').run(this.mergedAudit(id, patch), id);
  }
  private mergedAudit(id: string, patch: Partial<TradeAudit>) {
    const row = this.db.prepare('SELECT audit_json FROM trades WHERE id=?').get(id);
    if (!row) throw new Error('Operação não encontrada.');
    const existing = row.audit_json ? JSON.parse(String(row.audit_json)) : {};
    return JSON.stringify({ ...existing, ...patch });
  }
  bought(id: string, contractId: number, confirmedAt = Date.now()) {
    const audit = this.mergedAudit(id, { buy_confirmed_at: confirmedAt });
    this.db.prepare("UPDATE trades SET state='open',contract_id=?,audit_json=? WHERE id=?")
      .run(contractId, audit, id);
  }
  settle(id: string, profit: number, contract?: ContractAudit, observedAt = Date.now()) {
    const audit = this.mergedAudit(id, { settlement_observed_at: observedAt, ...(contract ? { contract } : {}) });
    this.db.prepare("UPDATE trades SET state='settled',profit=?,audit_json=? WHERE id=?")
      .run(profit, audit, id);
  }
  reject(id: string) { this.db.prepare("UPDATE trades SET state='rejected' WHERE id=?").run(id); }
  unresolved(account: string): Trade[] {
    return this.db.prepare("SELECT * FROM trades WHERE account=? AND state IN ('pending','open') ORDER BY created_at")
      .all(account).map(({ audit_json, ...trade }) => ({ ...trade,
        audit: audit_json ? JSON.parse(String(audit_json)) : null })) as Trade[];
  }
  summary(account: string) {
    const run = this.db.prepare(`SELECT *, CASE WHEN id IN (SELECT run_id FROM range_runs UNION SELECT run_id FROM multiplier_runs)
      THEN 'RB100' ELSE '1HZ100V' END AS symbol,
      CASE WHEN id IN (SELECT run_id FROM multiplier_runs) THEN 'multiplier' ELSE 'binary' END AS product
      FROM runs WHERE account=? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(account);
    const trades = this.db.prepare(`SELECT id,run_id,signal_epoch,direction,stake,contract_id,state,profit,created_at,audit_json,
      CASE WHEN run_id IN (SELECT run_id FROM range_runs UNION SELECT run_id FROM multiplier_runs) THEN 'RB100' ELSE '1HZ100V' END AS symbol
      FROM trades WHERE account=? ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(account)
      .map(({ audit_json, ...trade }) => ({ ...trade, audit: audit_json ? JSON.parse(String(audit_json)) : null }));
    return { run: run ?? null, trades, unresolved: this.unresolved(account).length };
  }
  totals(run: string) {
    const row = this.db.prepare(`SELECT count(*) AS count,coalesce(sum(profit),0) AS net
      FROM trades WHERE run_id=? AND state!='rejected'`).get(run)!;
    return { count: Number(row.count), net: Math.round(Number(row.net) * 100) / 100 };
  }
  close() { this.db.close(); }
}
