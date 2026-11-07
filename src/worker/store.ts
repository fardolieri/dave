import { DurableObject } from 'cloudflare:workers';
import { HISTORY_BUDGET_BYTES, HISTORY_KEEP_MS, HISTORY_SHARES, nextPrune, SYNCS_PER_DAY, SYNCS_PER_WRITE, SYNC_ROWS_PER_DAY, WRITES_PER_DAY, entryBytes, pieceBytes, type HistoryUsage } from '../core/kept';
import type { KeptEntry } from '../core/protocol';

/** The one Store there is: every room's history in one window (ADR 0009). */
export const STORE_NAME = 'history';

/** Today, UTC, as the free plan's daily rows count it. */
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** `written`: rows written today, what keeps drop from the window's tail included (the column `kept`). */
type Totals = { bytes: number; entries: number; day: string; written: number; read: number; syncs: number };
/** The writer the pieces of files were kept under before they were kept under their sender's key (`piece`). */
const PIECES = '';
/**
 * What SQLite writes to drop one entry, at most: its row, its two indexes and, for a piece, the pieces' index. A `forget`
 * drops no more at once than today's share of writes has room for.
 */
const ROWS_PER_DROP = 4;

/**
 * The server's copy of every room's texts and file announcements (ADR 0009), as the Rooms broadcast them, and the
 * pieces of the files they announce, up to KEPT_FILE_MAX: all sealed, so it reads none of them. One object for all rooms, so the window is one, oldest first across them: past
 * HISTORY_BUDGET_BYTES, the entries kept longest go, whichever room they are of. Rooms hand it what they broadcast
 * (`keep`, `keepPiece`) and ask it for what a friend missed (`since`, `piece`); the About dialog asks how full it is
 * (`usage`). A piece is an entry like a text, marked `piece`, under its sender's key and the id `<tag>:<n>`, its sealed
 * bytes the entry: one window, one order, one tail. The same file sent by two friends is kept twice, each sender's copy
 * theirs to delete (`forget`), which drops every entry a friend wrote in a room, pieces too.
 *
 * `bytes` per row is what it is counted as (core/kept.ts, entryBytes); `totals` holds their sum, so neither a keep nor
 * the About dialog adds them all up, and what today used of the free plan's rows: rows written, rows syncs and fetches
 * read, and syncs. Kept in storage, syncs and what they read a few at a time (`pending`, SYNCS_PER_WRITE): this object is
 * evicted between syncs minutes apart.
 */
