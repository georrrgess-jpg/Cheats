import type { DB } from '../db.js';

export type Severity = 'info' | 'warning' | 'critical';

/** Insert an alert unless one with the same key fired within `cooldownSec`. Returns true if inserted. */
export function emitAlert(db: DB, a: { now: number; kind: string; key: string; severity: Severity; title: string; body: string; data?: unknown; cooldownSec: number }): boolean {
  const last = db.prepare('SELECT created_at FROM alerts WHERE key=? ORDER BY created_at DESC LIMIT 1').get(a.key) as any;
  if (last && a.now - last.created_at < a.cooldownSec) return false;
  db.prepare('INSERT INTO alerts(created_at,kind,key,severity,title,body,data) VALUES(?,?,?,?,?,?,?)')
    .run(a.now, a.kind, a.key, a.severity, a.title, a.body, a.data === undefined ? null : JSON.stringify(a.data));
  return true;
}
