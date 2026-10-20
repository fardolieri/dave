import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import posthog, { onConsentChange, telemetryOn } from './posthog';
import { buildAuthMessage, randomHex } from '../core/identity';
import { openFile, openText, sealFile, sealText } from '../core/sealed';
import { MAX_FILE_BYTES, MAX_FILE_NAME, PIECED_FROM, PIECE_BYTES, PULLS_AT_ONCE, formatSize, inlineKind, pullsByItself, type FileMeta } from '../core/attachment';
import { createLinks, PullFailed, type PullError } from './links';
import { createFileWatchdog } from './invariants';
import { exposeHooks } from './hooks';
import { big, hashOf, holdSent, holdSentList, keepFile, keptFile, makePreview, noRoom, piecesOf } from './files';
import {
  CLOSE_AUTH_FAILED, CLOSE_SUPERSEDED, MAX_TEXT_LENGTH, PING_FRAME, PING_INTERVAL_MS,
  type ClientMessage, type Identity, type Person, type RequestId, type ServerMessage, type TextId,
} from '../core/protocol';
import {
  afterJoin, afterWelcome, carried, declare, declared, forgetEnded, forgetWatch, inCallOnly, joinDeclares, leaveCall,
  type Carried, type Declaration,
} from '../core/declarations';
import { beat, heard, heartbeat } from '../core/heartbeat';
import { tooOld } from '../core/unsent';
import type { LocalIdentity } from './identity';
import { appendHistory, clearHistory, keepUnsent, loadHistory, loadUnsent, textKey, type StoredText } from './history';

export type ServerStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'unavailable'; since: number }
  | { kind: 'refused'; reason: string }
  /** Another tab or window of this browser opened the room; this one stepped back (close code 4004). */
  | { kind: 'elsewhere' };

export type ChatLine =
  /** `pending`: my own text the Room has not brought back yet; it waits at the end of the log, `at` my own clock's. */
  | { kind: 'text'; id: string; from: Identity; text: string; at: number; pending?: true }
  /** An attachment (ADR 0006); its bytes are in `attachment(file.hash)`. `pending`: mine, not back from the Room yet. */
  | { kind: 'file'; id: string; from: Identity; file: FileMeta; at: number; pending?: true }
  | { kind: 'system'; id: string; text: string; at: number };

/** A friend's text as opened: the Room relayed it sealed (ADR 0005). An attachment's `text` is its name. */
export type Text = { from: Identity; text: string; at: number; id: TextId };

/**
 * Where an attachment's bytes are, in this browser. `idle`: not pulled, waits for a click. `waiting`: whoever has it is
 * not online. `pulling`: `received` bytes so far. `ready`: `url` is a blob URL of a type safe to show. `failed`: `reason`.
 */
export type Attachment =
  /** `partial`: bytes of a large file already on disk, from a pull that stopped; the next goes on from there (ticket 03). */
  | { status: 'idle'; partial?: number }
  | { status: 'waiting' }
  | { status: 'pulling'; received: number }
  | { status: 'ready'; url: string }
  /** `retryAt`: tried again by itself then, while a friend who has it stays online (attachments ticket 05). */
  | { status: 'failed'; reason: PullError; retryAt?: number };
/**
 * A pull that could not reach its friend, or lost her, is tried again by itself after these, while she stays online: a
 * tab frozen in a pocket, a link that dropped. Then it waits for a click. A friend busy with others is asked again every
 * BUSY_RETRY_MS for as long as she says so: she is there, only full (ticket 05).
 */
const RETRY_MS = [5_000, 15_000, 45_000];
/** Large files past their time are swept once a page. */
let sweptBig = false;
const BUSY_RETRY_MS = 15_000;
/** Attachments in the history from this recent are pulled by themselves, like new ones, when this browser lacks them. */
const PULL_HISTORY_MS = 7 * 24 * 3600 * 1000;

const UNAVAILABLE_AFTER_MS = 30_000;
/** Texts shown remembered by writer and id, to show a text sent again only once (ticket 51); the oldest are forgotten. */
const SEEN_TEXTS_MAX = 1000;
const BACKOFF_MAX_MS = 30_000;
/**
 * A socket the server has not let in after this long is given up and tried again. The upgrade or the handshake can hang
 * on the way to the Room, and no close comes for it: the app sat on "Connecting…" for good (nightly, ticket 48). The
 * server gives an answer to its challenge as long.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** What a handshake given up is reported as (no close event says it). */
const HANDSHAKE_GIVEN_UP = 4008;
/** What a socket given up for its unanswered pings (core/heartbeat.ts) is closed with, and reported as. */
const PINGS_UNANSWERED = 4009;
/** Why this client gave a socket up itself, for `server_socket_closed`. */
const GIVEN_UP: Record<number, string> = { [HANDSHAKE_GIVEN_UP]: 'handshake_timeout', [PINGS_UNANSWERED]: 'pong_overdue' };
/** The sockets this tab holds, one per room it shows. */
const sockets = new Set<WebSocket>();
/** One socket's life, for `server_socket_closed`: when the Room let it in, when its last frame came. */
type Life = { welcomedAt: number | null; frameAt: number | null };

/** A file made ready to send (`prepareFile`): its announcement but for the sealing, and what this browser keeps of it. */
export type PreparedFile = { picked: File; file: FileMeta; list: Uint8Array | null };

/**
 * Hashes a file and makes its preview: the slow part of sending it, done before it is handed to a room, so that it takes
 * its place among texts and files there at once. A large file is hashed a piece at a time, which takes a while, and is
 * served from the file picked: never copied, so it can be pulled while this tab stays open, and from friends who pulled
 * it after that (ticket 03).
 */
export async function prepareFile(picked: File): Promise<PreparedFile> {
  const pieced = picked.size > PIECED_FROM;
  const [{ hash, list }, look] = await Promise.all([pieced ? piecesOf(picked) : hashOf(picked).then((h) => ({ hash: h, list: null })), makePreview(picked)]);
  const file: FileMeta = { name: picked.name.slice(0, MAX_FILE_NAME).trim() || 'file', type: picked.type.slice(0, 100), size: picked.size, hash, ...look, ...(pieced ? { piece: PIECE_BYTES } : {}) };
  return { picked, file, list };
}

