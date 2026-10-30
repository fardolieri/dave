import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import posthog from './posthog';
import { MAX_TEXT_LENGTH, identityOf, sameIdentity, type Identity, type Person } from '../core/protocol';
import type { PrivateThread } from '../core/chatlog';
import { MAX_FILE_BYTES, formatSize, pullsByItself, type FileMeta } from '../core/attachment';
import { appendPrivate, forgetPrivate, loadPrivate, loadPrivateThreads, textKey, touchPrivateThread } from './history';
import { keepAll, keptAll } from './unread';
import type { StoredText } from '../core/chatlog';
import type { LocalIdentity } from './identity';
import { PULL_HISTORY_MS, privateWhat, type ChatLine, type createRoom, type PreparedFile, type PrivateEvent } from './room';

type Room = ReturnType<typeof createRoom>;

/**
 * A line's id in a conversation: by writer and id, as several rooms with clocks of their own carry its texts. One from
 * before ids (none are, but the stored shape allows it) by writer and time, as a room's.
 */
const lineId = (m: Pick<StoredText, 'from' | 'at' | 'id'>): string => (m.id !== undefined ? `${m.from.publicKey}:${m.id}` : textKey(m));

/** Texts remembered by writer and id at most, per conversation: four of its histories (MAX_HISTORY). The oldest go. */
const REMEMBERED_MAX = 2000;
function remember(where: Set<string>, key: string): void {
  where.add(key);
  if (where.size > REMEMBERED_MAX) where.delete(where.keys().next().value!);
}

/**
 * My private conversations (ADR 0007): one per friend, apart from every room. A private text still travels through a
 * room the two of us are in, sealed for that room (core/sealed.ts), but it is shown and kept here, by friend, whichever
 * room carried it: two friends in the same two rooms have one conversation, not two.
 *
 * Rooms tell what becomes of private texts through `onPrivate`; this keeps the conversation's lines (its history in
 * IndexedDB `private:<friendKey>`), the list of conversations (`privateThreads`), and what is unread in each.
 */