export class Store extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, room TEXT NOT NULL, writer TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL, entry TEXT NOT NULL)`);
    // A text the writer's app sent again after a lost socket (ticket 51) is broadcast again under the same id: kept once.
    sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS entries_by_id ON entries (room, writer, id)');
    sql.exec('CREATE INDEX IF NOT EXISTS entries_by_at ON entries (room, at)');
    // Pieces were kept under no writer (`PIECES`) before they were kept under their sender's; a sync brings none.
    if (!sql.exec<{ name: string }>('PRAGMA table_info(entries)').toArray().some((c) => c.name === 'piece')) {
      sql.exec('ALTER TABLE entries ADD COLUMN piece INTEGER NOT NULL DEFAULT 0');
      sql.exec('UPDATE entries SET piece = 1 WHERE writer = ?', PIECES);
    }
    // A friend's app fetches a piece by its id, not knowing who sent it up.
    sql.exec('CREATE INDEX IF NOT EXISTS pieces_by_id ON entries (room, id) WHERE piece = 1');
    sql.exec(`CREATE TABLE IF NOT EXISTS totals (one INTEGER PRIMARY KEY CHECK (one = 1), bytes INTEGER NOT NULL, entries INTEGER NOT NULL, day TEXT NOT NULL, kept INTEGER NOT NULL, read INTEGER NOT NULL, syncs INTEGER NOT NULL)`);
    sql.exec(`INSERT OR IGNORE INTO totals (one, bytes, entries, day, kept, read, syncs) VALUES (1, 0, 0, '', 0, 0, 0)`);
    // The daily prune (`alarm`): set once, and again by every run.
    void ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(nextPrune(Date.now()));
    });
  }

  /**
   * Once a day, near the end of the free plan's day (PRUNE_AT_MS), drops every entry older than HISTORY_KEEP_MS, oldest
   * first, as far as what is left of the day's share of writes goes; what does not fit goes the next day. A sync gives
   * none of it meanwhile (`since`, `piece`).
   */
  async alarm(): Promise<void> {
    try {
      this.prune();
    } finally {
      await this.ctx.storage.setAlarm(nextPrune(Date.now()));
    }
  }

  /** Drops entries older than HISTORY_KEEP_MS, oldest first, within today's share of writes. How many it dropped. */
  prune(now = Date.now()): number {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const t = this.totals(now);
      const fits = Math.floor((WRITES_PER_DAY - t.written - 1) / ROWS_PER_DROP);
      if (fits <= 0) return 0;
      // The oldest, read lazily up to the first inside the window: only those rows are read.
      const cutoff = now - HISTORY_KEEP_MS;
      let last: number | null = null;
      let count = 0;
      const old = sql.exec<{ seq: number; at: number }>('SELECT seq, at FROM entries ORDER BY seq');
      for (const row of old) {
        if (row.at > cutoff || count >= fits) break;
        last = row.seq;
        count++;
      }
      t.read += old.rowsRead;
      if (last === null) { this.setTotals(t); return 0; }
      const dropped = sql.exec<{ bytes: number }>('DELETE FROM entries WHERE seq <= ? RETURNING bytes', last);
      const rows = dropped.toArray();
      for (const r of rows) t.bytes -= r.bytes;
      t.entries -= rows.length;
      t.written += dropped.rowsWritten + 1; // and the totals
      this.setTotals(t);
      return rows.length;
    });
  }

  /** Syncs, and rows read by them and by fetches that found nothing, today, not yet written with the totals. */
  private pending = { day: '', syncs: 0, read: 0 };

  /** The totals, today's counts reset on a new day, and what is pending of today counted in. */
  private totals(now: number): Totals {
    const t = this.ctx.storage.sql.exec<Totals>('SELECT bytes, entries, day, kept AS written, read, syncs FROM totals').one();
    const day = dayOf(now);
    const today = t.day === day ? { ...t } : { ...t, day, written: 0, read: 0, syncs: 0 };
    if (this.pending.day === day) {
      today.syncs += this.pending.syncs;
      today.read += this.pending.read;
    }
    return today;
  }

  /** Writes the totals, what was pending with them. */
  private setTotals(t: Totals): void {
    this.ctx.storage.sql.exec('UPDATE totals SET bytes = ?, entries = ?, day = ?, kept = ?, read = ?, syncs = ?', t.bytes, t.entries, t.day, t.written, t.read, t.syncs);
    this.pending = { day: t.day, syncs: 0, read: 0 };
  }

  /**
   * Counts syncs and rows read today, written with the totals every SYNCS_PER_WRITE syncs: past the share of writes too
   * (SYNCS_PER_DAY / SYNCS_PER_WRITE rows at most), or an eviction would forget them and the syncs share with them.
   */
  private count(now: number, syncs: number, read: number): void {
    const day = dayOf(now);
    if (this.pending.day !== day) this.pending = { day, syncs: 0, read: 0 };
    this.pending.syncs += syncs;
    this.pending.read += read;
    if (this.pending.syncs < SYNCS_PER_WRITE) return;
    const t = this.totals(now);
    t.written += 1;
    this.setTotals(t);
  }

  /**
   * Keeps one entry of `room`, then drops the oldest of all rooms until the window is within `budget` again. False when
   * today's share of writes is used up (WRITES_PER_DAY); a text kept already is no keep.
   */
  keep(room: string, entry: KeptEntry, budget = HISTORY_BUDGET_BYTES, now = Date.now()): boolean {
    const json = JSON.stringify(entry);
    return this.put(room, entry.from.publicKey, entry.id, entry.at, entryBytes(json), json, budget, now);
  }

  /**
   * Keeps a piece of a file (`pieceId`), sealed, as `keep` keeps a text: under its sender, at `at` by the Room's clock, in
   * the same window, dropping its oldest.
   */
  keepPiece(room: string, writer: string, id: string, sealed: Uint8Array, at: number, budget = HISTORY_BUDGET_BYTES, now = Date.now()): boolean {
    return this.put(room, writer, id, at, pieceBytes(sealed.length), sealed, budget, now, 1);
  }

  private put(room: string, writer: string, id: string, at: number, bytes: number, entry: string | Uint8Array, budget: number, now: number, piece = 0): boolean {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const t = this.totals(now);
      if (t.written >= WRITES_PER_DAY) return sql.exec('SELECT 1 FROM entries WHERE room = ? AND writer = ? AND id = ?', room, writer, id).toArray().length > 0;
      const insert = sql.exec('INSERT INTO entries (room, writer, id, at, bytes, entry, piece) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING seq', room, writer, id, at, bytes, entry, piece);
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

  /** A piece of a file `room` keeps, sealed; null when it is not kept (any more), or today's share of rows read is used up. */
  piece(room: string, id: string, now = Date.now()): Uint8Array | null {
    const t = this.totals(now);
    if (t.read >= SYNC_ROWS_PER_DAY || t.written >= WRITES_PER_DAY) return null;
    const cursor = this.ctx.storage.sql.exec<{ entry: ArrayBuffer }>('SELECT entry FROM entries WHERE room = ? AND id = ? AND piece = 1 AND at > ? LIMIT 1', room, id, now - HISTORY_KEEP_MS);
    const row = cursor.toArray()[0];
    // A miss writes nothing: a friend's app asks for a file nobody online has, which the server may never have had. What
    // misses read is counted in memory, against the same share, and written with the next totals: an eviction before
    // that forgets it, the Room's rate bounds it.
    if (!row || !(row.entry instanceof ArrayBuffer)) {
      this.count(now, 0, cursor.rowsRead + 1); // and the totals
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
    if (t.read >= SYNC_ROWS_PER_DAY || t.syncs >= SYNCS_PER_DAY) return null;
    // Texts and file announcements: not the pieces of files, which a browser asks for one by one (`piece`).
    // Nothing older than the window, though today's prune may not have dropped it yet.
    const from = Math.max(since, now - HISTORY_KEEP_MS);
    const cursor = this.ctx.storage.sql.exec<{ entry: string }>('SELECT entry FROM entries WHERE room = ? AND at > ? AND piece = 0 ORDER BY at DESC, seq DESC LIMIT ?', room, from, max);
    const rows = cursor.toArray();
    this.count(now, 1, cursor.rowsRead);
    return rows.reverse().map((r) => JSON.parse(r.entry) as KeptEntry);
  }

  /**
   * Drops every entry `writer` wrote in `room` up to `before` (the Room's clock): texts, file announcements and pieces of
   * files. True when all are gone; false when today's share of writes had room for only some, or none: asked again, it
   * goes on from there.
   */
  forget(room: string, writer: string, before: number, now = Date.now()): boolean {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const t = this.totals(now);
      const fits = Math.floor((WRITES_PER_DAY - t.written - 1) / ROWS_PER_DROP);
      if (fits <= 0) return false;
      const dropped = sql.exec<{ bytes: number }>('DELETE FROM entries WHERE seq IN (SELECT seq FROM entries WHERE room = ? AND writer = ? AND at <= ? LIMIT ?) RETURNING bytes', room, writer, before, fits);
      const rows = dropped.toArray();
      t.read += dropped.rowsRead;
      for (const r of rows) t.bytes -= r.bytes;
      t.entries -= rows.length;
      t.written += dropped.rowsWritten + 1; // and the totals
      this.setTotals(t);
      return rows.length < fits;
    });
  }

  /** How full the window is, since when it reaches back, and what today used of the daily shares. */
  usage(now = Date.now()): HistoryUsage {
    const { bytes, entries, day, syncs, written, read } = this.totals(now);
    const oldest = this.ctx.storage.sql.exec<{ at: number }>('SELECT at FROM entries ORDER BY seq LIMIT 1').toArray()[0]?.at ?? null;
    return { bytes, budget: HISTORY_BUDGET_BYTES, entries, oldest, asOf: now, today: { day, syncs, written, read }, shares: HISTORY_SHARES };
  }
}
