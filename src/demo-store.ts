import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Direction } from './demo-broker.js';

export type Limits = { stake: number; maxLoss: number; maxTrades: number };
export type Trade = {
  id: string; run_id: string; signal_epoch: number; direction: Direction; stake: number;
  contract_id: number | null; state: string; profit: number | null; created_at: number;
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
      CREATE INDEX IF NOT EXISTS trades_account ON trades(account, created_at);
      UPDATE runs SET state='stopped', reason='Servidor reiniciado; início manual necessário.',
        ended_at=unixepoch()*1000 WHERE state='running';
      COMMIT;`); }
    catch (error) { this.db.close(); throw error; }
  }
  createRun(account: string, limits: Limits, now: number) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO runs VALUES (?,?,'running','Aguardando próximo sinal.',?,?,?,?,NULL)`)
      .run(id, account, limits.stake, limits.maxLoss, limits.maxTrades, now);
    return id;
  }
  stop(id: string, reason: string) {
    this.db.prepare("UPDATE runs SET state='stopped',reason=?,ended_at=? WHERE id=?")
      .run(reason, Date.now(), id);
  }
  reserve(account: string, run: string, epoch: number, direction: Direction, stake: number) {
    const id = randomUUID();
    // Commit the intent before sending a buy. On ambiguous failure it remains unresolved.
    this.db.prepare(`INSERT INTO trades VALUES (?,?,?,?,?,?,NULL,'pending',NULL,?)`)
      .run(id, run, account, epoch, direction, stake, Date.now());
    return id;
  }
  bought(id: string, contractId: number) {
    this.db.prepare("UPDATE trades SET state='open',contract_id=? WHERE id=?").run(contractId, id);
  }
  settle(id: string, profit: number) {
    this.db.prepare("UPDATE trades SET state='settled',profit=? WHERE id=?").run(profit, id);
  }
  reject(id: string) { this.db.prepare("UPDATE trades SET state='rejected' WHERE id=?").run(id); }
  unresolved(account: string): Trade[] {
    return this.db.prepare("SELECT * FROM trades WHERE account=? AND state IN ('pending','open') ORDER BY created_at")
      .all(account) as Trade[];
  }
  summary(account: string) {
    const run = this.db.prepare('SELECT * FROM runs WHERE account=? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(account);
    const trades = this.db.prepare(`SELECT id,run_id,signal_epoch,direction,stake,contract_id,state,profit,created_at
      FROM trades WHERE account=? ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(account);
    return { run: run ?? null, trades, unresolved: this.unresolved(account).length };
  }
  totals(run: string) {
    const row = this.db.prepare(`SELECT count(*) AS count,coalesce(sum(profit),0) AS net
      FROM trades WHERE run_id=? AND state!='rejected'`).get(run)!;
    return { count: Number(row.count), net: Math.round(Number(row.net) * 100) / 100 };
  }
  close() { this.db.close(); }
}
