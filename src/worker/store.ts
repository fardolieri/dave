import { DurableObject } from 'cloudflare:workers';
import { HISTORY_BUDGET_BYTES, SYNCS_PER_DAY, SYNC_ROWS_PER_DAY, WRITES_PER_DAY, entryBytes, pieceBytes, type HistoryUsage } from '../core/kept';
import type { KeptEntry } from '../core/protocol';

/** The one Store there is: every room's history in one window (ADR 0009). */
export const STORE_NAME = 'history';

/** Today, UTC, as the free plan's daily rows count it. */
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** `written`: rows written today by keeps, what they drop from the window's tail included (the column `kept`). */
type Totals = { bytes: number; entries: number; day: string; written: number; read: number; syncs: number };
/** The writer a file's pieces are kept under: no friend's key is empty, so a sync never brings them (`since`). */
const PIECES = '';

/**
 * The server's copy of every room's texts and file announcements (ADR 0009), as the Rooms broadcast them, and the
 * pieces of the files they announce, up to KEPT_FILE_MAX: all sealed, so it reads none of them. One object for all rooms, so the window is one, oldest first across them: past
 * HISTORY_BUDGET_BYTES, the entries kept longest go, whichever room they are of. Rooms hand it what they broadcast
 * (`keep`, `keepPiece`) and ask it for what a friend missed (`since`, `piece`); the About dialog asks how full it is
 * (`usage`). A piece is an entry like a text, under no writer (`PIECES`) and the id `<hash>:<n>`, its sealed bytes the
 * entry: one window, one order, one tail.
 *
 * `bytes` per row is what it is counted as (core/kept.ts, entryBytes); `totals` holds their sum, so neither a keep nor
 * the About dialog adds them all up, and what today used of the free plan's rows: rows keeps wrote, rows syncs and fetches
 * read, and syncs. Kept in storage: this object is evicted between syncs minutes apart.
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
    const t = this.ctx.storage.sql.exec<Totals>('SELECT bytes, entries, day, kept AS written, read, syncs FROM totals').one();
    const day = dayOf(now);
    return t.day === day ? { ...t } : { ...t, day, written: 0, read: 0, syncs: 0 };
  }

  private setTotals(t: Totals): void {
    this.ctx.storage.sql.exec('UPDATE totals SET bytes = ?, entries = ?, day = ?, kept = ?, read = ?, syncs = ?', t.bytes, t.entries, t.day, t.written, t.read, t.syncs);
  }

  /**
   * Keeps one entry of `room`, then drops the oldest of all rooms until the window is within `budget` again. False when
   * today's share of writes is used up (WRITES_PER_DAY); a text kept already is no keep.
   */
  keep(room: string, entry: KeptEntry, budget = HISTORY_BUDGET_BYTES, now = Date.now()): boolean {
    const json = JSON.stringify(entry);
    return this.put(room, entry.from.publicKey, entry.id, entry.at, entryBytes(json), json, budget, now);
  }

  /** Keeps a piece of a file (`pieceId`), sealed, as `keep` keeps a text: in the same window, dropping its oldest. */
  keepPiece(room: string, id: string, sealed: Uint8Array, budget = HISTORY_BUDGET_BYTES, now = Date.now()): boolean {
    return this.put(room, PIECES, id, now, pieceBytes(sealed.length), sealed, budget, now);
  }

  private put(room: string, writer: string, id: string, at: number, bytes: number, entry: string | Uint8Array, budget: number, now: number): boolean {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const t = this.totals(now);
      if (t.written >= WRITES_PER_DAY) return sql.exec('SELECT 1 FROM entries WHERE room = ? AND writer = ? AND id = ?', room, writer, id).toArray().length > 0;
      const insert = sql.exec('INSERT INTO entries (room, writer, id, at, bytes, entry) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING seq', room, writer, id, at, bytes, entry);
      const added = insert.toArray();
      if (added.length === 0) return true;
      t.bytes += bytes;
      t.entries += 1;
      t.written += insert.rowsWritten + 1; // and the totals
      if (t.bytes > budget) {
        // The oldest, as many as it takes and no more: read lazily, so only those rows are read.
        let last: number | null = null;
        for (const old of sql.exec<{ seq: number; bytes: number }>('SELECT seq, bytes FROM entries ORDER BY seq')) {
          if (t.bytes <= budget) break;
          t.bytes -= old.bytes;
          t.entries -= 1;
          last = old.seq;
        }
        if (last !== null) {
          const dropped = sql.exec('DELETE FROM entries WHERE seq <= ?', last);
          dropped.toArray();
          t.written += dropped.rowsWritten;
        }
      }
      this.setTotals(t);
      return true;
    });
  }

  /** Rows read today by fetches that found nothing (`piece`). */
  private missed = { day: '', rows: 0 };
  /** Rows read today: as the totals keep them, and the misses since this object last woke. */
  private readToday(t: Totals): number { return t.read + (this.missed.day === t.day ? this.missed.rows : 0); }

  /** A piece of a file `room` keeps, sealed; null when it is not kept (any more), or today's share of rows read is used up. */
  piece(room: string, id: string, now = Date.now()): Uint8Array | null {
    const t = this.totals(now);
    if (this.readToday(t) >= SYNC_ROWS_PER_DAY || t.written >= WRITES_PER_DAY) return null;
    const cursor = this.ctx.storage.sql.exec<{ entry: ArrayBuffer }>('SELECT entry FROM entries WHERE room = ? AND writer = ? AND id = ?', room, PIECES, id);
    const row = cursor.toArray()[0];
    // A miss writes nothing: a friend's app asks for a file nobody online has, which the server may never have had. What
    // misses read is counted in memory, against the same share: an eviction forgets it, the Room's rate bounds it.
    if (!row || !(row.entry instanceof ArrayBuffer)) {
      if (this.missed.day !== t.day) this.missed = { day: t.day, rows: 0 };
      this.missed.rows += cursor.rowsRead + 1; // and the totals
      return null;
    }
    t.read += cursor.rowsRead;
    t.written += 1; // the totals
    this.setTotals(t);
    return new Uint8Array(row.entry);
  }

  /**
   * The newest `max` entries of `room` kept after `since` (the Room's clock), oldest first. Null once today's share of
   * rows read or of syncs is used up (SYNC_ROWS_PER_DAY, SYNCS_PER_DAY): not known, which is not none.
   */
  since(room: string, since: number, max: number, now = Date.now()): KeptEntry[] | null {
    const t = this.totals(now);
    if (this.readToday(t) >= SYNC_ROWS_PER_DAY || t.syncs >= SYNCS_PER_DAY) return null;
    // Texts and file announcements: not the pieces of files, which a browser asks for one by one (`piece`).
    const cursor = this.ctx.storage.sql.exec<{ entry: string }>('SELECT entry FROM entries WHERE room = ? AND at > ? AND writer != ? ORDER BY at DESC, seq DESC LIMIT ?', room, since, PIECES, max);
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