/**
 * The client's view of one Room: one WebSocket with the challenge handshake,
 * reconnection with exponential backoff (spec §8.1), presence snapshots, and
 * ephemeral text. The call (WebRTC) is layered on top by createCall.
 */
export function createRoom(opts: { identity: LocalIdentity; roomId: string; authKey: string; textKey: CryptoKey; name: string; picture: string | null; hold?: () => boolean }) {
  /**
   * The latest of everything this friend declares (core/declarations.ts): the auth of every socket carries her name,
   * picture and opt-in, the welcome is followed by what changed meanwhile, her join by what she declared in the call.
   */
  const latest = declared(opts.name, opts.picture, telemetryOn());
  const [status, setStatus] = createSignal<ServerStatus>({ kind: 'connecting' });
  const [you, setYou] = createSignal<Person | null>(null);
  const [people, setPeople] = createSignal<Person[]>([]);
  const [lines, setLines] = createSignal<ChatLine[]>([]);
  /** Texts from others that arrived live while this room was not the one on screen. */
  const [unread, setUnread] = createSignal(0);
  const listeners = new Set<(m: ServerMessage) => void>();
  const textListeners = new Set<(m: Text) => void>();
  let nextId = 1;
  /**
   * Own texts not back from the Room yet, oldest first. The network can drop a socket under a text (1006, the Room none the
   * wiser), and the text was gone for everyone: each is sent again on the next socket, until it comes back or is refused.
   */
  const unconfirmed = loadUnsent(opts.roomId);
  /** `unconfirmed` as shown: after the lines, as waiting. */
  const [pending, setPending] = createSignal([...unconfirmed]);
  /**
   * My attachments not back from the Room yet, with their sealed announcement once sealed: sent again on the next socket,
   * like texts. Not kept over a reload.
   */
  const [pendingFiles, setPendingFiles] = createSignal<Array<{ id: string; file: FileMeta; at: number; sealed?: string }>>([]);
  const [attachments, setAttachments] = createSignal<Record<string, Attachment>>({});
  /** The same, read at once: a signal's write shows to readers only after the batch (client/contacts.ts). */
  const attachmentNow = new Map<string, Attachment>();
  const setAttachment = (hash: string, a: Attachment) => { attachmentNow.set(hash, a); setAttachments((all) => ({ ...all, [hash]: a })); };
  /** Files announced in this room, by hash: the only ones a friend may pull from me here. */
  const announced = new Set<string>();
  /** Blob URLs handed out, revoked when the room goes. */
  const urls: string[] = [];
  /** Drops the texts that waited too long to be sent, with a line saying so. */
  const dropTooOld = () => {
    const now = Date.now();
    const old = unconfirmed.filter((u) => tooOld(u, now));
    if (!old.length) return;
    unconfirmed.splice(0, unconfirmed.length, ...unconfirmed.filter((u) => !old.includes(u)));
    unconfirmedChanged();
    push({ kind: 'system', text: `Not sent: ${old.length === 1 ? 'a text' : `${old.length} texts`} written more than a day ago.`, at: now });
  };
  /** `unconfirmed` changed: it shows, and is kept for a reload, whose welcome sends it again (client/history.ts). */
  const unconfirmedChanged = (keep = true) => {
    setPending([...unconfirmed]);
    if (keep) keepUnsent(opts.roomId, unconfirmed);
  };
  /**
   * `publicKey:id` of the texts shown, oldest first: one sent again may have reached us the first time, before a reload of
   * ours too, so the history's ids count.
   */
  const seenTexts = new Set<string>();
  /** Whether a writer's text of this id was shown already; remembers it if not. */
  const seen = (publicKey: string, id: string): boolean => {
    const key = `${publicKey}:${id}`;
    if (seenTexts.has(key)) return true;
    seenTexts.add(key);
    if (seenTexts.size > SEEN_TEXTS_MAX) seenTexts.delete(seenTexts.values().next().value!);
    return false;
  };
  // Recent history from this browser, loaded once; live lines append after it.
  const fromStored = ({ from, text, at, file }: StoredText): ChatLine =>
    file ? { kind: 'file', id: textKey({ from, at }), from, file, at } : { kind: 'text', id: textKey({ from, at }), from, text, at };
  /** The history is loaded: until then, a friend's pull of a file announced before this page opened waits for it. */
  const historyLoaded = loadHistory(opts.roomId).then((stored) => {
    for (const m of stored) if (m.id !== undefined) seen(m.from.publicKey, m.id);
    setLines((l) => [...stored.map(fromStored), ...l]);
    const now = Date.now();
    // An older picture this browser no longer keeps is pulled on a click: every start would pull them all again.
    for (const m of stored) if (m.file) void arrived(m.file, m.from.publicKey, now - m.at < PULL_HISTORY_MS);
  });
  const push = (line: { kind: 'text'; id: string; from: Identity; text: string; at: number } | { kind: 'file'; id: string; from: Identity; file: FileMeta; at: number } | { kind: 'system'; text: string; at: number }) =>
    setLines((l) => [...l, 'id' in line ? (line as ChatLine) : ({ ...line, id: `sys-${nextId++}` } as ChatLine)]);
  let ws: WebSocket | null = null;
  /** The socket the server has let in (its welcome came), and how many sockets it has let in so far. */
  let welcomed: WebSocket | null = null;
  let welcomes = 0;
  let attempt = 0;
  let downSince: number | null = null;
  let everConnected = false;
  /** What the last auth carried. */
  let authCarried: Carried | null = null;
  /** `welcomes` when the join went out: the Room has this friend in its call on that socket, until her leave. */
  let callOn: number | null = null;
  const inCall = (): boolean => welcomed !== null && callOn === welcomes;
  let stopped = false;
  /**
   * The room is gone (left, the app closed). `stopped` is also true for a tab another took the room from, whose pulls go
   * on and must still say how they ended: what shows when it takes the room back.
   */
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Texts go out sealed (ADR 0005), in the order written: sealing takes a moment, and the Room answers texts in the order
   * they came. One sealed while there is no socket let in is not sent, and waits for the next welcome like any other.
   */
  let sealing: Promise<void> = Promise.resolve();
  const sendText = (u: { id: string; text: string }): void => {
    sealing = sealing.then(async () => {
      const sealed = await sealText({ key: opts.textKey, privateKey: opts.identity.keys.privateKey, roomId: opts.roomId, id: u.id, from: opts.identity.publicKey, text: u.text });
      send({ t: 'sealed', sealed, id: u.id });
    }).catch((e: unknown) => console.error('sealing a text failed', e));
  };
  /** A prepared file into the chat and on its way (ADR 0006): see `sendPrepared` below. */
  const sendPrepared = ({ picked, file, list }: PreparedFile): void => {
    if (picked.size > MAX_FILE_BYTES) { push({ kind: 'system', text: `Not sent: ${picked.name} is ${formatSize(picked.size)}.`, at: Date.now() }); return; }
    if (stopped) return;
    const id = randomHex(12);
    const at = Date.now();
    const { hash } = file;
    holdSent(hash, picked);
    if (list) holdSentList(hash, list);
    else void keepFile(hash, picked);
    announced.add(hash);
    hold(file, opts.identity.publicKey);
    if (attachmentNow.get(hash)?.status !== 'ready') show(file, picked);
    setPendingFiles((p) => [...p, { id, file, at }]);
    sealing = sealing.then(async () => {
      const sealed = await sealFile({ key: opts.textKey, privateKey: opts.identity.keys.privateKey, roomId: opts.roomId, id, from: opts.identity.publicKey, file });
      // Kept for the next socket, which sends it again; friends show an id they have shown already no more.
      setPendingFiles((p) => p.map((f) => (f.id === id ? { ...f, sealed } : f)));
      send({ t: 'file', sealed, id });
    }).catch((e: unknown) => console.error('sealing a file failed', e));
    posthog.capture('file_sent', { bytes: file.size, inline: inlineKind(file.type) ?? 'none', preview: !!file.preview });
  };
  /** Friends' texts are opened in the order the Room sent them, so they show in that order too. */
  let opening: Promise<void> = Promise.resolve();

  /**
   * Write a frame if the socket is open and let in; returns whether it went out, so a caller can re-assert what was dropped.
   * Before the welcome the server takes any frame but the auth for a stranger's, and its error for a wrong invite link.
   */
  const send = (m: ClientMessage): boolean => {
    if (ws?.readyState !== WebSocket.OPEN || welcomed !== ws) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  /**
   * Declares something anew (core/declarations.ts): the latest value is kept, and goes out on every socket from now on.
   * Returns whether it went out now; one that did not goes out once the Room lets this friend in again (or in its call
   * again, for what only a friend in the call declares).
   */
  function declareLatest(d: Declaration): boolean {
    declare(latest, d);
    return (!inCallOnly(d) || inCall()) && send(d);
  }

  /**
   * A sealed text from the Room: shown and kept if it opens with the room's key and was signed by the friend the Room says
   * sent it. One that does not is dropped with a warning: only a server that tampers, or a client that cheats, sends one.
   */
  async function received(m: Extract<ServerMessage, { t: 'sealed' }>): Promise<void> {
    const opened = await openText({ key: opts.textKey, roomId: opts.roomId, id: m.id, from: m.from.publicKey, sealed: m.sealed });
    // A room forgotten or cleared meanwhile, or a tab that stepped back: nothing to show, and nothing to write back.
    if (stopped) return;
    const own = m.from.publicKey === opts.identity.publicKey;
    // My own text came back: the Room took it, whether or not it opens here, so sending it again cannot help.
    const i = own ? unconfirmed.findIndex((u) => u.id === m.id) : -1;
    if (i >= 0) { unconfirmed.splice(i, 1); unconfirmedChanged(); }
    if (!opened.ok) {
      // A server that reads or forges, or a friend's app that seals wrong: either is urgent, so the session briefing and the
      // night shift look for this event first (scripts/claude/session-start.sh). The writer by fingerprint only.
      console.warn(`text rejected: ${opened.reason}`);
      posthog.capture('text_rejected', { reason: opened.reason, writer: m.from.fingerprint, own, sealed_length: m.sealed.length });
      if (i >= 0) push({ kind: 'system', text: 'Not sent: your text came back unreadable.', at: Date.now() });
      return;
    }
    if (seen(m.from.publicKey, m.id)) return;
    const text: Text = { from: m.from, text: opened.text, at: m.at, id: m.id };
    push({ kind: 'text', id: textKey(text), from: text.from, text: text.text, at: text.at });
    void appendHistory(opts.roomId, text);
    if (!own) {
      setUnread((n) => n + 1);
      for (const l of textListeners) l(text);
    }
  }

  /** An attachment's announcement from the Room: shown like a text, then its bytes are looked for (`arrived`). */
  async function receivedFile(m: Extract<ServerMessage, { t: 'file' }>): Promise<void> {
    const opened = await openFile({ key: opts.textKey, roomId: opts.roomId, id: m.id, from: m.from.publicKey, sealed: m.sealed });
    if (stopped) return;
    const own = m.from.publicKey === opts.identity.publicKey;
    if (own) setPendingFiles((p) => p.filter((f) => f.id !== m.id));
    if (!opened.ok) {
      console.warn(`file rejected: ${opened.reason}`);
      posthog.capture('text_rejected', { reason: opened.reason, writer: m.from.fingerprint, own, sealed_length: m.sealed.length, kind: 'file' });
      return;
    }
    if (seen(m.from.publicKey, m.id)) return;
    const { file } = opened;
    push({ kind: 'file', id: textKey({ from: m.from, at: m.at }), from: m.from, file, at: m.at });
    void appendHistory(opts.roomId, { from: m.from, text: file.name, at: m.at, id: m.id, file });
    arrived(file, m.from.publicKey);
    if (!own) {
      setUnread((n) => n + 1);
      for (const l of textListeners) l({ from: m.from, text: file.name, at: m.at, id: m.id });
    }
  }

  const links = createLinks({ identity: opts.identity, send: (m) => send(m), serves: async (hash) => { await historyLoaded; return announced.has(hash); } });
  /** Who announced each file, by hash, oldest first: any of them has it (ticket 02: anyone who pulled it, too). */
  const holders = new Map<string, { file: FileMeta; from: string[] }>();
  const online = (key: string): boolean => people().some((p) => p.publicKey === key);
  /** The friends a file can be pulled from now: those who announced it and are online, newest announcement first. */
  const reachable = (hash: string): string[] => [...(holders.get(hash)?.from ?? [])].reverse().filter((k) => k !== opts.identity.publicKey && online(k));
  /**
   * Friends asked for a file in this round who did not give it (not there, unreachable, busy). A round ends when no one
   * is left to ask; then the retry schedule, or the wait for a friend to come online, takes over (attachments ticket 02).
   */
  const asked = new Map<string, Set<string>>();
  /**
   * The round's most hopeful reason so far, which it ends on: a friend busy with others has it, one who could not be
   * reached may, one who said "not there" has not. The last friend asked is often one who never pulled it.
   */
  const roundReason = new Map<string, PullError>();
  const HOPE: PullError[] = ['busy', 'unreachable', 'lost', 'damaged', 'not there'];
  /**
   * Friends who said a file is "not there", and when: not asked for it again for NOT_THERE_MS, across rounds. Else a
   * file nobody online has asked every friend again on each presence update, a mute or a rename included (review of
   * PR #71). Past that they may have pulled it meanwhile.
   */
  const notThere = new Map<string, Map<string, number>>();
  const NOT_THERE_MS = 10 * 60_000;
  const saidNotThere = (hash: string, key: string): boolean => Date.now() - (notThere.get(hash)?.get(key) ?? -Infinity) < NOT_THERE_MS;
  /** A new round: everyone may be asked again but those who said "not there" lately. */
  const newRound = (hash: string): void => { asked.delete(hash); roundReason.delete(hash); };
  /**
   * Whom to ask for a file, in order: friends who announced it, newest first, then every other friend online, who may
   * have pulled it (ticket 02). A friend without it answers "not there", and the next is asked. Not asked again within a
   * round: those who did not give it.
   */
  const candidates = (hash: string): string[] => {
    const tried = asked.get(hash);
    const announcers = reachable(hash);
    const others = people().map((p) => p.publicKey).filter((k) => k !== opts.identity.publicKey && !announcers.includes(k));
    return [...announcers, ...others].filter((k, i, all) => all.indexOf(k) === i && !tried?.has(k) && !saidNotThere(hash, k));
  };
  const hold = (file: FileMeta, from: string): void => {
    const known = holders.get(file.hash);
    if (!known) holders.set(file.hash, { file, from: [from] });
    else if (!known.from.includes(from)) known.from.push(from);
  };
  const queue: string[] = [];
  let pulling = 0;
  /** The pulls running, by hash, to cancel them. */
  const aborts = new Map<string, AbortController>();
  /** When each running pull started or last received bytes, for the watchdog; and those whose bytes are all here and being kept. */
  const movedAt = new Map<string, number>();
  const saving = new Set<string>();

  // Large files past their time go, once a page (ticket 03).
  if (!sweptBig) { sweptBig = true; void big.sweep(); }

  /** Tries again so far, and the timer of the next, per file. */
  const retries = new Map<string, { tries: number; timer?: ReturnType<typeof setTimeout> }>();
  const stopRetry = (hash: string): void => { clearTimeout(retries.get(hash)?.timer); retries.delete(hash); };
  /** A pull failed while a friend who has it is online: tried again later, by itself, if the schedule has a try left. */
  function failed(hash: string, reason: PullError): void {
    const was = retries.get(hash) ?? { tries: 0 };
    clearTimeout(was.timer);
    const delay = reason === 'busy' ? BUSY_RETRY_MS : reason === 'unreachable' || reason === 'lost' ? RETRY_MS[was.tries] : undefined;
    if (delay === undefined) { retries.delete(hash); setAttachment(hash, { status: 'failed', reason }); return; }
    const retryAt = Date.now() + delay;
    const timer = setTimeout(() => {
      const now = attachmentNow.get(hash);
      if (stopped || now?.status !== 'failed' || now.retryAt !== retryAt) return;
      setAttachment(hash, { status: 'idle' });
      want(hash);
    }, delay);
    retries.set(hash, { tries: reason === 'busy' ? was.tries : was.tries + 1, timer });
    setAttachment(hash, { status: 'failed', reason, retryAt });
  }

  /**
   * Every try again whose time has come is made now: after an outage, or when this tab takes the room back, a timer that
   * fired meanwhile found no socket or a tab not in charge (review of PR #70).
   */
  function retryDue(): void {
    const now = Date.now();
    for (const [hash, a] of [...attachmentNow]) {
      if (a.status !== 'failed' || a.retryAt === undefined || a.retryAt > now) continue;
      clearTimeout(retries.get(hash)?.timer);
      setAttachment(hash, { status: 'idle' });
      want(hash);
    }
  }

  /** Shows a file from bytes I hold: a blob URL of its own type if it shows inline, else one that only downloads. */
  function show(file: FileMeta, blob: Blob): void {
    stopRetry(file.hash);
    asked.delete(file.hash);
    roundReason.delete(file.hash);
    const url = URL.createObjectURL(new Blob([blob], { type: inlineKind(file.type) ? file.type : 'application/octet-stream' }));
    urls.push(url);
    setAttachment(file.hash, { status: 'ready', url });
  }

  /** A file announced in this room, live or from the history: shown from the store, or pulled, or left for a click. */
  async function arrived(file: FileMeta, from: string, byItself = true): Promise<void> {
    announced.add(file.hash);
    hold(file, from);
    // Known already: one waiting for a friend who is away may come from this one.
    if (attachmentNow.has(file.hash)) { if (attachmentNow.get(file.hash)!.status === 'waiting') want(file.hash); return; }
    setAttachment(file.hash, { status: 'idle' });
    const kept = await keptFile(file.hash);
    if (stopped) return;
    if (kept) show(file, kept);
    else if (byItself && pullsByItself(file)) want(file.hash);
    else if (file.piece) {
      // A pull of it that stopped, before a reload too: the button says how far it got, and goes on from there.
      const partial = await big.verified(file.hash);
      if (partial && attachmentNow.get(file.hash)?.status === 'idle') setAttachment(file.hash, { status: 'idle', partial });
    }
  }

  /** Files a test set a status of on purpose (the `pretend` hook): left as they are. */
  const pretended = new Set<string>();
  /** Asks for a file's bytes: pulled when its holder is online and a pull is free, else it waits. */
  function want(hash: string): void {
    if (pretended.has(hash)) return;
    const holder = holders.get(hash);
    const now = attachmentNow.get(hash);
    if (!holder || now?.status === 'ready' || now?.status === 'pulling' || queue.includes(hash)) return;
    // Nobody left to ask in a round that was cut short (a cancel, a lost socket): a new one.
    if (!candidates(hash).length && asked.has(hash)) newRound(hash);
    if (!candidates(hash).length) {
      newRound(hash);
      settle(hash);
      return;
    }
    setAttachment(hash, { status: 'pulling', received: 0 });
    queue.push(hash);
    nextPull();
  }

  /**
   * Nobody online can be asked for a file: everyone said "not there" lately. It waits while one who announced it is away;
   * otherwise nobody has it, and it says so, a click asking again.
   */
  function settle(hash: string): void {
    stopRetry(hash);
    const away = (holders.get(hash)?.from ?? []).some((k) => k !== opts.identity.publicKey && !online(k));
    setAttachment(hash, away ? { status: 'waiting' } : { status: 'failed', reason: 'not there' });
  }

  function nextPull(): void {
    while (pulling < PULLS_AT_ONCE && queue.length && !stopped) {
      const hash = queue.shift()!;
      const { file } = holders.get(hash)!;
      let from = candidates(hash)[0];
      // Its turn came with nobody left in its round (a friend left while it was queued): a new round, or it settles.
      // Straight to "waiting" left it there with a sender online who had only been busy (review round 2 of PR #71).
      if (!from) { newRound(hash); from = candidates(hash)[0]; }
      if (!from) { settle(hash); continue; }
      pulling++;
      const started = Date.now();
      const abort = new AbortController();
      aborts.set(hash, abort);
      movedAt.set(hash, Date.now());
      // A pull cancelled and asked again before it ended runs beside the new one: only the pull still in `aborts` is the
      // file's, and only it may touch what the file shows and its bookkeeping (review of PR #69).
      const current = () => aborts.get(hash) === abort;
      const moved = () => { if (current()) movedAt.set(hash, Date.now()); };
      let got = 0;
      const progress = (received: number) => { got = received; moved(); if (!disposed && current() && !abort.signal.aborted) setAttachment(hash, { status: 'pulling', received }); };
      // A large file comes in pieces, each checked and written to disk as it comes, from where an earlier pull of it
      // stopped (ticket 03); what it got is kept when it breaks off. Nothing of it is held but the piece under way.
      const run = async (): Promise<Blob> => {
        if (!file.piece) return (await links.pull(from, hash, file.size, progress, abort.signal, moved))!;
        if (!big.available()) throw new PullFailed('no room');
        const piece = file.piece;
        try {
          return await big.exclusive(hash, async () => {
            if (abort.signal.aborted) throw new PullFailed('lost');
            // Complete already (another room pulled it), or every segment on disk from a pull that died before the
            // end: nothing to ask anyone for (review of PR #72).
            const complete = await big.complete(hash);
            if (complete) return complete;
            const writer = await big.writer(hash, file.size, piece);
            if (writer.start >= file.size) return writer.done();
            const sink = { list: await big.list(hash), keepList: (list: Uint8Array) => big.keepList(hash, list), start: writer.start, write: writer.write };
            try {
              await links.pull(from, hash, file.size, progress, abort.signal, moved, { piece, sink });
            } catch (e) {
              await writer.end();
              throw e;
            }
            return writer.done();
          });
        } catch (e) {
          // No room left, or no storage at all (a private window): said so, not tried again (review of PR #72).
          throw noRoom(e) ? new PullFailed('no room') : e;
        }
      };
      void run()
        .then(async (blob) => {
          if (current()) saving.add(hash); // a large file takes a while to write on a slow phone: not a pull gone quiet
          posthog.capture('file_pulled', { bytes: file.size, ms: Date.now() - started, inline: inlineKind(file.type) ?? 'none', pieced: !!file.piece });
          // On disk already, outside the budget.
          if (file.piece) { if (!disposed) show(file, blob); return; }
          // Shown from the store's copy, which is on disk: the pulled one is in memory, as large as the file.
          await keepFile(hash, blob);
          const kept = await keptFile(hash);
          if (!disposed) show(file, kept ?? blob);
        })
        .catch((e: unknown) => {
          // Cancelled: back to waiting for a click, and not pulled by itself again.
          if (abort.signal.aborted) { posthog.capture('file_pull_cancelled', { bytes: file.size }); if (!disposed && current()) {
              setAttachment(hash, { status: 'idle' });
              // What a large one kept on disk: every piece it checked, which the next pull goes on after (ticket 03).
              if (file.piece && got) void big.verified(hash).then((partial) => { if (partial && attachmentNow.get(hash)?.status === 'idle') setAttachment(hash, { status: 'idle', partial }); });
            }
            return;
          }
          let reason: PullError = e instanceof PullFailed ? e.reason : 'lost';
          posthog.capture('file_pull_failed', { reason, bytes: file.size });
          if (!(e instanceof PullFailed)) console.error('pulling a file failed', e);
          if (disposed || !current()) return;
          // No socket let in: its ask could not go out, which says nothing of the friend. Not a try: it is due again as
          // soon as the Room lets this tab back in (review of PR #70).
          if (welcomed === null) { setAttachment(hash, { status: 'failed', reason, retryAt: Date.now() }); return; }
          // Someone else may have it: asked at once, not counted as a try. When nobody is left, the round ends.
          (asked.get(hash) ?? asked.set(hash, new Set()).get(hash)!).add(from);
          if (reason === 'not there') (notThere.get(hash) ?? notThere.set(hash, new Map()).get(hash)!).set(from, Date.now());
          const best = roundReason.get(hash);
          if (!best || HOPE.indexOf(reason) < HOPE.indexOf(best)) roundReason.set(hash, reason);
          // No room here is no friend's doing: asking another would end the same way.
          if (reason !== 'no room' && candidates(hash).length) { setAttachment(hash, { status: 'idle' }); want(hash); return; }
          const ended = reason === 'no room' ? reason : roundReason.get(hash)!;
          newRound(hash);
          // Someone has it, busy or out of reach (whether they announced it or only pulled it): tried again on the
          // schedule. Everyone said "not there": it waits for one who announced it, or says nobody has it.
          if (ended !== 'not there' && ended !== 'damaged') failed(hash, ended);
          else if (!reachable(hash).length) settle(hash);
          else failed(hash, ended);
        })
        .finally(() => {
          if (current()) { aborts.delete(hash); movedAt.delete(hash); saving.delete(hash); }
          pulling--;
          nextPull();
        });
    }
  }

  // What the chat shows of each attachment against what the pulls have (attachments ticket 04, core/invariants.ts).
  // A tab another took the room from is not in charge of it, and one without a socket can ask nobody: their view is not
  // judged until the Room lets them in again.
  const watchdog = createFileWatchdog(() => ({
    at: Date.now(),
    files: stopped || welcomed === null ? [] : [...attachmentNow].map(([hash, a], i) => ({
      key: String(i), status: a.status, running: aborts.has(hash) || queue.includes(hash), active: aborts.has(hash) && !saving.has(hash),
      movedAt: movedAt.get(hash) ?? null, holderOnline: reachable(hash).some((k) => !saidNotThere(hash, k)), retryAt: a.status === 'failed' ? (a.retryAt ?? null) : null,
    })),
  }));
  if (exposeHooks) {
    // Inspection hooks for the e2e suite, per room id: the watchdog's reports, and a status set against the pulls, so a
    // test can break each invariant on purpose. Absent in the builds friends get.
    const w = window as unknown as { __daveFiles?: Record<string, unknown> };
    w.__daveFiles = {
      ...w.__daveFiles,
      [opts.roomId]: {
        invariants: () => watchdog.violations(),
        attachments: () => Object.fromEntries([...attachmentNow].map(([h, a]) => [h, a.status])),
        // Held there: nothing pulls it meanwhile, as a presence update would for a file pretended to wait.
        pretend: (hash: string, status: 'pulling' | 'waiting') => { pretended.add(hash); setAttachment(hash, status === 'pulling' ? { status, received: 0 } : { status }); },
      },
    };
  }

  // A friend who holds a file I wait for came online: pull it now. One whose pull failed for a link that did not come up
  // or dropped (a tab frozen in the background, a phone that changed networks) is tried again when they come back.
  let wasOnline = new Set<string>();
  createEffect(() => people(), (ps) => {
    const now = new Set(ps.map((p) => p.publicKey));
    const back = (hash: string) => (holders.get(hash)?.from ?? []).some((k) => now.has(k) && !wasOnline.has(k));
    for (const [hash, a] of attachmentNow) {
      // Only on someone coming online, not on every update (a mute, a rename): a waiting file asks the newcomer.
      const newcomer = [...now].some((k) => !wasOnline.has(k));
      if ((a.status === 'waiting' && newcomer) || (a.status === 'failed' && (a.reason === 'unreachable' || a.reason === 'lost') && back(hash))) want(hash);
    }
    wasOnline = now;
  });

  function open() {
    if (stopped) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/${opts.roomId}`);
    ws = socket;
    sockets.add(socket);
    const life: Life = { welcomedAt: null, frameAt: null };
    /** Gives the socket up: its close could come late or never, with a server or a network that does not answer. */
    const giveUp = (code: number) => {
      socket.onopen = socket.onmessage = socket.onclose = null;
      if (code === HANDSHAKE_GIVEN_UP) socket.close();
      else socket.close(code, 'pings unanswered');
      lost(socket, code, life);
    };
    const handshake = setTimeout(() => {
      if (ws !== socket || welcomed === socket || stopped) return;
      giveUp(HANDSHAKE_GIVEN_UP);
    }, HANDSHAKE_TIMEOUT_MS);
    const beats = heartbeat(Date.now());

    socket.onopen = () => {
      pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // A socket the network cut without a close (ticket 54) would otherwise look open for good, its texts gone into it.
        if (beat(beats, Date.now()) === 'ping') socket.send(PING_FRAME);
        else giveUp(PINGS_UNANSWERED);
      }, PING_INTERVAL_MS);
    };

    socket.onmessage = async (e) => {
      heard(beats);
      life.frameAt = Date.now();
      const m = JSON.parse(e.data as string) as ServerMessage;
      switch (m.t) {
        case 'challenge': {
          const { name, picture, telemetry } = carried(latest);
          const auth = await buildAuthMessage({
            authKey: opts.authKey, nonce: m.nonce, publicKeyRaw: opts.identity.publicKeyRaw, privateKey: opts.identity.keys.privateKey, name, ...(picture ? { picture } : {}),
          });
          // Nobody has entered this room yet: our answer also hands the server the verifier (ADR 0004). The PostHog
          // opt-in rides along, so the server reports this socket's refused frames only with consent (ticket 32).
          // Closed while signing (the page reloading, another tab taking over): nothing to answer.
          if (socket.readyState !== WebSocket.OPEN) return;
          authCarried = { name, picture, telemetry };
          socket.send(JSON.stringify({ ...auth, ...(m.fresh ? { authKey: opts.authKey } : {}), ...(telemetry ? { telemetry: true } : {}) }));
          return;
        }
        case 'welcome':
          clearTimeout(handshake);
          life.welcomedAt = Date.now();
          welcomed = socket;
          welcomes++;
          attempt = 0;
          setYou(m.you);
          // A rename, a picture or an opt-in changed while the handshake ran went to no socket; the auth had the old one.
          if (authCarried) for (const d of afterWelcome(latest, authCarried)) send(d);
          // Texts the last socket took and never brought back, or written while there was none, in their order; the Room
          // answers them in that order too. One that waited a day is not sent: it would come out of the blue.
          dropTooOld();
          for (const u of unconfirmed) sendText(u);
          for (const f of pendingFiles()) if (f.sealed) send({ t: 'file', sealed: f.sealed, id: f.id });
          retryDue();
          setStatus({ kind: 'connected' });
          if (everConnected) {
            // No line in the chat about it: the status pill already shows the outage live, and dated lines that stayed
            // in the history piled up on flaky links (reports of Sep 16 and 20). A dead socket is only noticed when
            // a ping goes unanswered, so the gap sent here can be shorter than the real one.
            posthog.capture('server_reconnected', { down_ms: downSince ? Date.now() - downSince : 0 });
          }
          everConnected = true;
          downSince = null;
          clearTimeout(unavailableTimer);
          return;
        case 'presence':
          // A friend gone from it keeps their file links: a link does not need the socket, which a phone changing
          // networks drops for a moment. A link to one who is gone for good fails or stalls by itself (client/links.ts).
          forgetEnded(latest, m.people);
          setPeople(m.people);
          return;
        case 'sealed':
          opening = opening.then(() => received(m)).catch((e: unknown) => console.error('opening a text failed', e));
          return;
        case 'file':
          opening = opening.then(() => receivedFile(m)).catch((e: unknown) => console.error('opening a file failed', e));
          return;
        case 'link':
        case 'linkice':
          links.onMessage(m);
          return;
        case 'error':
          if (you()) {
            // After the welcome an error means a frame of ours was dropped. Chat-related ones are said in the chat;
            // signaling ones, and any the server cannot attribute, are a developer concern and would only confuse in the
            // chat: an oversized signal once showed as "Not sent" (ticket 30).
            posthog.capture('frame_dropped', { ref: m.ref ?? 'unknown', reason: m.reason });
            if (m.ref === 'link' || m.ref === 'linkice') return; // the pull that sent it times out and says so
            if (m.ref === 'file') {
              // The Room answers in order: the oldest attachment still waiting was refused.
              const at = Date.now();
              opening = opening.then(() => {
                if (stopped || welcomed !== socket) return;
                push({ kind: 'system', text: `Not sent: ${m.reason}.`, at });
                setPendingFiles((p) => p.slice(1));
              });
              return;
            }
            if (!m.ref || m.ref === 'signal' || m.ref === 'ice') console.warn('dropped', m.ref ?? 'unknown', m.reason);
            else if (m.ref === 'sealed' || m.ref === 'text') {
              // The Room answers texts in the order they came: a refusal is for the oldest one still waiting, once the texts
              // the Room brought back before it are opened. The chat said it was not sent, so it is not sent again.
              const at = Date.now();
              opening = opening.then(() => {
                // Another tab took over, or the room was left: the waiting texts are no longer this socket's to drop.
                if (stopped || welcomed !== socket) return;
                push({ kind: 'system', text: `Not sent: ${m.reason}.`, at });
                if (unconfirmed.shift()) unconfirmedChanged();
              });
            } else push({ kind: 'system', text: `Dropped: ${m.reason}.`, at: Date.now() });
          } else if (status().kind !== 'refused') {
            // A wrong answer during the handshake: our stored secret is wrong. Retrying cannot help.
            setStatus({ kind: 'refused', reason: m.reason });
            stopped = true;
            socket.close(1000, 'refused');
          }
          return;
        case 'pong':
          return;
        case 'call':
          // The Room has this friend in its call on this socket again: what she declared in it is said again, the asks
          // to watch a share among it. The answer goes on to the call (client/call.ts).
          if (socket === welcomed && inCall()) for (const d of afterJoin(latest, people())) send(d);
          break;
        case 'left':
          forgetWatch(latest, m.publicKey);
          break;
      }
      for (const l of listeners) l(m);
    };

    socket.onclose = (e) => { clearTimeout(handshake); lost(socket, e.code, life); };
  }

  /** A socket is gone, closed or given up: try again after a while, unless the close says that cannot help. */
  function lost(socket: WebSocket, code: number, life: Life) {
    const rooms = sockets.size;
    sockets.delete(socket);
    clearInterval(pingTimer);
    if (ws === socket) ws = null;
    if (welcomed === socket) welcomed = null;
    setYou(null);
    if (stopped) return;
    // What tells a network that cut one socket from a phone that lost its network, or a tab asleep (ticket 54).
    const now = Date.now();
    posthog.capture('server_socket_closed', {
      code,
      ever_connected: everConnected,
      age_ms: life.welcomedAt === null ? null : now - life.welcomedAt,
      since_frame_ms: life.frameAt === null ? null : now - life.frameAt,
      visible: document.visibilityState === 'visible',
      online: navigator.onLine,
      rooms,
      ...(GIVEN_UP[code] ? { reason: GIVEN_UP[code] } : {}),
    });
    if (code === CLOSE_SUPERSEDED) {
      stopped = true;
      // The room is another tab's now, and so are the texts still out: it took them from the browser's storage as it
      // opened. Kept here, they would be sent when this one takes the room back, maybe hours later.
      unconfirmed.length = 0;
      unconfirmedChanged(false);
      setStatus({ kind: 'elsewhere' });
      return;
    }
    if (code === CLOSE_AUTH_FAILED) {
      stopped = true;
      setStatus({ kind: 'refused', reason: 'the invite link is wrong or has been rotated' });
      return;
    }
    if (downSince === null) {
      downSince = Date.now();
      const since = downSince;
      // Escalate on a clock of its own, not only when a further attempt fails (spec §7.2).
      unavailableTimer = setTimeout(() => { if (downSince === since && !stopped) setStatus({ kind: 'unavailable', since }); }, UNAVAILABLE_AFTER_MS);
    }
    const down = Date.now() - downSince;
    setStatus(down >= UNAVAILABLE_AFTER_MS ? { kind: 'unavailable', since: downSince } : { kind: 'reconnecting', since: downSince });
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    attempt++;
    reconnectTimer = setTimeout(open, delay);
  }

  // The first connection waits while `hold` says so: a new version downloading as the app opens (ticket 36) would only
  // show friends to take them away again with its reload, and they would see this browser come, go and come back.
  if (!opts.hold) open();
  else {
    let begun = false;
    createEffect(() => opts.hold!(), (held) => { if (!held && !begun) { begun = true; open(); } });
  }
  // Only once let in (`send`): before the welcome, any frame but the auth counts as a failed attempt, and the reply would
  // read as a refusal. A change during the handshake goes out with the welcome instead.
  const offConsent = onConsentChange((on) => { declareLatest({ t: 'telemetry', on }); });
  onCleanup(() => {
    offConsent();
    stopped = true;
    disposed = true;
    for (const r of retries.values()) clearTimeout(r.timer);
    watchdog.stop();
    delete (window as unknown as { __daveFiles?: Record<string, unknown> }).__daveFiles?.[opts.roomId];
    links.close();
    for (const url of urls) URL.revokeObjectURL(url);
    clearTimeout(reconnectTimer);
    clearTimeout(unavailableTimer);
    clearInterval(pingTimer);
    if (ws) sockets.delete(ws);
    ws?.close(1000, 'bye');
  });

  return {
    roomId: opts.roomId,
    status,
    you,
    people,
    /** The chat: what came back from the Room, then my own texts still on their way, as waiting. */
    lines: createMemo((): ChatLine[] => {
      const waiting = pending();
      const files = pendingFiles();
      if (!waiting.length && !files.length) return lines();
      const { name, picture } = carried(latest);
      const me: Identity = you() ?? { publicKey: opts.identity.publicKey, fingerprint: opts.identity.fingerprint, name, ...(picture ? { picture } : {}) };
      const mine = [
        // Files first: one sent with a text in the same millisecond was handed over first, and stays first (a stable sort).
        ...files.map((f): ChatLine => ({ kind: 'file', id: `pending:${f.id}`, from: me, file: f.file, at: f.at, pending: true })),
        ...waiting.map((u): ChatLine => ({ kind: 'text', id: `pending:${u.id}`, from: me, text: u.text, at: u.at, pending: true })),
      ].sort((a, b) => a.at - b.at);
      return [...lines(), ...mine];
    }),
    /** Where an attachment's bytes are (`Attachment`); undefined before its announcement is shown. */
    attachment: (hash: string): Attachment | undefined => attachments()[hash],
    /** Stops a pull, running or queued; the file waits for a click again, at once, whatever the pull is waiting on. */
    cancelPull: (hash: string): void => {
      newRound(hash);
      const queued = queue.indexOf(hash);
      if (queued >= 0) queue.splice(queued, 1);
      aborts.get(hash)?.abort();
      stopRetry(hash);
      const now = attachmentNow.get(hash);
      if (now?.status === 'pulling' || (now?.status === 'failed' && now.retryAt)) setAttachment(hash, { status: 'idle' });
    },
    /** Pulls a file that waits for a click, or one that failed. */
    pull: (hash: string): void => { const a = attachmentNow.get(hash); if (a?.status === 'idle' || a?.status === 'failed') { stopRetry(hash); newRound(hash); notThere.delete(hash); setAttachment(hash, { status: 'idle' }); want(hash); } },
    unread,
    /** The room is on screen: nothing in it is unread. */
    markRead: () => setUnread(0),
    /** Sends an event (a text, a signal, a request for ICE servers) on the socket let in, if there is one. */
    send,
    declare: declareLatest,
    /**
     * Enters the call on this socket. The join is an event (client/call.ts waits for its answer); what it declares, muted
     * and sharing, comes from the latest declarations. Returns whether it went out.
     */
    join: (id: RequestId): boolean => {
      if (!send({ t: 'join', ...joinDeclares(latest), id })) return false;
      callOn = welcomes;
      return true;
    },
    /** Leaves the call, if the Room has this friend in it on this socket; what she declared in the call ends with it. */
    leave: (): void => {
      if (inCall()) send({ t: 'leave' });
      callOn = null;
      leaveCall(latest);
    },
    /** The Room has this friend in its call on the socket let in: her join went out on it, and no leave since. */
    inCall,
    /** Counts the sockets the server has let in; read without waiting for any effect, so a frame can name its socket. */
    welcomes: () => welcomes,
    /**
     * Sends a text, or keeps it for the next socket while there is none. It shows as waiting until the Room brings it back;
     * a socket lost meanwhile sends it again on the next one.
     */
    sendText: (text: string) => {
      // The Room cannot read a sealed text to refuse it, and friends would drop it unseen (core/sealed.ts): said here instead.
      if (text.length > MAX_TEXT_LENGTH) { push({ kind: 'system', text: `Not sent: message longer than ${MAX_TEXT_LENGTH} characters.`, at: Date.now() }); return; }
      const id = randomHex(12);
      unconfirmed.push({ id, text, at: Date.now() });
      unconfirmedChanged();
      sendText({ id, text });
      posthog.capture('message_sent');
    },
    /**
     * Sends a file (ADR 0006), prepared beforehand (`prepareFile`): it is kept here, and its announcement goes sealed, with
     * a preview for a picture or a video. Friends pull the bytes from this browser. Like a text, it waits for a socket, and
     * goes again on the next one if the last took it without bringing it back; unlike a text, a reload forgets it. It goes
     * at once: after what was sent before it and before what is sent after it, a text among them.
     */
    sendPrepared,
    /** Empties the local history; the server never had it. */
    clearHistory: async () => { await clearHistory(opts.roomId); setLines([]); },
    /** Dev aid for scripts/drive.mjs: drops the socket so the reconnect path runs. */
    dropSocket: () => ws?.close(),
    /** Change the name everyone sees; presence brings it back. A later reconnect authenticates with it too. */
    rename: (next: string) => { declareLatest({ t: 'name', name: next }); },
    /** Choose the emoji everyone sees as your avatar, or null for the initial; presence brings it back. */
    setPicture: (next: string | null) => { declareLatest({ t: 'picture', picture: next }); },
    /** After stepping back for another tab: reconnect here, which supersedes that tab in turn. */
    takeOver: () => {
      if (status().kind !== 'elsewhere') return;
      // What the other tab still had out, as it left it.
      unconfirmed.push(...loadUnsent(opts.roomId));
      unconfirmedChanged(false);
      stopped = false; attempt = 0; downSince = null; setStatus({ kind: 'connecting' }); open();
      nextPull(); // pulls queued while another tab had the room
    },
    /** Fires for texts from other people (for the message cue). */
    onText: (l: (m: Text) => void) => { textListeners.add(l); return () => textListeners.delete(l); },
    /** Messages the room store does not handle itself (call, left, signal, ice) go to subscribers. */
    subscribe: (l: (m: ServerMessage) => void) => { listeners.add(l); return () => listeners.delete(l); },
  };
}