export function createPrivates(opts: { identity: LocalIdentity; name: () => string; rooms: () => Array<{ room: Room; name: string }>; current: () => Room | null }) {
  const me = opts.identity.publicKey;
  // What is decided on is kept in plain values, mirrored to signals for the screen: a signal's write shows to readers only
  // after the batch, and a decision on a list just changed would go by the old one (client/contacts.ts).
  /** The conversations, most recent first: those kept, and one opened that has no text yet. */
  let threadList: PrivateThread[] = [];
  const [threads, setThreads] = createSignal<PrivateThread[]>([]);
  const commitThreads = (next: PrivateThread[]) => { threadList = next.sort((a, b) => b.at - a.at); setThreads([...threadList]); };
  // Through the history's write chain, after anything written before; merged with any opened meanwhile, by the later time.
  /** The list is read: true, or false when the read failed (then nothing tells a friend with a conversation from one without). */
  let listRead = false;
  const threadsLoaded: Promise<boolean> = loadPrivateThreads().then((kept) => { listRead = true; return kept; }, (e: unknown) => { console.warn('private conversation list read failed', e); return []; }).then((kept) => {
    const now = threadList;
    commitThreads([...now.map((n) => ({ ...n, at: Math.max(n.at, kept.find((k) => k.friend.publicKey === n.friend.publicKey)?.at ?? 0) })), ...kept.filter((t) => !now.some((n) => n.friend.publicKey === t.friend.publicKey) && !forgotten.has(t.friend.publicKey))]);
    return listRead;
  });
  /** Each conversation's lines, once loaded; what came before the load is put after the history. */
  let logList: Record<string, ChatLine[]> = {};
  const [logs, setLogs] = createSignal<Record<string, ChatLine[]>>({});
  /** The conversations whose history has been read (or could not be): until then an empty log says nothing. */
  const [read, setRead] = createSignal<ReadonlySet<string>>(new Set());
  const wasRead = (friend: string) => setRead((all) => new Set([...all, friend]));
  const commitLog = (friend: string, lines: ChatLine[] | undefined) => {
    const { [friend]: _was, ...rest } = logList;
    logList = lines ? { ...rest, [friend]: lines } : rest;
    setLogs(logList);
  };
  const loading = new Map<string, Promise<boolean>>();
  /** Conversations deleted in this page: a read begun before the delete, or a list read before it, does not bring them back. */
  const forgotten = new Set<string>();
  const generation = new Map<string, number>();
  /** Reads a conversation's history once; resolves false when the read failed (tried again next time). */
  const load = (friend: string): Promise<boolean> => {
    let p = loading.get(friend);
    if (!p) {
      const gen = generation.get(friend) ?? 0;
      p = loadPrivate(friend).then((stored) => {
        if ((generation.get(friend) ?? 0) !== gen) return true;
        const lines = stored.map((m): ChatLine => (m.file ? { kind: 'file', id: lineId(m), from: m.from, file: m.file, at: m.at } : { kind: 'text', id: lineId(m), from: m.from, text: m.text, at: m.at }));
        // What came while it was read may be in it already (written as it came, or sent again with another time): once.
        // A line's id is its writer and id (`lineId`), so a line shown already is told by its id.
        const kept = new Set(lines.map((l) => l.id));
        commitLog(friend, [...lines, ...(logList[friend] ?? []).filter((l) => !kept.has(l.id))]);
        placeFiles(friend);
        for (const k of kept) { remember(setOf(shown, friend), k); remember(setOf(inHistory, friend), k); }
        wasRead(friend);
        return true;
      }, (e: unknown) => {
        console.warn('private conversation read failed', e);
        if (loading.get(friend) === p) loading.delete(friend); // read again next time
        wasRead(friend);
        return false;
      });
      loading.set(friend, p);
    }
    return p;
  };
  /** Waiting lines by friend, then by text id (`lines`). */
  const pendingLines = new Map<string, Map<string, ChatLine>>();
  const textListeners = new Set<() => void>();
  /** `writer:id` of the texts each conversation's history holds, once read, by friend. */
  const inHistory = new Map<string, Set<string>>();
  /** `writer:id` of the texts each conversation shows, by friend, so one carried twice shows once. */
  const shown = new Map<string, Set<string>>();
  /** Files of mine said "Maybe not sent", by friend: they may have the announcement, so they may pull the bytes. */
  const mayHave = new Map<string, Set<string>>();
  const setOf = (all: Map<string, Set<string>>, friend: string): Set<string> => { let s = all.get(friend); if (!s) all.set(friend, (s = new Set())); return s; };
  // Kept over a reload (client/unread.ts): a text that came while its conversation was not on screen stays unread, though
  // the history a reload reads back does not tell new from old.
  const [unread, setUnreadSignal] = createSignal<Record<string, number>>(keptAll('unreadPrivate'));
  // A notice (a text of mine that did not go) counts too, but is not kept: its line is gone after a reload, and a count
  // of it would point at nothing.
  const noticed: Record<string, number> = {};
  const setUnread = (next: (u: Record<string, number>) => Record<string, number>) => setUnreadSignal((u) => {
    const v = next(u);
    keepAll('unreadPrivate', Object.fromEntries(Object.entries(v).map(([k, n]) => [k, n - Math.min(n, noticed[k] ?? 0)])));
    return v;
  });
  /** The friend whose conversation is on screen, by key; null while a room is. */
  let openNow: string | null = null;
  const [openWith, setOpenWithSignal] = createSignal<string | null>(null);
  const setOpenWith = (key: string | null) => { openNow = key; setOpenWithSignal(key); };
  let nextNotice = 1;

  const addThread = (friend: Identity, at: number) => {
    forgotten.delete(friend.publicKey);
    commitThreads([{ friend, at: Math.max(at, threadList.find((t) => t.friend.publicKey === friend.publicKey)?.at ?? 0) }, ...threadList.filter((t) => t.friend.publicKey !== friend.publicKey)]);
  };

  /**
   * At once, in the same batch as the room's own change: my text back from the Room shows in the same moment its waiting
   * line goes, and stranded texts are handed on before a reload could lose them. The history is put before what came,
   * once read (`load`).
   */
  const onEvent = (e: PrivateEvent, from: Room): void => {
    const key = e.friend.publicKey;
    if (e.kind === 'stranded') { resend(e.friend, e.texts, from, e.why, !e.waited); return; }
    void load(key);
    if (e.kind === 'notice') { notice(e.friend, e.text, e.at); return; }
    if (e.kind === 'mayHave') { setOf(mayHave, key).add(e.file.hash); return; }
    const { text } = e;
    const line: ChatLine = e.file ? { kind: 'file', id: lineId(text), from: text.from, file: e.file, at: text.at } : { kind: 'text', id: lineId(text), from: text.from, text: text.text, at: text.at };
    const wid = line.id;
    if (setOf(shown, key).has(wid)) return;
    remember(setOf(shown, key), wid);
    commitLog(key, [...(logList[key] ?? []), line]);
    // Known in the room that carried it, which pulls it (client/room.ts knew it already); one placed elsewhere before (the
    // same file sent again) leaves the other, unless that has it, then this one forgets it.
    if (line.kind === 'file') {
      const hash = line.file.hash;
      const was = fileRoom.get(placed(key, hash));
      const ready = was && was !== from && opts.rooms().some((l) => l.room === was) && usable(was) && was.attachmentNow(hash)?.status === 'ready';
      if (!ready) {
        if (was && was !== from) leave(was, key, hash);
        // A friend's: known and pulled in the room that carried it. Mine: that room knows it, it sent it (sendPrivateFile).
        if (text.from.publicKey !== me) place(from, key, line, true);
        else moveTo(from, key, hash);
        setFileRoomsChanged((n) => n + 1);
      }
    }
    const friend = latest(e.friend);
    // Mine stays listed in the moment its waiting line goes (that may be all that listed it, after a reload).
    if (text.from.publicKey === me) addThread(friend, text.at);
    // Counted once the history is read: a text sent again that it holds already (from before a reload) was had, and
    // goes again as soon as the load drops its line, with no cue and nothing unread.
    const gen = generation.get(key) ?? 0;
    void load(key).then(() => {
      // Deleted meanwhile: it stays deleted. Held by the history already: it was had.
      if ((generation.get(key) ?? 0) !== gen || inHistory.get(key)?.has(wid)) return;
      addThread(friend, text.at);
      void appendPrivate(key, { from: text.from, text: text.text, at: text.at, id: text.id, ...(e.file ? { file: e.file } : {}) });
      void touchPrivateThread(friend, text.at);
      // With the history unread (a failed read), a text sent again is not told from a new one: better twice than missed.
      if (text.from.publicKey === me) return;
      for (const l of textListeners) l();
      if (openNow !== key) setUnread((u) => ({ ...u, [key]: (u[key] ?? 0) + 1 }));
    });
  };
  createEffect(() => opts.rooms().map((l) => l.room), (rooms) => {
    const stops = rooms.map((room) => room.onPrivate((e) => onEvent(e, room)));
    return () => { for (const stop of stops) stop(); };
  });

  /** A room that can carry or pull anything: not one refused or stepped back for another tab. */
  const usable = (room: Room): boolean => room.status().kind !== 'refused' && room.status().kind !== 'elsewhere';
  /**
   * Where a friend is now: the rooms of mine that list them, with their entry there. Not a room refused or stepped back
   * for another tab: it lists who was there last, and sends nothing.
   */
  const whereIs = (friend: string): Array<{ room: Room; name: string; person: Person }> =>
    opts.rooms().flatMap((l) => {
      if (!usable(l.room)) return [];
      const person = l.room.people().find((p) => p.publicKey === friend);
      return person ? [{ ...l, person }] : [];
    });
  /**
   * The room a private text to this friend goes through: one we share where their key is, connected first (a room down
   * still lists who was there), the one on screen among them first. `not`: a room that could not carry it.
   */
  const carrier = (friend: string, not?: Room) => {
    const there = whereIs(friend).filter((w) => w.person.privateTexts && w.room !== not);
    const up = there.filter((w) => w.room.status().kind === 'connected');
    const pick = (list: typeof there) => list.find((w) => w.room === opts.current()) ?? list[0];
    return pick(up) ?? pick(there) ?? null;
  };
  /**
   * The friend as presence has them now, else as the list last had them: a text of mine, and what is said about it, may
   * carry them as they were when I wrote it, a day ago perhaps, under another name.
   */
  const latest = (friend: Identity): Identity => {
    const now = whereIs(friend.publicKey)[0];
    return now ? identityOf(now.person) : threadList.find((t) => t.friend.publicKey === friend.publicKey)?.friend ?? friend;
  };
  /**
   * A line in a conversation about a text of mine that did not go. Counted as unread while the conversation is not on
   * screen: the list is where I would see it.
   */
  const notice = (about: Identity, text: string, at = Date.now()): void => {
    const key = about.publicKey;
    const friend = latest(about);
    commitLog(key, [...(logList[key] ?? []), { kind: 'system', id: `notice-${nextNotice++}`, text, at }]);
    addThread(friend, at);
    // Its place in the list is kept; the line itself is not, like a room's (a reload ends what it says).
    void touchPrivateThread(friend, at);
    if (openNow !== key) { noticed[key] = (noticed[key] ?? 0) + 1; setUnread((u) => ({ ...u, [key]: (u[key] ?? 0) + 1 })); }
  };
  /**
   * Texts of mine a room could not carry (the friend left it, or I did): through another room we share, else not sent.
   * One that went out already may have arrived: sending it again could bring it twice, so it is only said.
   */
  const what = privateWhat;
  const resend = (friend: Identity, texts: Array<{ id: string; text: string; at: number; out?: true; file?: FileMeta }>, not: Room, why: string, wait = true): void => {
    const out = texts.filter((t) => t.out).length;
    if (out) notice(friend, `Maybe not sent: ${what(texts.filter((t) => t.out))} ${why}, before the Room said it went out.`);
    // A file that may have arrived stays theirs to pull, as one the room said "Maybe" of.
    for (const t of texts) if (t.out && t.file) setOf(mayHave, friend.publicKey).add(t.file.hash);
    const rest = texts.filter((t) => !t.out);
    // To another room of mine that can take it: one that lists the friend first, the way `carrier` picks; else, unless it
    // waited for them already (`wait` false), any, where it waits for them a minute, kept over a reload (they may just not
    // be listed yet, as the rooms connect). So a text bounces between rooms the friend is in none of at most once.
    // A connected room before one that is down, which would hold it without waiting, or sending, until it is back.
    // Not a room that lists them without a key (an app from before): it could not seal it.
    const there = whereIs(friend.publicKey);
    const listing = there.filter((w) => w.person.privateTexts && w.room !== not).map((w) => w.room);
    const others = wait ? opts.rooms().map((l) => l.room).filter((r) => r !== not && !there.some((w) => w.room === r) && usable(r)) : [];
    const down = (r: Room) => (r.status().kind === 'connected' ? 0 : 1);
    const rooms = [...listing, ...others].sort((a, b) => down(a) - down(b) || Number(!listing.includes(a)) - Number(!listing.includes(b)) || Number(a !== opts.current()) - Number(b !== opts.current()));
    // Each keeps when it was written: it is still not sent once it waited a day, however often it moved.
    const failed = rest.filter((t) => !rooms.some((r) => r.adoptPrivate(friend, t.text, t.at, t.id, t.file) && (t.file && moveTo(r, friend.publicKey, t.file.hash), true)));
    if (failed.length) notice(friend, `Not sent: ${what(failed)} ${why}.`);
  };


  /** A conversation only looked at (a friend's avatar is how I see who they are) leaves the list again as I leave it. */
  const dropIfEmpty = (friend: string | null): void => {
    if (!friend || logList[friend]?.length || threadList.find((t) => t.friend.publicKey === friend)?.at) return;
    if (opts.rooms().some((l) => l.room.pendingPrivate().some((w) => w.to.publicKey === friend))) return;
    commitThreads(threadList.filter((t) => t.friend.publicKey !== friend));
  };
  /**
   * Each private file of a conversation is known in one room of mine at a time (`fileRoom`, by friend and hash), which
   * shows it and pulls it: first the room that carried it, or for one from the history, the room that would carry a text
   * to the friend now (else any, where this browser's store shows what it keeps). It moves only when stuck where it is:
   * its room gone or refused, or the file waiting or failed for a friend that room does not list while another does.
   * Then the room it leaves forgets it. So it is never pulled twice at once, and presence coming and going (a mute, a
   * flaky line) moves nothing. It pulls by itself as a room's recent history does (PULL_HISTORY_MS), or once clicked.
   */
  const fileRoom = new Map<string, Room>();
  const [fileRoomsChanged, setFileRoomsChanged] = createSignal(0);
  const placed = (friend: string, hash: string) => `${friend}:${hash}`;
  /** Files whose pull I asked for with a click, by conversation (`placed`): they go on by themselves where they move to. */
  const clicked = new Set<string>();
  const leave = (room: Room, friend: string, hash: string): void => {
    fileRoom.delete(placed(friend, hash));
    // Another conversation's file of the same bytes may be known there too: then it stays.
    if (![...fileRoom].some(([k, r]) => r === room && k.endsWith(`:${hash}`))) room.dropPrivateFile(hash);
  };
  const place = (room: Room, friend: string, l: Extract<ChatLine, { kind: 'file' }>, byItself: boolean | 'asked'): void => {
    // Known there already, idle or failed (sent again, say): pulled again, as a new one would be.
    const status = room.attachmentNow(l.file.hash)?.status;
    fileRoom.set(placed(friend, l.file.hash), room);
    room.knowPrivateFile(l.file, l.from.publicKey, friend, byItself);
    // Only one that would come by itself anyway (a picture, a short video): a large one waits for its click, as ever.
    // A file of mine too, once asked for: after a reload I may no longer keep it, and get it back from the friend.
    if ((byItself === 'asked' || (byItself && pullsByItself(l.file) && l.from.publicKey !== me)) && (status === 'idle' || status === 'failed')) room.pull(l.file.hash);
  };
  /** A file of this conversation is in `room` now (mine, sent or handed on through it): the one it was in lets it go. */
  const moveTo = (room: Room, friend: string, hash: string): void => {
    const was = fileRoom.get(placed(friend, hash));
    if (was && was !== room) leave(was, friend, hash);
    fileRoom.set(placed(friend, hash), room);
    setFileRoomsChanged((n) => n + 1);
  };
  const placeFiles = (friend: string): void => {
    // One line per file, its newest: a picture sent again today pulls by itself, whatever it was ten days ago.
    const files: Array<Extract<ChatLine, { kind: 'file' }>> = [];
    const seenHere = new Set<string>();
    for (const l of [...(logList[friend] ?? [])].reverse()) if (l.kind === 'file' && !seenHere.has(l.file.hash)) { seenHere.add(l.file.hash); files.push(l); }
    if (!files.length) return;
    const rooms = opts.rooms().map((l) => l.room);
    let moved = false;
    for (const l of files) {
      const hash = l.file.hash;
      const was = fileRoom.get(placed(friend, hash));
      if (was && rooms.includes(was) && usable(was)) {
        const status = was.attachmentNow(hash)?.status;
        if (status !== 'waiting' && status !== 'failed') continue;
        // Waits for them, or a click, there: unless that room is down, which still lists whoever was there before.
        if (was.status().kind === 'connected' && was.people().some((p) => p.publicKey === friend)) continue;
        const to = carrier(friend)?.room;
        if (!to || to === was) continue;
        leave(was, friend, hash);
        // It was asked for, by a click or by itself (waiting, failed): asked again where they are, whatever it is.
        place(to, friend, l, 'asked');
        moved = true;
        continue;
      }
      if (was) { leave(was, friend, hash); moved = true; }
      const to = carrier(friend)?.room ?? whereIs(friend)[0]?.room ?? rooms.find(usable);
      if (to) { place(to, friend, l, clicked.has(placed(friend, hash)) ? 'asked' : Date.now() - l.at < PULL_HISTORY_MS); moved = true; }
    }
    if (moved) setFileRoomsChanged((n) => n + 1);
  };
  // On a change of my rooms, of who is where, or of how a placed file's pull went (it settles to waiting, say).
  // As one string, so the placing runs when one of these changed, not on every frame of a pull's progress.
  // Who has a private text key counts too, and the room on screen: `carrier` goes by both.
  createEffect(() => [fileRoomsChanged(), pruneFileRooms(), opts.current()?.roomId, ...opts.rooms().map((l) => `${l.room.roomId}:${l.room.status().kind}:${l.room.people().map((p) => `${p.publicKey}${p.privateTexts ? '+' : ''}`).join()}`),
    ...[...fileRoom].map(([k, r]) => `${k}:${r.roomId}:${r.privateStatus(k.slice(k.indexOf(':') + 1))}`)].join('|'), () => {
    untrack(() => { for (const friend of Object.keys(logList)) placeFiles(friend); });
  });
  /**
   * Placements in a room of mine that is gone (left, forgotten) go, those of files of mine that never came back (not sent)
   * with them: nothing keeps a room's page alive after it, and the rest are placed anew (`placeFiles`).
   */
  function pruneFileRooms(): number {
    const alive = new Set(opts.rooms().map((l) => l.room));
    for (const [k, r] of [...fileRoom]) if (!alive.has(r)) fileRoom.delete(k);
    return fileRoom.size;
  }
  /** The room a private file of this conversation is shown from and pulled through (`fileRoom`). */
  const roomOf = (hash: string, friend: string): Room | undefined => {
    fileRoomsChanged();
    const r = fileRoom.get(placed(friend, hash));
    return r && opts.rooms().some((l) => l.room === r) ? r : undefined;
  };
  /** Tries the room `carrier` picks, then every other we share that lists the friend with a key, until one takes it. */
  const tryRooms = (friend: string, take: (room: Room, to: Person) => boolean): boolean => {
    const first = carrier(friend);
    const tries = [...(first ? [first] : []), ...whereIs(friend).filter((w) => w.person.privateTexts && w.room !== first?.room)];
    return tries.some((w) => take(w.room, w.person));
  };
  /** The conversations, most recent first: with one too for a text of mine still waiting to go, after a reload say. */
  const listed = createMemo((): PrivateThread[] => {
    const all = [...threads()];
    for (const w of opts.rooms().flatMap((l) => l.room.pendingPrivate())) {
      if (!all.some((t) => t.friend.publicKey === w.to.publicKey)) all.push({ friend: w.to, at: w.at });
    }
    return all.sort((a, b) => b.at - a.at);
  }, { equals: (a, b) => a.length === b.length && a.every((t, i) => t.at === b[i]!.at && sameIdentity(t.friend, b[i]!.friend)) });

  return {
    /** The conversations, most recent first. */
    threads: listed,
    unread: (friend: string): number => unread()[friend] ?? 0,
    openWith,
    /** Puts the conversation with this friend on screen: it is read, and listed from now on. */
    open: (friend: Identity): void => {
      const key = friend.publicKey;
      if (key === me) return;
      if (openNow !== key) dropIfEmpty(openNow);
      // Listed for as long as it is open, even one with no text yet (`dropIfEmpty`).
      if (!threadList.some((t) => t.friend.publicKey === key)) addThread(identityOf(friend), 0);
      void load(key);
      setOpenWith(key);
      delete noticed[key];
      setUnread((u) => ({ ...u, [key]: 0 }));
      posthog.capture('private_opened');
    },
    /** Back to the room on screen. */
    close: (): void => { dropIfEmpty(openNow); setOpenWith(null); },
    /** Fires for a friend's private text, once per text (the message cue). */
    onText: (l: () => void) => { textListeners.add(l); return () => { textListeners.delete(l); }; },
    /**
     * A conversation's lines: its history, then what came since, then mine waiting to go, in any room. A waiting line is
     * made once per text, so the log keeps its row (and the row its dimming) while other things change.
     */
    lines: (friend: string): ChatLine[] => {
      const waiting = opts.rooms().flatMap((l) => l.room.pendingPrivate()).filter((w) => w.to.publicKey === friend).sort((a, b) => a.at - b.at);
      let cache = pendingLines.get(friend);
      if (!cache) pendingLines.set(friend, (cache = new Map()));
      for (const id of [...cache.keys()]) if (!waiting.some((w) => w.id === id)) cache.delete(id);
      return [...(logs()[friend] ?? []), ...waiting.map((w) => {
        let line = cache.get(w.id);
        if (!line) {
          const myself: Identity = { publicKey: me, fingerprint: opts.identity.fingerprint, name: untrack(opts.name) };
          line = w.file ? { kind: 'file', id: `pending:${w.id}`, from: myself, file: w.file, at: w.at, pending: true } : { kind: 'text', id: `pending:${w.id}`, from: myself, text: w.text, at: w.at, pending: true };
          cache.set(w.id, line);
        }
        return line;
      })];
    },
    /** Whether a text to this friend would go out now: the room that would carry it is connected. */
    connected: (friend: string): boolean => carrier(friend)?.room.status().kind === 'connected',
    /** The room a text to this friend would go through now, if any (`carrier`): its state is the conversation's. */
    via: (friend: string): Room | null => carrier(friend)?.room ?? null,
    /** A room I am leaving hands its waiting texts back: through another room we share, else not sent. */
    strand: (room: Room): void => {
      // Taken out of it first: until it is gone it could still send them itself, and the friend would get two.
      const waiting = room.handOverPrivate();
      for (const friend of new Set(waiting.map((w) => w.to.publicKey))) {
        const theirs = waiting.filter((w) => w.to.publicKey === friend);
        resend(theirs[0]!.to, theirs, room, 'waiting in a room you left');
      }
    },
    /** Deletes a conversation from this browser: its texts and its place in the list. The friend keeps theirs. */
    forget: (friend: string): void => {
      if (openNow === friend) setOpenWith(null);
      forgotten.add(friend);
      generation.set(friend, (generation.get(friend) ?? 0) + 1);
      commitThreads(threadList.filter((t) => t.friend.publicKey !== friend));
      commitLog(friend, undefined);
      shown.delete(friend);
      inHistory.delete(friend);
      mayHave.delete(friend);
      // Its files are let go in every room, and a pull under way stops. Their bytes already in this browser's file store
      // stay there until it makes room, as a room's do when its history is cleared: the store is a cache, by hash.
      const hashes = [...fileRoom.keys()].filter((k) => k.startsWith(`${friend}:`)).map((k) => k.slice(friend.length + 1));
      for (const hash of hashes) leave(fileRoom.get(placed(friend, hash))!, friend, hash);
      for (const k of [...clicked]) if (k.startsWith(`${friend}:`)) clicked.delete(k);
      setFileRoomsChanged((n) => n + 1);
      delete noticed[friend];
      setUnread((u) => { const { [friend]: _gone, ...rest } = u; return rest; });
      loading.delete(friend);
      for (const l of opts.rooms()) l.room.cancelPrivate(friend);
      void forgetPrivate(friend);
      posthog.capture('private_forgotten');
    },
    whereIs,
    /** Whether a conversation's history has been read, so an empty log is an empty conversation. */
    isRead: (friend: string): boolean => read().has(friend),
    /** The rooms where I see the friend now, connected ones only: a room down still lists who was there before. */
    onlineIn: (friend: string): string[] => whereIs(friend).filter((w) => w.room.status().kind === 'connected').map((w) => w.name),
    /** Why I cannot write to this friend now, or null when I can. */
    blocked: (friend: string): string | null => {
      if (!opts.identity.privateTexts) return "this browser can't keep a private text key";
      const where = whereIs(friend);
      if (!where.length) return 'not online in any of your rooms';
      return where.some((w) => w.person.privateTexts) ? null : "their app can't take private texts (out of date?)";
    },
    /**
     * Whether a private file is one I have in my conversation with `peer`, sent or received: then they may pull it from
     * me, through any room we share. Asked by a room when a friend asks it for a file (client/links.ts).
     */
    serves: async (hash: string, peer: string): Promise<boolean> => {
      if (peer === me) return false;
      // Waiting to go counts: it may have reached them already, its answer lost with a socket. So does one said "Maybe".
      if (opts.rooms().some((l) => l.room.pendingPrivate().some((w) => w.file?.hash === hash && w.to.publicKey === peer))) return true;
      if (mayHave.get(peer)?.has(hash)) return true;
      // Only a friend I have a conversation with: anyone else asking is not read for (unless the list could not be read).
      if ((await threadsLoaded) && !threadList.some((t) => t.friend.publicKey === peer) && !logList[peer]) return false;
      await load(peer);
      return (logList[peer] ?? []).some((l) => l.kind === 'file' && l.file.hash === hash);
    },
    /** Where a file in a conversation is, in this browser: the room that knows of it tells (client/room.ts, `Attachment`). */
    attachment: (hash: string, friend: string) => roomOf(hash, friend)?.attachment(hash),
    pull: (hash: string, friend: string): void => { clicked.add(placed(friend, hash)); roomOf(hash, friend)?.pull(hash); },
    cancelPull: (hash: string, friend: string): void => { clicked.delete(placed(friend, hash)); roomOf(hash, friend)?.cancelPull(hash); },
    /** Sends a file to a friend through a room we share, as a text goes (`send`); false when none takes it. */
    sendFile: (friend: string, prepared: PreparedFile): boolean => {
      const to = whereIs(friend)[0]?.person;
      if (!to) return false;
      // Too large for anyone: said, and not kept staged, as a room says it (true: handled).
      if (prepared.picked.size > MAX_FILE_BYTES) { notice(identityOf(to), `Not sent: ${prepared.picked.name} is ${formatSize(prepared.picked.size)}.`); return true; }
      // Shown from the room that took it, from my own bytes.
      if (!tryRooms(friend, (room, person) => room.sendPrivateFile(person, prepared) && (moveTo(room, friend, prepared.file.hash), true))) {
        notice(identityOf(to), `Not sent: ${prepared.file.name} could not go out now (too many files waiting, or the room just closed).`);
        return false;
      }
      posthog.capture('private_text_sent', { file: true });
      return true;
    },
    /** Sends a private text through a room we share; false when there is none, and the text stays in the composer. */
    send: (friend: string, text: string): boolean => {
      // Refused, it stays in the composer (false), and the conversation says why.
      const to = whereIs(friend)[0]?.person;
      if (!to) return false; // the composer says why already
      if (text.length > MAX_TEXT_LENGTH) { notice(identityOf(to), `Not sent: message longer than ${MAX_TEXT_LENGTH} characters.`); return false; }
      // The room `carrier` picks first, then any other we share: one too full to take it does not hold it up.
      if (!tryRooms(friend, (room, person) => room.sendPrivate(person, text))) {
        notice(identityOf(to), 'Not sent: too many private texts are waiting to go already.');
        return false;
      }
      posthog.capture('private_text_sent');
      return true;
    },
  };
}
