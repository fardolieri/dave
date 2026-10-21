import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import posthog from './posthog';
import { MAX_TEXT_LENGTH, identityOf, type Identity, type Person } from '../core/protocol';
import type { PrivateThread } from '../core/chatlog';
import { appendPrivate, forgetPrivate, loadPrivate, loadPrivateThreads, textKey, touchPrivateThread } from './history';
import type { StoredText } from '../core/chatlog';
import type { LocalIdentity } from './identity';
import type { ChatLine, createRoom, PrivateEvent } from './room';

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
  void loadPrivateThreads().catch((e: unknown) => { console.warn('private conversation list read failed', e); return []; }).then((kept) => {
    const now = threadList;
    commitThreads([...now.map((n) => ({ ...n, at: Math.max(n.at, kept.find((k) => k.friend.publicKey === n.friend.publicKey)?.at ?? 0) })), ...kept.filter((t) => !now.some((n) => n.friend.publicKey === t.friend.publicKey) && !forgotten.has(t.friend.publicKey))]);
  });
  /** Each conversation's lines, once loaded; what came before the load is put after the history. */
  let logList: Record<string, ChatLine[]> = {};
  const [logs, setLogs] = createSignal<Record<string, ChatLine[]>>({});
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
        const lines = stored.map((m): ChatLine => ({ kind: 'text', id: lineId(m), from: m.from, text: m.text, at: m.at }));
        // What came while it was read may be in it already (written as it came, or sent again with another time): once.
        // A line's id is its writer and id (`lineId`), so a line shown already is told by its id.
        const kept = new Set(lines.map((l) => l.id));
        commitLog(friend, [...lines, ...(logList[friend] ?? []).filter((l) => !kept.has(l.id))]);
        for (const k of kept) { remember(setOf(shown, friend), k); remember(setOf(inHistory, friend), k); }
        return true;
      }, (e: unknown) => {
        console.warn('private conversation read failed', e);
        if (loading.get(friend) === p) loading.delete(friend); // read again next time
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
  const setOf = (all: Map<string, Set<string>>, friend: string): Set<string> => { let s = all.get(friend); if (!s) all.set(friend, (s = new Set())); return s; };
  const [unread, setUnread] = createSignal<Record<string, number>>({});
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
    const { text } = e;
    const line: ChatLine = { kind: 'text', id: lineId(text), from: text.from, text: text.text, at: text.at };
    const wid = line.id;
    if (setOf(shown, key).has(wid)) return;
    remember(setOf(shown, key), wid);
    commitLog(key, [...(logList[key] ?? []), line]);
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
      void appendPrivate(key, { from: text.from, text: text.text, at: text.at, id: text.id });
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

  /**
   * Where a friend is now: the rooms of mine that list them, with their entry there. Not a room refused or stepped back
   * for another tab: it lists who was there last, and sends nothing.
   */
  const whereIs = (friend: string): Array<{ room: Room; name: string; person: Person }> =>
    opts.rooms().flatMap((l) => {
      if (l.room.status().kind === 'refused' || l.room.status().kind === 'elsewhere') return [];
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
    if (openNow !== key) setUnread((u) => ({ ...u, [key]: (u[key] ?? 0) + 1 }));
  };
  /**
   * Texts of mine a room could not carry (the friend left it, or I did): through another room we share, else not sent.
   * One that went out already may have arrived: sending it again could bring it twice, so it is only said.
   */
  const resend = (friend: Identity, texts: Array<{ id: string; text: string; at: number; out?: true }>, not: Room, why: string, wait = true): void => {
    const out = texts.filter((t) => t.out).length;
    if (out) notice(friend, `Maybe not sent: ${out === 1 ? 'a text' : `${out} texts`} ${why}, before the Room said it went out.`);
    const rest = texts.filter((t) => !t.out);
    // To another room of mine that can take it: one that lists the friend first, the way `carrier` picks; else, unless it
    // waited for them already (`wait` false), any, where it waits for them a minute, kept over a reload (they may just not
    // be listed yet, as the rooms connect). So a text bounces between rooms the friend is in none of at most once.
    // A connected room before one that is down, which would hold it without waiting, or sending, until it is back.
    // Not a room that lists them without a key (an app from before): it could not seal it.
    const there = whereIs(friend.publicKey);
    const listing = there.filter((w) => w.person.privateTexts && w.room !== not).map((w) => w.room);
    const others = wait ? opts.rooms().map((l) => l.room).filter((r) => r !== not && !there.some((w) => w.room === r) && r.status().kind !== 'refused' && r.status().kind !== 'elsewhere') : [];
    const down = (r: Room) => (r.status().kind === 'connected' ? 0 : 1);
    const rooms = [...listing, ...others].sort((a, b) => down(a) - down(b) || Number(!listing.includes(a)) - Number(!listing.includes(b)) || Number(a !== opts.current()) - Number(b !== opts.current()));
    // Each keeps when it was written: it is still not sent once it waited a day, however often it moved.
    const failed = rest.filter((t) => !rooms.some((r) => r.adoptPrivate(friend, t.text, t.at, t.id)));
    if (failed.length) notice(friend, `Not sent: ${failed.length === 1 ? 'a text' : `${failed.length} texts`} ${why}.`);
  };


  /** A conversation only looked at (a friend's avatar is how I see who they are) leaves the list again as I leave it. */
  const dropIfEmpty = (friend: string | null): void => {
    if (!friend || logList[friend]?.length || threadList.find((t) => t.friend.publicKey === friend)?.at) return;
    if (opts.rooms().some((l) => l.room.pendingPrivate().some((w) => w.to.publicKey === friend))) return;
    commitThreads(threadList.filter((t) => t.friend.publicKey !== friend));
  };
  /** The conversations, most recent first: with one too for a text of mine still waiting to go, after a reload say. */
  const listed = createMemo((): PrivateThread[] => {
    const all = [...threads()];
    for (const w of opts.rooms().flatMap((l) => l.room.pendingPrivate())) {
      if (!all.some((t) => t.friend.publicKey === w.to.publicKey)) all.push({ friend: w.to, at: w.at });
    }
    return all.sort((a, b) => b.at - a.at);
  });

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
          line = { kind: 'text', id: `pending:${w.id}`, from: myself, text: w.text, at: w.at, pending: true };
          cache.set(w.id, line);
        }
        return line;
      })];
    },
    /** Whether a text to this friend would go out now: the room that would carry it is connected. */
    connected: (friend: string): boolean => carrier(friend)?.room.status().kind === 'connected',
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
      setUnread((u) => { const { [friend]: _gone, ...rest } = u; return rest; });
      loading.delete(friend);
      for (const l of opts.rooms()) l.room.cancelPrivate(friend);
      void forgetPrivate(friend);
      posthog.capture('private_forgotten');
    },
    whereIs,
    /** The rooms where I see the friend now, connected ones only: a room down still lists who was there before. */
    onlineIn: (friend: string): string[] => whereIs(friend).filter((w) => w.room.status().kind === 'connected').map((w) => w.name),
    /** Why I cannot write to this friend now, or null when I can. */
    blocked: (friend: string): string | null => {
      if (!opts.identity.privateTexts) return "this browser can't keep a private text key";
      const where = whereIs(friend);
      if (!where.length) return 'not online in any of your rooms';
      return where.some((w) => w.person.privateTexts) ? null : "their app can't take private texts (out of date?)";
    },
    /** Sends a private text through a room we share; false when there is none, and the text stays in the composer. */
    send: (friend: string, text: string): boolean => {
      // Refused, it stays in the composer (false), and the conversation says why.
      const to = whereIs(friend)[0]?.person;
      if (!to) return false; // the composer says why already
      if (text.length > MAX_TEXT_LENGTH) { notice(identityOf(to), `Not sent: message longer than ${MAX_TEXT_LENGTH} characters.`); return false; }
      // The room `carrier` picks first, then any other we share: one too full to take it does not hold it up.
      const first = carrier(friend);
      const tries = [...(first ? [first] : []), ...whereIs(friend).filter((w) => w.person.privateTexts && w.room !== first?.room)];
      if (!tries.some((w) => w.room.sendPrivate(w.person, text))) {
        notice(identityOf(to), 'Not sent: too many private texts are waiting to go already.');
        return false;
      }
      posthog.capture('private_text_sent');
      return true;
    },
  };
}
