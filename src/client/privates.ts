import { createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup, runWithOwner, untrack } from 'solid-js';
import posthog from './posthog';
import { identityOf, sameIdentity, type Identity, type Person } from '../core/protocol';
import type { PrivateThread, StoredText } from '../core/chatlog';
import type { PairKey } from '../core/pairs';
import { pairSecret, verifyPrivateTextKey } from '../core/sealed';
import { authKeyOf, pieceKeyOf, roomIdOf, textKeyOf } from '../core/rooms';
import { forgetPrivate, keepUnsent, loadHistory, loadPrivate, loadPrivateThreads, loadUnsent, textKey, touchPrivateThread } from './history';
import { tooOld } from '../core/unsent';
import { local } from './storage';
import { pairIdentity, type LocalIdentity } from './identity';
import { PULL_HISTORY_MS, type ChatLine, type createRoom, type PreparedFile } from './room';

type Room = ReturnType<typeof createRoom>;
/** Rooms of two made at once as a browser starts, and the gap between the rest (`slot`). */
const PAIRS_AT_ONCE = 8;
const PAIR_GAP_MS = 1500;
/** What a room of two needs to be made: the rest (my name and picture, the hold) the caller adds. */
export type PairRoomOptions = { identity: LocalIdentity; roomId: string; authKey: string; textKey: CryptoKey; pieceKey: CryptoKey };

/** My room of two with a friend (ADR 0011): the room, the key I go by in it, and the friend's fingerprint to show them by. */
type Pair = { friend: string; room: Room; mine: string; fingerprint: string; key: string };

/** A line's id in a conversation from before rooms of two (ADR 0007), as its history keeps it: by writer and id. */
const archivedId = (m: Pick<StoredText, 'from' | 'at' | 'id'>): string => (m.id !== undefined ? `${m.from.publicKey}:${m.id}` : textKey(m));

/**
 * My private conversations (ADR 0011): one per friend, each its own room of two, derived by both of us from our private
 * text keys (core/sealed.ts, `pairSecret`), which I go into under a key made for that conversation alone
 * (client/identity.ts, `pairIdentity`). It is a room like any other underneath: texts and files go sealed, the server
 * keeps them for whoever was away (ADR 0009), and the conversation syncs as a room does. The server sees a room of two
 * keys found nowhere else.
 *
 * A room of two is made for every friend whose private text key this browser has seen published in a room of mine
 * (`pairKeys`, kept), so a friend can write to me while we share no room online, and I get it when I come.
 *
 * What this adds to the rooms: the friend shown by their own key and fingerprint, not the one they go by there; the list
 * of conversations (`privateThreads`); and the conversations from before rooms of two, read from this browser's history
 * (`private:<friendKey>`), which nothing writes to any more.
 */
