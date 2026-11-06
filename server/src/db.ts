import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS settings_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, json TEXT NOT NULL, note TEXT
);

CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY, label TEXT, notes TEXT, cluster TEXT, source TEXT NOT NULL DEFAULT 'manual',
  followed INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL, removed_at INTEGER,
  user_name TEXT, x_username TEXT
);

CREATE TABLE IF NOT EXISTS watchlist_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, addresses TEXT NOT NULL, reason TEXT
);

CREATE TABLE IF NOT EXISTS wallet_sync (
  address TEXT PRIMARY KEY,
  activity_cursor_ts INTEGER,          -- newest activity timestamp fully ingested
  activity_synced_at INTEGER, activity_error TEXT, activity_error_at INTEGER, activity_failures INTEGER NOT NULL DEFAULT 0,
  backfill_done INTEGER NOT NULL DEFAULT 0, backfill_from INTEGER, backfill_truncated INTEGER NOT NULL DEFAULT 0,
  positions_synced_at INTEGER, positions_error TEXT, positions_error_at INTEGER, positions_failures INTEGER NOT NULL DEFAULT 0,
  positions_truncated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,                 -- deterministic dedupe key
  wallet TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, raw_type TEXT NOT NULL,
  condition_id TEXT, token_id TEXT, outcome TEXT, outcome_index INTEGER, side TEXT,
  size REAL, usdc_size REAL, price REAL, tx_hash TEXT, title TEXT, slug TEXT, event_slug TEXT,
  observed_at INTEGER NOT NULL,        -- when this app first saw it
  is_backfill INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts DESC);
CREATE INDEX IF NOT EXISTS activity_wallet_ts ON activity(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS activity_token_ts ON activity(token_id, ts DESC);
CREATE INDEX IF NOT EXISTS activity_cond ON activity(condition_id);

CREATE TABLE IF NOT EXISTS positions (
  wallet TEXT NOT NULL, token_id TEXT NOT NULL, condition_id TEXT NOT NULL, outcome TEXT, outcome_index INTEGER, opposite_token_id TEXT,
  size REAL NOT NULL, total_bought REAL, avg_price REAL, cost_basis REAL, current_price REAL, current_value REAL,
  realized_pnl REAL, unrealized_pnl REAL, redeemable INTEGER NOT NULL, negative_risk INTEGER NOT NULL,
  title TEXT, slug TEXT, event_slug TEXT, event_id TEXT, end_date TEXT, first_entry_at INTEGER, last_event_at INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, token_id)
);
CREATE INDEX IF NOT EXISTS positions_token ON positions(token_id);
CREATE INDEX IF NOT EXISTS positions_cond ON positions(condition_id);

-- Change log produced by reconciliation: one row each time a wallet's holding of a token changes.
CREATE TABLE IF NOT EXISTS position_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, token_id TEXT NOT NULL, condition_id TEXT NOT NULL,
  ts INTEGER NOT NULL, prev_size REAL NOT NULL, new_size REAL NOT NULL, price REAL, is_baseline INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pc_token_ts ON position_changes(token_id, ts DESC);
CREATE INDEX IF NOT EXISTS pc_wallet_ts ON position_changes(wallet, ts DESC);

CREATE TABLE IF NOT EXISTS markets (
  condition_id TEXT PRIMARY KEY, json TEXT NOT NULL, category TEXT, closed INTEGER, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  token_id TEXT PRIMARY KEY, best_bid REAL, best_ask REAL, bids TEXT, asks TEXT, book_ts INTEGER, fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_metrics (
  address TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, json TEXT NOT NULL, settings_version INTEGER
);

CREATE TABLE IF NOT EXISTS candidates (
  address TEXT PRIMARY KEY, user_name TEXT, x_username TEXT, boards TEXT NOT NULL, discovered_at INTEGER NOT NULL, run_id INTEGER
);
CREATE TABLE IF NOT EXISTS discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER, boards TEXT, candidates INTEGER, evaluated INTEGER, error TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT NOT NULL, condition_id TEXT NOT NULL,
  first_detected_at INTEGER NOT NULL, first_price REAL, first_support INTEGER NOT NULL,
  last_change_at INTEGER NOT NULL, last_computed_at INTEGER NOT NULL, state TEXT NOT NULL,
  support INTEGER NOT NULL, oppose INTEGER NOT NULL, support_value REAL, score REAL, peak_support INTEGER NOT NULL,
  ended_at INTEGER, settings_version INTEGER, baseline INTEGER NOT NULL DEFAULT 0, last_result TEXT
);
CREATE INDEX IF NOT EXISTS signals_active ON signals(ended_at, token_id);

CREATE TABLE IF NOT EXISTS signal_snapshots (
  signal_id INTEGER NOT NULL, ts INTEGER NOT NULL, support INTEGER NOT NULL, oppose INTEGER NOT NULL,
  support_value REAL, oppose_value REAL, mid REAL, score REAL, supporters TEXT
);
CREATE INDEX IF NOT EXISTS ss_sig_ts ON signal_snapshots(signal_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, severity TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, data TEXT, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_key ON alerts(key, created_at DESC);

CREATE TABLE IF NOT EXISTS paper_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL, starting_cash REAL NOT NULL, cash REAL NOT NULL,
  auto_rule TEXT, auto_enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, created_at INTEGER NOT NULL, side TEXT NOT NULL,
  token_id TEXT NOT NULL, condition_id TEXT NOT NULL, outcome TEXT, title TEXT,
  requested_usd REAL, requested_shares REAL, limit_price REAL,
  status TEXT NOT NULL,                 -- pending | filled | partial | unfilled | settled
  filled_shares REAL NOT NULL DEFAULT 0, avg_price REAL, fees REAL NOT NULL DEFAULT 0, notional REAL NOT NULL DEFAULT 0,
  quote_fetched_at INTEGER, filled_at INTEGER, fill_note TEXT, is_estimate INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL,                 -- manual | auto | settlement
  signal_id INTEGER, signal_snapshot TEXT, settings_version INTEGER, watchlist_version INTEGER
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const getMeta = (db: DB, k: string): string | null => (db.prepare('SELECT value FROM meta WHERE key=?').get(k) as any)?.value ?? null;
export const setMeta = (db: DB, k: string, v: string) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
