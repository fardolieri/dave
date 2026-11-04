import { DurableObject } from 'cloudflare:workers';
import { HISTORY_BUDGET_BYTES, KEEPS_PER_DAY, SYNCS_PER_DAY, SYNC_ROWS_PER_DAY, entryBytes, type HistoryUsage } from '../core/kept';
import type { KeptEntry } from '../core/protocol';

/** The one Store there is: every room's history in one window (ADR 0009). */
export const STORE_NAME = 'history';

/** Today, UTC, as the free plan's daily rows count it. */
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

type Totals = { bytes: number; entries: number; day: string; kept: number; read: number; syncs: number };

/**
 * The server's copy of every room's texts and file announcements (ADR 0009), as the Rooms broadcast them: sealed, so it
 * reads none of them. One object for all rooms, so the window is one, oldest first across them: past
 * HISTORY_BUDGET_BYTES, the entries kept longest go, whichever room they are of. Rooms hand it what they broadcast
 * (`keep`) and ask it for what a friend missed (`since`); the About dialog asks how full it is (`usage`).
 *
 * `bytes` per row is what it is counted as (core/kept.ts, entryBytes); `totals` holds their sum, so neither a keep nor
 * the About dialog adds them all up, and what today used of the free plan's rows: keeps, rows syncs read, and syncs, each
 * of which writes the totals once. Kept in storage: this object is evicted between syncs minutes apart.
 */
export class Store extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, room TEXT NOT NULL, writer TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL, entry TEXT NOT NULL)`);
    // A text the writer's app sent again after a lost socket (ticket 51) is broadcast again under the same id: kept once.
    sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS entries_by_id ON entries (room, writer, id)');
    sql.exec('CREATE INDEX IF NOT EXISTS entries_by_at ON entries (room, at)');
    sql.exec(`CREATE TABLE IF NOT EXISTS totals (one INTEGER PRIMARY KEY CHECK (one = 1), bytes INTEGER NOT NULL, entries INTEGER NOT NULL, day TEXT NOT NULL, kept INTEGER NOT NULL, read INTEGER NOT NULL, syncs INTEGER NOT NULL)`);
    sql.exec(`INSERT OR IGNORE INTO totals (one, bytes, entries, day, kept, read, syncs) VALUES (1, 0, 0, '', 0, 0, 0)`);
  }

  /** The totals, today's counts reset on a new day. */
  private totals(now: number): Totals {
    const t = this.ctx.storage.sql.exec<Totals>('SELECT bytes, entries, day, kept, read, syncs FROM totals').one();
    const day = dayOf(now);
    return t.day === day ? { ...t } : { ...t, day, kept: 0, read: 0, syncs: 0 };
  }

  private setTotals(t: Totals): void {
    this.ctx.storage.sql.exec('UPDATE totals SET bytes = ?, entries = ?, day = ?, kept = ?, read = ?, syncs = ?', t.bytes, t.entries, t.day, t.kept, t.read, t.syncs);
  }

  /**
   * Keeps one entry of `room`, then drops the oldest of all rooms until the window is within `budget` again. False when
   * today's share of keeps is used up (KEEPS_PER_DAY); a text kept already is no keep.
   */
  keep(room: string, entry: KeptEntry, budget = HISTORY_BUDGET_BYTES, now = Date.now()): boolean {
    const sql = this.ctx.storage.sql;
    const json = JSON.stringify(entry);
    const bytes = entryBytes(json);
    return this.ctx.storage.transactionSync(() => {
      const t = this.totals(now);
      if (t.kept >= KEEPS_PER_DAY) return sql.exec('SELECT 1 FROM entries WHERE room = ? AND writer = ? AND id = ?', room, entry.from.publicKey, entry.id).toArray().length > 0;
      const added = sql.exec('INSERT INTO entries (room, writer, id, at, bytes, entry) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING seq', room, entry.from.publicKey, entry.id, entry.at, bytes, json).toArray();
      if (added.length === 0) return true;
      t.bytes += bytes;
      t.entries += 1;
      t.kept += 1;
      if (t.bytes > budget) {
        // The oldest, as many as it takes and no more: read lazily, so only those rows are read.
        let last: number | null = null;
        for (const old of sql.exec<{ seq: number; bytes: number }>('SELECT seq, bytes FROM entries ORDER BY seq')) {
          if (t.bytes <= budget) break;
          t.bytes -= old.bytes;
          t.entries -= 1;
          last = old.seq;
        }
        if (last !== null) sql.exec('DELETE FROM entries WHERE seq <= ?', last);
      }
      this.setTotals(t);
      return true;
    });
  }

  /**
   * The newest `max` entries of `room` kept after `since` (the Room's clock), oldest first. Null once today's share of
   * rows read or of syncs is used up (SYNC_ROWS_PER_DAY, SYNCS_PER_DAY): not known, which is not none.
   */
  since(room: string, since: number, max: number, now = Date.now()): KeptEntry[] | null {
    const t = this.totals(now);
    if (t.read >= SYNC_ROWS_PER_DAY || t.syncs >= SYNCS_PER_DAY) return null;
    const cursor = this.ctx.storage.sql.exec<{ entry: string }>('SELECT entry FROM entries WHERE room = ? AND at > ? ORDER BY at DESC, seq DESC LIMIT ?', room, since, max);
    const rows = cursor.toArray();
    t.read += cursor.rowsRead;
    t.syncs += 1;
    this.setTotals(t);
    return rows.reverse().map((r) => JSON.parse(r.entry) as KeptEntry);
  }

  /** How full the window is, and since when it reaches back. */
  usage(now = Date.now()): HistoryUsage {
    const { bytes, entries } = this.totals(now);
    const oldest = this.ctx.storage.sql.exec<{ at: number }>('SELECT at FROM entries ORDER BY seq LIMIT 1').toArray()[0]?.at ?? null;
    return { bytes, budget: HISTORY_BUDGET_BYTES, entries, oldest, asOf: now };
  }
}