export function createPrivates(opts: {
  identity: LocalIdentity;
  rooms: () => Array<{ room: Room; name: string }>;
  makeRoom: (o: PairRoomOptions) => Room;
}) {
  const me = opts.identity.publicKey;
  const owner = getOwner();
  let disposed = false;
  const disposers = new Map<string, () => void>();
  onCleanup(() => { disposed = true; for (const d of disposers.values()) d(); disposers.clear(); });

  /** Conversations deleted before their room of two was made, and whether what I wrote goes from the server too. */
  const deletedEarly = new Map<string, boolean>();
  /** The rooms of two made so far, by friend. */
  const pairs = new Map<string, Pair>();
  const [pairsChanged, setPairsChanged] = createSignal(0);
  const pairOf = (friend: string): Pair | undefined => { pairsChanged(); return pairs.get(friend); };
  /** Friends whose room of two is being made. */
  const making = new Map<string, string>();
  /**
   * Rooms of two connect one every PAIR_GAP_MS at most, after the first few: a browser that knows many friends opens a
   * socket for each as it starts, and the Worker lets an IP open 60 a minute (wrangler.jsonc), its rooms' among them.
   */
  let nextStart = 0;
  let started = 0;
  /** Pairs waiting for their slot, by friend: the one whose conversation is opened goes at once (`open`). */
  const queued = new Map<string, () => void>();
  const slot = async (friend: string): Promise<void> => {
    if (started++ < PAIRS_AT_ONCE || untrack(openWith) === friend) return;
    const now = Date.now();
    const at = Math.max(now, nextStart);
    nextStart = at + PAIR_GAP_MS;
    if (at > now) await new Promise<void>((resolve) => { const t = setTimeout(go, at - now); function go() { clearTimeout(t); queued.delete(friend); resolve(); } queued.set(friend, go); });
  };

  /** Makes the room of two with a friend, from their private text key; one there already for another key goes first. */
  async function makePair(friend: string, k: PairKey): Promise<void> {
    const privateTexts = opts.identity.privateTexts;
    if (!privateTexts || friend === me || pairs.get(friend)?.key === k.key || making.get(friend) === k.key) return;
    making.set(friend, k.key);
    try {
      const secret = await pairSecret({ mine: privateTexts.keys.privateKey, theirs: k.key, me, them: friend });
      if (!secret) return;
      const [identity, roomId, authKey, textKey, pieceKey] = await Promise.all([pairIdentity(friend), roomIdOf(secret), authKeyOf(secret), textKeyOf(secret), pieceKeyOf(secret)]);
      if (disposed || making.get(friend) !== k.key) return;
      await slot(friend);
      if (disposed || making.get(friend) !== k.key) return;
      await adoptUnsent(friend, roomId);
      if (disposed || making.get(friend) !== k.key) return;
      disposers.get(friend)?.();
      const room = runWithOwner(owner, () => createRoot((dispose) => {
        disposers.set(friend, dispose);
        const room = opts.makeRoom({ identity, roomId, authKey, textKey, pieceKey });
        watch(friend, room, identity.publicKey);
        return room;
      }));
      // Deleted before its room of two was made: cleared now, and what I wrote deleted from the server if asked.
      const deleted = deletedEarly.get(friend);
      if (deleted !== undefined) {
        deletedEarly.delete(friend);
        if (deleted) room.forgetMine();
        void room.clearHistory();
      }
      const pair = { friend, room, mine: identity.publicKey, fingerprint: k.fingerprint, key: k.key };
      pairs.set(friend, pair);
      setPairsChanged((n) => n + 1);
      // Its files from before rooms of two are served to the friend from now on, whether or not it is opened here.
      void loadArchive(friend).then(() => { if (pairs.get(friend) === pair) knowArchived(pair); });
    } catch (e) {
      console.warn('room of two not made', e);
    } finally {
      if (making.get(friend) === k.key) making.delete(friend);
    }
  }

  /**
   * My private texts that waited to go through a room we share, from before rooms of two (`unsentPrivate`): they go
   * through the room of two now, as texts of its own, by their id. One that went out unanswered may have arrived the old
   * way, and may come twice: better than lost. The old list stays as it was (a later change deletes it): what the room of
   * two has already, waiting or in its history, is not taken again, nor what waited a day, which would not be sent.
   */
  async function adoptUnsent(friend: string, roomId: string): Promise<void> {
    const now = Date.now();
    const mine = Object.values(local.read('unsentPrivate')).flat().filter((u) => u.to.publicKey === friend && !tooOld(u, now));
    if (!mine.length) return;
    const waiting = loadUnsent(roomId);
    const had = new Set([...waiting.map((w) => w.id), ...(await loadHistory(roomId)).flatMap((m) => (m.id ? [m.id] : []))]);
    const fresh = mine.filter((u) => !had.has(u.id));
    if (fresh.length) keepUnsent(roomId, [...waiting, ...fresh.map(({ id, text, at }) => ({ id, text, at }))]);
  }

  // Every friend whose key I kept, from the start; every friend whose key a room of mine lists, checked, from then on.
  const known = local.read('pairKeys');
  for (const [friend, k] of Object.entries(known)) void makePair(friend, k);
  const checking = new Set<string>();
  createEffect(() => opts.rooms().flatMap((l) => l.room.people()).filter((p) => p.publicKey !== me && p.privateTexts), (people) => {
    for (const p of people) {
      const published = p.privateTexts!;
      const check = `${p.publicKey}:${published.key}`;
      if (known[p.publicKey]?.key === published.key) { void makePair(p.publicKey, known[p.publicKey]!); continue; }
      if (checking.has(check)) continue;
      checking.add(check);
      void verifyPrivateTextKey({ identity: p.publicKey, key: published.key, sig: published.sig }).then((ok) => {
        if (!ok) { console.warn('private text key rejected'); return; } // only a server that tampers, or a client that cheats
        const k: PairKey = { key: published.key, sig: published.sig, fingerprint: p.fingerprint };
        known[p.publicKey] = k;
        local.set('pairKeys', JSON.stringify({ ...local.read('pairKeys'), [p.publicKey]: k }));
        void makePair(p.publicKey, k);
      }).finally(() => checking.delete(check));
    }
  });

  // What is decided on is kept in plain values, mirrored to signals for the screen (client/contacts.ts).
  /** The conversations, most recent first: those kept, and one opened that has no text yet. */
  let threadList: PrivateThread[] = [];
  const [threads, setThreads] = createSignal<PrivateThread[]>([]);
  const commitThreads = (next: PrivateThread[]) => { threadList = next.sort((a, b) => b.at - a.at); setThreads([...threadList]); };
  /**
   * Conversations deleted in this page, and when: a list read before the delete does not bring them back, nor their
   * room of two's lines from before it; a text after it does.
   */
  const forgotten = new Map<string, number>();
  /** How often each conversation was deleted in this page: a read begun before a delete does not bring it back. */
  const forgets = new Map<string, number>();
  void loadPrivateThreads().then((kept) => {
    const now = threadList;
    commitThreads([...now.map((n) => ({ ...n, at: Math.max(n.at, kept.find((k) => k.friend.publicKey === n.friend.publicKey)?.at ?? 0) })), ...kept.filter((t) => !now.some((n) => n.friend.publicKey === t.friend.publicKey) && !forgotten.has(t.friend.publicKey))]);
  }, (e: unknown) => console.warn('private conversation list read failed', e));
  const addThread = (friend: Identity, at: number) => {
    forgotten.delete(friend.publicKey);
    const was = threadList.find((t) => t.friend.publicKey === friend.publicKey);
    if (was && was.at >= at && sameIdentity(was.friend, friend)) return;
    commitThreads([{ friend, at: Math.max(at, was?.at ?? 0) }, ...threadList.filter((t) => t !== was)]);
    if (at > 0) void touchPrivateThread(friend, Math.max(at, was?.at ?? 0));
  };

  /** The key the friend goes by in our room of two, once they are in it. */
  const friendThere = (pair: Pick<Pair, 'room' | 'mine'>): string | undefined => untrack(pair.room.people).find((p) => p.publicKey !== pair.mine)?.publicKey;

  /** A friend as shown: as a room of mine lists them now, else as the conversation list had them, else from our room of two. */
  const friendNow = (friend: string, fallback?: Identity): Identity => {
    const listed = whereIs(friend)[0]?.person;
    if (listed) return identityOf(listed);
    const thread = threadList.find((t) => t.friend.publicKey === friend)?.friend;
    if (thread) return thread;
    if (fallback) return fallback;
    const pair = pairs.get(friend);
    const there = pair ? pair.room.people().find((p) => p.publicKey !== pair.mine) : undefined;
    return { publicKey: friend, fingerprint: pair?.fingerprint ?? known[friend]?.fingerprint ?? '', name: there?.name ?? 'Friend', ...(there?.picture ? { picture: there.picture } : {}) };
  };

  /**
   * A line of a room of two as the conversation shows it: by the friend's own key and fingerprint, or mine, not by the
   * keys we go by there. The same object for the same line, so the chat does not draw it again.
   */
  const shownLines = new WeakMap<ChatLine, ChatLine>();
  const asShown = (pair: Pair, l: ChatLine): ChatLine => {
    if (l.kind === 'system') return l;
    let shown = shownLines.get(l);
    if (!shown) {
      const mine = l.from.publicKey === pair.mine;
      const from: Identity = { publicKey: mine ? me : pair.friend, fingerprint: mine ? opts.identity.fingerprint : pair.fingerprint, name: l.from.name, ...(l.from.picture ? { picture: l.from.picture } : {}) };
      shown = { ...l, from };
      shownLines.set(l, shown);
    }
    return shown;
  };

  /** Keeps the conversation list in step with a room of two: listed once it has a line, at its newest, and its cue. */
  function watch(friend: string, room: Room, mine: string): void {
    createEffect(() => {
      const pair = pairs.get(friend);
      const last = room.lines().filter((l) => l.kind !== 'system').at(-1);
      const shown = last && pair ? asShown(pair, last) : null;
      return shown && shown.kind !== 'system' ? { at: shown.at, from: shown.from } : null;
    }, (last) => {
      if (!last || last.at <= (forgotten.get(friend) ?? -Infinity)) return;
      // Their name as they wrote last, if they did: they may be online in none of my rooms.
      untrack(() => addThread(last.from.publicKey === friend ? identityOf(last.from) : friendNow(friend), last.at));
    });
    const stop = room.onText(() => { for (const l of textListeners) l(); });
    onCleanup(stop);
    // The friend came into the room of two: the files from before rooms of two are theirs to give, under their key there.
    createEffect(() => room.people().find((p) => p.publicKey !== mine)?.publicKey, (there) => {
      const pair = pairs.get(friend);
      if (there && pair && untrack(archives)[friend]?.some((l) => l.kind === 'file')) knowArchived(pair);
    });
  }

  /** The conversations from before rooms of two, read once each: their lines, or none. */
  const [archives, setArchives] = createSignal<Record<string, ChatLine[]>>({});
  const reading = new Map<string, Promise<void>>();
  const [read, setRead] = createSignal<ReadonlySet<string>>(new Set());
  const loadArchive = (friend: string): Promise<void> => {
    let p = reading.get(friend);
    if (!p) {
      const gen = forgets.get(friend) ?? 0;
      p = loadPrivate(friend).then((stored) => {
        const lines = stored.map((m): ChatLine => (m.file ? { kind: 'file', id: archivedId(m), from: m.from, file: m.file, at: m.at } : { kind: 'text', id: archivedId(m), from: m.from, text: m.text, at: m.at }));
        if ((forgets.get(friend) ?? 0) !== gen) return; // deleted while it was read: it stays deleted
        setArchives((all) => ({ ...all, [friend]: lines }));
      }, (e: unknown) => { console.warn('private conversation read failed', e); reading.delete(friend); })
        .finally(() => setRead((all) => new Set([...all, friend])));
      reading.set(friend, p);
    }
    return p;
  };

  /**
   * The files of a conversation from before rooms of two, in our room of two now: shown from this browser's store if it
   * keeps them, else pulled from the friend there (and served to them), as a room's history pulls its recent ones.
   */
  function knowArchived(pair: Pair): void {
    // The friend goes by another key in the room of two: theirs there is the holder, once they are in it.
    const there = friendThere(pair) ?? pair.friend;
    for (const l of untrack(archives)[pair.friend] ?? []) {
      if (l.kind === 'file') pair.room.knowFile(l.file, l.from.publicKey === me ? pair.mine : there, Date.now() - l.at < PULL_HISTORY_MS);
    }
  }

  const textListeners = new Set<() => void>();
  /** The friend whose conversation is on screen, by key; null while a room is. */
  const [openWith, setOpenWith] = createSignal<string | null>(null);
  // Nothing is unread in the conversation on screen, what comes while it is on screen included.
  createEffect(() => { const k = openWith(); const pair = k ? pairOf(k) : undefined; return pair ? { pair, n: pair.room.unread() } : null; }, (open) => {
    if (open && open.n > 0) open.pair.room.markRead();
  });

  /** A conversation only looked at (a friend's avatar is how I see who they are) leaves the list again as I leave it. */
  const dropIfEmpty = (friend: string | null): void => {
    if (!friend || threadList.find((t) => t.friend.publicKey === friend)?.at) return;
    if (archives()[friend]?.length || pairs.get(friend)?.room.lines().length) return;
    commitThreads(threadList.filter((t) => t.friend.publicKey !== friend));
  };

  /** A room that can carry anything: not one refused, or stepped back for another tab. */
  const usable = (room: Room): boolean => room.status().kind !== 'refused' && room.status().kind !== 'elsewhere';
  /** Where a friend is now: the rooms of mine that list them, with their entry there. Not a room refused or stepped back. */
  const whereIs = (friend: string): Array<{ room: Room; name: string; person: Person }> =>
    opts.rooms().flatMap((l) => {
      if (!usable(l.room)) return [];
      const person = l.room.people().find((p) => p.publicKey === friend);
      return person ? [{ ...l, person }] : [];
    });

  const listed = createMemo((): PrivateThread[] => threads(), { equals: (a, b) => a.length === b.length && a.every((t, i) => t.at === b[i]!.at && sameIdentity(t.friend, b[i]!.friend)) });

  return {
    /** The conversations, most recent first. */
    threads: listed,
    unread: (friend: string): number => (openWith() === friend ? 0 : pairOf(friend)?.room.unread() ?? 0),
    openWith,
    /** Puts the conversation with this friend on screen: it is read, and listed from now on. */
    open: (friend: Identity): void => {
      const key = friend.publicKey;
      if (key === me) return;
      if (openWith() !== key) dropIfEmpty(untrack(openWith));
      if (!threadList.some((t) => t.friend.publicKey === key)) addThread(identityOf(friend), 0);
      void loadArchive(key);
      setOpenWith(key);
      queued.get(key)?.(); // its room of two, waiting to connect: now
      pairs.get(key)?.room.markRead();
      posthog.capture('private_opened');
    },
    /** Back to the room on screen. */
    close: (): void => { dropIfEmpty(untrack(openWith)); setOpenWith(null); },
    /** Fires for a friend's private text that came live, once per text (the message cue). */
    onText: (l: () => void) => { textListeners.add(l); return () => { textListeners.delete(l); }; },
    /** A conversation's lines: those from before rooms of two, then our room of two's, my own still on their way last. */
    lines: (friend: string): ChatLine[] => {
      const pair = pairOf(friend);
      return [...(archives()[friend] ?? []), ...(pair ? pair.room.lines().map((l) => asShown(pair, l)) : [])];
    },
    /** Whether a text to this friend would go out now: our room of two is connected. */
    connected: (friend: string): boolean => pairOf(friend)?.room.status().kind === 'connected',
    /** Our room of two, if made: its state is the conversation's. */
    via: (friend: string): Room | null => pairOf(friend)?.room ?? null,
    /**
     * Deletes a conversation from this browser: its texts, what the server keeps of it from here on, its place in the list;
     * with `mine`, what I wrote in it from the server's history too (ADR 0009).
     */
    forget: (friend: string, mine = false): void => {
      if (untrack(openWith) === friend) setOpenWith(null);
      // By the Room's clock, as the room clears it (`clearHistory`): the newest line's, else this browser's.
      forgotten.set(friend, pairs.get(friend)?.room.newestAt() ?? Date.now());
      forgets.set(friend, (forgets.get(friend) ?? 0) + 1);
      commitThreads(threadList.filter((t) => t.friend.publicKey !== friend));
      setArchives(({ [friend]: _gone, ...rest }) => rest);
      reading.delete(friend);
      // What waits to go to them goes unsent; what the server keeps of it is not brought back (`historyFrom`).
      const pair = pairs.get(friend);
      if (pair) {
        pair.room.dropUnsent();
        if (mine) pair.room.forgetMine();
        void pair.room.clearHistory();
      } else deletedEarly.set(friend, mine);
      void forgetPrivate(friend);
      posthog.capture('private_forgotten', { mine });
    },
    whereIs,
    /** Whether a conversation's history has been read, so an empty log is an empty conversation. */
    isRead: (friend: string): boolean => read().has(friend),
    /** The rooms where I see the friend now, connected ones only: a room down still lists who was there before. */
    onlineIn: (friend: string): string[] => whereIs(friend).filter((w) => w.room.status().kind === 'connected').map((w) => w.name),
    /** Why I cannot write to this friend now, or null when I can: once our room of two is made, whether they are online or not. */
    blocked: (friend: string): string | null => {
      if (!opts.identity.privateTexts) return "this browser can't keep a private text key";
      const pair = pairOf(friend);
      if (pair) {
        const status = pair.room.status().kind;
        return status === 'elsewhere' ? 'open in another tab of this browser' : status === 'refused' ? 'the server refused this conversation' : null;
      }
      const there = whereIs(friend);
      if (there.length && !there.some((w) => w.person.privateTexts)) return "their app can't take private texts (out of date?)";
      if (there.length) return 'getting ready…';
      // A conversation from before rooms of two: their key comes with them, the next time we share a room online.
      return threads().some((t) => t.friend.publicKey === friend && t.at > 0) || archives()[friend]?.length ? 'you can write once you both are online in one of your rooms' : 'not met in any of your rooms yet';
    },
    /** Where a file in a conversation is, in this browser (client/room.ts, `Attachment`). */
    attachment: (hash: string, friend: string) => pairOf(friend)?.room.attachment(hash),
    pull: (hash: string, friend: string): void => pairs.get(friend)?.room.pull(hash),
    cancelPull: (hash: string, friend: string): void => pairs.get(friend)?.room.cancelPull(hash),
    /** Sends a file to a friend through our room of two; false when it is not made. */
    sendFile: (friend: string, prepared: PreparedFile): boolean => {
      const pair = pairs.get(friend);
      if (!pair || !usable(pair.room)) return false;
      pair.room.sendPrepared(prepared);
      posthog.capture('private_text_sent', { file: true });
      return true;
    },
    /** Sends a private text through our room of two; false when it is not made, and the text stays in the composer. */
    send: (friend: string, text: string): boolean => {
      const pair = pairs.get(friend);
      if (!pair || !usable(pair.room)) return false;
      pair.room.sendText(text);
      posthog.capture('private_text_sent');
      return true;
    },
    /** My name and picture changed: in every room of two too. */
    rename: (name: string): void => { for (const p of pairs.values()) p.room.rename(name); },
    setPicture: (picture: string | null): void => { for (const p of pairs.values()) p.room.setPicture(picture); },
    /** Taking the rooms back from another tab: the rooms of two too. */
    takeOver: (): void => { for (const p of pairs.values()) p.room.takeOver(); },
  };
}
