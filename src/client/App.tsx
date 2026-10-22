import { createSignal, Switch, Match, createMemo, createEffect, For, Show, untrack, onCleanup, onSettled, mapArray } from 'solid-js';
import './styles.css';
import dino from './dino.svg';
import posthog, { consent, isTestAccount, setConsent, telemetryOn, type Consent } from './posthog';
import { loadIdentity, type LocalIdentity } from './identity';
import { getName, getPicture, inviteLinkFor, setName, setPicture, takeInviteLink } from './invite';
import { addRoom, forgetRoom, getSelectedRoom, loadRooms, setSelectedRoom, type SavedRoom } from './rooms';
import { newRoomSecret, normaliseRoomName, parseInviteText, withoutBreaks, type InviteLink } from '../core/rooms';
import { encodeQr, qrPath } from '../core/qr';
import { createRoom, prepareFile, type Attachment, type ChatLine, type PreparedFile, type ServerStatus } from './room';
import { createPrivates } from './privates';
import { formatSize, inlineKind, pastedImageUrl, type FileMeta } from '../core/attachment';
import type { PullError } from './links';
import { MIC_TEST_RECORD_MS, createCall, type ConnState, type OutgoingShare, type PeerView } from './call';
import { createAttention, type RoomLink } from './attention';
import { windowFocused } from './focus';
import { contactOf, isKnown, markKnown, setNickname } from './contacts';
import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH, identityOf, normaliseName, type Identity, type Person } from '../core/protocol';
import { displayName, formatAgo, knownAgo } from '../core/names';
import { DEFAULT_VOICE_THRESHOLD, LOW_LATENCY_MS, MAX_VOICE_THRESHOLD, MAX_VOLUME, mbpsToBps, processingIsDefault, type AudioSettings, type Degradation, type FrameRate, type MaxHeight } from '../core/settings';
import { formatBitrate, formatVideo } from '../core/format';
import { FOLD_OLDER_MS, olderCount } from '../core/chatlog';
import { formatDelay, lagLevel } from '../core/lowvoice';
import { shareTileState } from '../core/invariants';
import { VOICE_REPAIRS, type VoiceRepair } from '../core/voicerepair';
import { collectReport, formatReport, sendReport, type Report } from './diagnostics';
import { CATEGORIES, SEVERITIES, isCategory, isSeverity, type Category, type Severity } from '../core/report';
import { EmojiPicker } from './EmojiPicker';
import { place } from './place';
import { createTabLock } from './tablock';
import { build, commitUrl, REPO_URL, shortCommit } from './version';
import { THEMES, THEME_GROUPS, setTheme, theme } from './theme';
import { applyUpdate, downloadProgress, holding, noteOffered, tabSettled, updateReady } from './update';

export default function App() {
  // An invite link is consumed before anything else renders, so it never stays in the address bar.
  const invite = takeInviteLink();
  const [rooms, setRooms] = createSignal<SavedRoom[] | null>(null);
  const [selected, setSelected] = createSignal<string | null>(getSelectedRoom());
  /** The room started in this browser during this visit, if any: its link still has to be sent around. */
  const [created, setCreated] = createSignal<string | null>(null);
  const [name, setNameSignal] = createSignal(getName());
  const [identity, setIdentity] = createSignal<LocalIdentity | null>(null);
  const [identityError, setIdentityError] = createSignal<string | null>(null);
  const [roomsError, setRoomsError] = createSignal<string | null>(null);

  loadIdentity().then(setIdentity, (e: unknown) => setIdentityError(e instanceof Error ? e.message : String(e)));
  /** Only the tab holding the lock opens sockets; another tab of this browser shows a notice (ticket 25). */
  const tab = createTabLock();
  createEffect(() => tab.state().kind, (kind) => { if (kind !== 'checking') tabSettled(kind === 'held'); });

  const select = (secret: string) => { setSelectedRoom(secret); setSelected(secret); };
  /** The room from a link joins the list (or takes the link's name if already known) and comes on screen. */
  const enter = async (list: SavedRoom[], link: InviteLink, via: 'opened' | 'pasted'): Promise<SavedRoom[]> => {
    const known = list.some((r) => r.secret === link.secret);
    const next = await addRoom(list, link);
    select(link.secret);
    posthog.capture('room_entered_by_link', { known, via });
    return next;
  };
  loadRooms().then(async (list) => setRooms(invite ? await enter(list, invite, 'opened') : list), (e: unknown) => setRoomsError(e instanceof Error ? e.message : String(e)));
  // A link opened in a tab that already shows the app only changes the fragment: no load, so it is read here.
  window.addEventListener('hashchange', () => {
    const link = takeInviteLink();
    const list = rooms();
    if (link && list) void enter(list, link, 'opened').then(setRooms);
  });
  // What another tab of this browser writes: the tab on the notice screen still takes invite links, and the tab that
  // runs the app shows the room at once.
  window.addEventListener('storage', (e) => {
    if (e.key === 'dave.rooms') {
      void loadRooms().then(setRooms); // rooms already here keep their sockets: the workspace keys them by secret
    }
    if (e.key === 'dave.room' && e.newValue) setSelected(e.newValue);
    if (e.key === 'dave.name' && e.newValue) setNameSignal(e.newValue);
  });
  // A link pasted in. A home-screen web app on iOS never receives a tapped link (Safari opens it, in its own
  // storage), so pasting is the only way a room reaches such an app.
  const join = (link: InviteLink) => { void enter(rooms() ?? [], link, 'pasted').then(setRooms); };
  const create = async (roomName: string): Promise<SavedRoom> => {
    const list = await addRoom(rooms() ?? [], { secret: newRoomSecret(), name: roomName });
    const room = list[list.length - 1]!;
    select(room.secret);
    setCreated(room.secret);
    setRooms(list);
    posthog.capture('room_created');
    return room;
  };
  const forget = (secret: string) => {
    const list = forgetRoom(rooms() ?? [], secret);
    if (selected() === secret && list[0]) select(list[0].secret);
    setRooms(list);
    posthog.capture('room_left');
  };
  const rename = (n: string) => { setName(n); setNameSignal(n); };

  const ready = createMemo(() => {
    const list = rooms();
    const t = tab.state();
    return list && list.length > 0 && name() && identity() && t.kind === 'held' ? { rooms: list, selected: selected(), created: created(), name: name()!, identity: identity()!, mayRejoin: t.mayRejoin } : null;
  });

  return (
    <>
      <Show when={updateReady() && tab.state().kind === 'held'}><UpdateBar /></Show>
      <Show when={downloadProgress() && tab.state().kind !== 'waiting'}><UpdateLine /></Show>
      <Switch>
        <Match when={roomsError()}>
          <Notice title="Your rooms could not be loaded">This browser could not read the rooms it saved ({roomsError()}). Blocked site data or an old browser cause this.</Notice>
        </Match>
        <Match when={rooms() === null}>{null}</Match>
        <Match when={rooms()?.length === 0}>
          <main class="notice">
            <h1>dave</h1>
            <h2>You need an invite link</h2>
            <p>Open the link a friend sent you, or paste it here. Nothing else gets you in.</p>
            <JoinLinkForm autofocus onJoin={join} />
            <VersionDialog />
          </main>
        </Match>
        <Match when={!name()}>
          <NameForm onSubmit={rename} />
        </Match>
        <Match when={identityError()}>
          <Notice title="No identity key">This browser could not create or load an identity key ({identityError()}). Private windows and blocked site data cause this.</Notice>
        </Match>
        <Match when={!identity()}>{null}</Match>
        <Match when={tab.state().kind === 'checking'}>{null}</Match>
        <Match when={tab.state().kind === 'waiting'}>
          <main class="notice">
            <h1>dave</h1>
            <h2>Dave is already open in another tab</h2>
            <p>That tab keeps working. {invite ? `${invite.name} was added to it. ` : ''}This one connects by itself once the other closes.</p>
            <p><button onClick={tab.takeOver}>Use it here instead</button></p>
          </main>
        </Match>
        <Match when={ready()}>{(r) => <Workspace {...r()} onStepBack={tab.onStepBack} onSelect={select} onCreate={create} onJoin={join} onForget={forget} onRename={rename} />}</Match>
      </Switch>
    </>
  );
}

/**
 * A newer version is installed and waiting (ticket 33). Over every screen of the tab that runs the app, with no way to
 * close it but the reload: a nag on purpose. A tab behind another (ticket 25) is not asked until it takes over.
 */
function UpdateBar() {
  noteOffered();
  return (
    <div class="update" role="status">
      <span>A new version of dave is ready.</span>
      <button onClick={applyUpdate}>Reload</button>
    </div>
  );
}

/**
 * A new version downloading (ticket 36): a thin line over the top edge of the page, so nothing moves, and nothing to
 * click. One found as the app opened reloads the page once it is in; one found later ends in the update bar.
 */
function UpdateLine() {
  const percent = () => { const d = downloadProgress(); return d && d.total > 0 ? Math.round((d.done / d.total) * 100) : 0; };
  return (
    <div class="update-line" role="progressbar" aria-label="Downloading the new version of dave" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent()}>
      <div style={{ width: `${Math.max(percent(), 3)}%` }} />
    </div>
  );
}

function Notice(props: { title: string; children: any }) {
  return (
    <main class="notice">
      <h1>dave</h1>
      <h2>{props.title}</h2>
      <p>{props.children}</p>
    </main>
  );
}

function NameForm(props: { onSubmit: (name: string) => void }) {
  const [draft, setDraft] = createSignal('');
  const valid = () => normaliseName(draft()) !== null;
  return (
    <main class="notice">
      <h1>dave</h1>
      <form onSubmit={(e) => { e.preventDefault(); const n = normaliseName(draft()); if (n) { posthog.capture('name_set'); props.onSubmit(n); } }}>
        <p>What should your friends call you?</p>
        <input value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={32} autofocus placeholder="Your name" />
        <button disabled={!valid()}>Continue</button>
        <p class="dim">Names are not unique. Friends tell you apart by this browser's key, and each of them can call you something else on their side.</p>
      </form>
    </main>
  );
}

/**
 * An invite link typed or pasted in, for a browser the link itself cannot reach. Accepts the whole URL or
 * just its fragment. The Paste button reads the clipboard directly (iOS asks once); the field is the fallback.
 */
function JoinLinkForm(props: { onJoin: (link: InviteLink) => void; onCancel?: () => void; autofocus?: boolean }) {
  const [draft, setDraft] = createSignal('');
  const [note, setNote] = createSignal<string | null>(null);
  const parsed = () => parseInviteText(draft());
  const canReadClipboard = typeof navigator.clipboard?.readText === 'function';
  const join = (link: InviteLink) => { setDraft(''); setNote(null); props.onJoin(link); };
  const submit = (e: Event) => { e.preventDefault(); const link = parsed(); if (link) join(link); };
  const paste = async () => {
    let text: string;
    try { text = await navigator.clipboard.readText(); } catch { setNote('Could not read the clipboard. Paste the link into the field instead.'); return; }
    const link = parseInviteText(text);
    if (link) join(link);
    else { setDraft(withoutBreaks(text)); setNote('The clipboard does not hold an invite link.'); }
  };
  return (
    <form class="joinlink" onSubmit={submit}>
      <input value={draft()} onInput={(e) => { setDraft(e.currentTarget.value); setNote(null); }} autofocus={props.autofocus} placeholder="Invite link" aria-label="Invite link" autocomplete="off" autocapitalize="off" spellcheck={false} />
      <div class="row">
        <button class="on" disabled={parsed() === null}>Join</button>
        <Show when={canReadClipboard}><button type="button" title="Read the link from the clipboard" onClick={() => void paste()}>Paste</button></Show>
        <Show when={props.onCancel}><button type="button" onClick={props.onCancel}>Cancel</button></Show>
      </div>
      <Show when={note()}><div class="warn">{note()}</div></Show>
    </form>
  );
}

/** One room this browser is in: what was saved about it, its socket, and its call. */
type Link = RoomLink & { saved: SavedRoom };

type WorkspaceProps = {
  rooms: SavedRoom[]; selected: string | null; created: string | null; name: string; identity: LocalIdentity;
  /** The tab lock came at load, as after a reload: a call this browser was just in may be rejoined. */
  mayRejoin: boolean;
  /** Registers what to do when another tab takes over, before this workspace goes away. */
  onStepBack: (fn: () => void) => () => void;
  onSelect: (secret: string) => void; onCreate: (name: string) => Promise<SavedRoom>; onJoin: (link: InviteLink) => void; onForget: (secret: string) => void; onRename: (name: string) => void;
};

/**
 * Owns the sockets: one connection and one call object per room, created when the room joins the list and
 * disposed when it is left. One room is on screen (its chat, its composer); at most one call is joined,
 * and it stays joined while you read another room.
 */
function Workspace(props: WorkspaceProps) {
  // Pseudonymous identity for analytics: the public key, nothing personal. The fingerprint is the
  // same code the profile card shows, so a report's person can be matched to a friend by eye. A
  // driver-seeded browser marks its person for the project's test-account filter. One-time read on purpose.
  // Kept in memory; it reaches PostHog only once this browser opts in (ticket 32).
  const identity = untrack(() => props.identity);
  /** The mascot asks again, from the sidebar, so the answer is changed with what is sent in view. */
  const [askingConsent, setAskingConsent] = createSignal(false);
  const me = identity.publicKey;
  // The theme too, so the person says which one a friend has also when it was picked before PostHog was told of picks.
  posthog.identify(me, { fingerprint: identity.fingerprint, theme: theme() || 'default', ...(isTestAccount ? { $internal_or_test_user: true } : {}) });
  // Keyed by secret, not by the saved object: an invite link that renames a room already here (in this tab, or in a
  // waiting one, ticket 25) replaces the object, and must not rebuild the room and drop its call. The name is read live.
  const links = mapArray(() => props.rooms.map((r) => r.secret), (secret): Link => {
    let last = untrack(() => props.rooms.find((r) => r.secret === secret)!);
    // A deliberate one-time snapshot of name and picture: the socket is created once; changes go through `rename` and `setPicture`.
    // Private files are served by their conversation's word: to the friend it is with alone (client/privates.ts).
    const room = createRoom({ identity, roomId: last.id, authKey: last.authKey, textKey: last.textKey, name: untrack(() => props.name), picture: getPicture(), hold: holding, servesPrivate: (hash, peer) => privates.serves(hash, peer) });
    const call = createCall(room, identity, { mayRejoin: untrack(() => props.mayRejoin) });
    posthog.capture('room_entered');
    // The latest saved entry; the last one seen while the room is being forgotten and its link disposed.
    return { get saved() { return (last = props.rooms.find((r) => r.secret === secret) ?? last); }, room, call };
  });
  onCleanup(props.onStepBack(() => { for (const l of untrack(links)) l.call.leave(); })); // a join under way too
  /** The room on screen. Null only for the moment between leaving the last room and the workspace going away. */
  const current = createMemo(() => links().find((l) => l.saved.secret === props.selected) ?? links()[0] ?? null);
  /** The room whose call I am in, if any. */
  const active = createMemo(() => links().find((l) => l.call.inCall()) ?? null);
  /** Whose shares are on screen: the call I am in, else the room I am reading. */
  const stage = () => active() ?? current();
  /** Everyone online in any of my rooms, once each; a participant anywhere is listed as one. */
  const everyone = createMemo(() => {
    const byKey = new Map<string, Person>();
    for (const l of links()) for (const p of l.room.people()) {
      const prev = byKey.get(p.publicKey);
      if (!prev || (p.role === 'participant' && prev.role !== 'participant')) byKey.set(p.publicKey, p);
    }
    return [...byKey.values()];
  });
  /** A friend's current presence entry, from any room; a chat line keeps the name and picture they had when they wrote it. */
  const present = (publicKey: string): Person | undefined => everyone().find((p) => p.publicKey === publicKey);
  /** How this browser shows a friend: the name, the picture, and the hover title with the rest. The fingerprint is in the title and the profile card, never beside the name. */
  const labelOf = (id: Identity): Label => {
    const c = contactOf(id.publicKey);
    const isMe = id.publicKey === me;
    const now = present(id.publicKey);
    const own = now?.name ?? id.name;
    const shown = displayName(own, c);
    const known = isMe || c !== undefined;
    const ago = knownAgo(c);
    const title = [c?.nick ? `calls themselves ${own}` : null, `fingerprint ${id.fingerprint}`, isMe ? null : ago ? `known since ${ago}` : 'first time this key shows up here'].filter(Boolean).join(' · ');
    return { shown, known, title, picture: now ? now.picture : id.picture };
  };
  /** My private conversations (ADR 0007), one per friend, whichever rooms we share. */
  const privates = createPrivates({ identity, name: () => props.name, rooms: () => links().map((l) => ({ room: l.room, name: l.saved.name })), current: () => current()?.room ?? null });
  createAttention(links, me, privates.onText);
  // My profile card, and the avatar it hangs from. A friend's avatar opens my private conversation with them instead,
  // whose head is their profile; opening it acknowledges the key, as the card did.
  const [profile, setProfile] = createSignal<{ publicKey: string; anchor: HTMLElement } | null>(null);
  const openProfile = (p: Person, anchor: HTMLElement) => {
    if (p.publicKey !== me) { openPrivate(p); return; }
    setProfile({ publicKey: p.publicKey, anchor });
    posthog.capture('profile_opened', { own: true });
  };
  const openPrivate = (friend: Identity) => {
    if (!isKnown(friend.publicKey)) { markKnown(friend.publicKey, friend.name); posthog.capture('new_key_acknowledged'); }
    privates.open(friend);
    setPrivateJump((n) => n + 1);
    // On a phone the log is below the lists, in the one column that scrolls: the conversation comes into view.
    queueMicrotask(() => document.querySelector('.private-head')?.scrollIntoView({ block: 'start' }));
  };
  // Online: friends who are in none of the calls, across all rooms; you are listed last (spec §7.1).
  // Friends in the order they came, the newest on top: each one slides in from above and pushes the rest down. One who
  // leaves the list (offline, or into a call) and comes back counts as new.
  // Your own row follows this browser's call state, not the server's echo of it: a Leave moves you in one step, not two.
  // Until the server's first presence it is drawn from what this browser knows, so it is on screen from the start.
  const localSelf = (): Person => ({ publicKey: me, fingerprint: identity.fingerprint, name: props.name, ...(getPicture() ? { picture: getPicture()! } : {}), role: 'visitor', joinSeq: null, sharing: false, muted: false });
  /** Everyone, and you before the server has you: what the lists and the profile card show. */
  const withMe = createMemo(() => (everyone().some((p) => p.publicKey === me) ? everyone() : [...everyone(), localSelf()]));
  const cameAt = new Map<string, number>();
  /** When each came online (or out of a call), to slide in only then: a row moved to another list by a room switch does not. */
  const arrivedAt = new Map<string, number>();
  const justCame = (key: string): boolean => Date.now() - (arrivedAt.get(key) ?? 0) < ARRIVE_MS;
  let came = 0;
  const online = createMemo(() => {
    const others = withMe().filter((p) => p.role === 'visitor' && p.publicKey !== me);
    for (const key of cameAt.keys()) if (!others.some((p) => p.publicKey === key)) { cameAt.delete(key); arrivedAt.delete(key); }
    for (const p of others) if (!cameAt.has(p.publicKey)) { cameAt.set(p.publicKey, came++); arrivedAt.set(p.publicKey, Date.now()); }
    others.sort((a, b) => cameAt.get(b.publicKey)! - cameAt.get(a.publicKey)!);
    const self = withMe().find((p) => p.publicKey === me)!;
    return !active() ? [...others, self] : others;
  });
  /**
   * Who is in a room and not in a call, ready to join: listed at the top of the room on screen, above its call; me last,
   * unless I am in a call. A friend in a call elsewhere is shown in that call. In the order they came, the newest on top,
   * as in the list of other rooms. Not me while this tab holds no place there (another tab has it, or the Room refused it).
   */
  const hereIn = (l: Link): Person[] => {
    const holds = !['elsewhere', 'refused'].includes(l.room.status().kind);
    return online().filter((p) => (p.publicKey === me ? holds : l.room.people().some((q) => q.publicKey === p.publicKey)));
  };
  /** Everyone else online and not in a call, but in none of the room on screen's lists: they are in other rooms of mine. */
  const elsewhere = createMemo(() => {
    const here = current()?.room.people() ?? [];
    return online().filter((p) => p.publicKey !== me && !here.some((q) => q.publicKey === p.publicKey));
  });
  const elsewhereKeys = createMemo<string[]>(() => elsewhere().map((p) => p.publicKey), { equals: sameKeyList });
  let menuOpenings = 0;
  /**
   * The ⚙ menu opens above the gear, by its bottom edge, so it grows upward as a form in it opens (New room, Join by link).
   * Below it instead when there is more room there: on a phone the gear can be near the top of the screen.
   */
  const gearMenu = sidebarMenu({ width: MENU_W, prefer: 'above', onOpen: () => menuOpenings++ });
  /** The ⚙ menu is put away by what moves the sidebar under it (a new room, one joined or left): it would cover it. */
  const closeMenu = gearMenu.close;
  const viewOf = (l: Link, key: string): PeerView | undefined => l.call.views().find((v) => v.publicKey === key);
  const [panel, setPanel] = createSignal<'audio' | 'share' | null>(null);
  // Sharers, from the staged room's presence (tiles render from signaling state, never from track events).
  const sharers = createMemo(() => stage()?.room.people().filter((p) => p.role === 'participant' && p.sharing) ?? []);
  // Tiles are keyed by public key, not by Person object: every presence frame (a join, a leave, a mute, a rename)
  // replaces every Person, and a tile recreated for that would lose its video element and its fullscreen.
  // The rows of the list of other rooms are keyed the same way (`elsewhereKeys`), so a friend's row is made once, when they come online, and slides in then.
  const sharerKeys = createMemo<string[]>(() => sharers().map((p) => p.publicKey), { equals: sameKeyList });
  const sharerOf = (key: string): Person => sharers().find((p) => p.publicKey === key) ?? sharers()[0]!;
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const connected = () => current()?.room.status().kind === 'connected';
  // A text can be written while the socket is away and coming back (a first attempt that failed included): it waits,
  // shown as such, and goes out once the Room lets this browser in (quality ticket 10). Not during the first attempt, nor
  // while the room was refused or stepped back for another tab.
  const writable = () => { const k = current()?.room.status().kind; return k === 'connected' || k === 'reconnecting' || k === 'unavailable'; };
  // The room is on screen; friends arriving now let the phone's splash fade first. The first connection gets a moment
  // before the pill says so: your own row, dimmed until the room is connected, already tells.
  onSettled(() => { roomShownAt = performance.now(); });
  const [firstConnect, setFirstConnect] = createSignal(true);
  // Counted from when the rooms may connect: not while they wait for a new version found as the app opened (ticket 36).
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => holding(), (held) => { if (!held && !quietTimer) quietTimer = setTimeout(() => setFirstConnect(false), QUIET_CONNECT_MS); });
  onCleanup(() => clearTimeout(quietTimer));
  const bannerStatus = (l: Link): ServerStatus => (firstConnect() && l.room.status().kind === 'connecting' ? { kind: 'connected' } : l.room.status());
  // Bumped when I send or switch rooms: the log jumps to the newest line (the composer and the log are separate grid items).
  const [jumpToken, setJumpToken] = createSignal(0);
  // The same for a private conversation: its own, so the room's log behind it keeps its place.
  const [privateJump, setPrivateJump] = createSignal(0);
  // Files waiting above the composer for Send, from a paste, the attach button or a drop. Like the typed text, they go
  // with Send to the room on screen then. Each is made ready to send at once (a pasted picture's original fetched, the
  // file hashed), and Send waits for all of them: nothing slow is left for the room, which keeps them and the text in
  // the order handed over. A reload drops them.
  const [staged, setStaged] = createSignal<Staged[]>([]);
  let stagedIds = 0;
  /** The room's staged files, set aside while a private conversation is on screen (see the effect below). */
  let roomStaged: Staged[] = [];
  const stageFile = (file: File, original?: Promise<File | null>) => {
    const id = ++stagedIds;
    setStaged((all) => [...all, { id, file, url: thumbnailUrl(file), state: original ? 'original' : 'preparing', prepared: null }]);
    // Wherever it is by then: on screen, or set aside with the room's while a conversation is (`roomStaged`).
    const update = (change: (x: Staged) => Staged) => {
      setStaged((all) => all.map((x) => (x.id === id ? change(x) : x)));
      roomStaged = roomStaged.map((x) => (x.id === id ? change(x) : x));
    };
    void (async () => {
      const picked = (await original) ?? file;
      update((x) => {
        if (picked === file) return { ...x, state: 'preparing' };
        if (x.url) URL.revokeObjectURL(x.url);
        return { ...x, file: picked, url: thumbnailUrl(picked), state: 'preparing' };
      });
      try {
        const prepared = await prepareFile(picked);
        update((x) => ({ ...x, state: 'ready', prepared }));
      } catch {
        update((x) => ({ ...x, state: 'unreadable' })); // gone from the disk since it was picked, say
      }
    })();
  };
  // Like the composer's draft: the room's staged files wait while a conversation is on screen and come back after; files
  // staged in a conversation go as it leaves the screen, so a Send in the room cannot take them to everyone.
  createEffect(() => privates.openWith(), (key, prev) => {
    if (key === prev || (prev === undefined && key === null)) return;
    const now = untrack(staged);
    if (!prev && key) { roomStaged = now; setStaged([]); return; }
    for (const x of now) if (x.url) URL.revokeObjectURL(x.url);
    setStaged(key ? [] : roomStaged);
    if (!key) roomStaged = [];
  });
  const unstageFile = (id: number) => {
    const gone = staged().find((x) => x.id === id);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    setStaged((all) => all.filter((x) => x.id !== id));
  };
  // A file dropped anywhere on the page waits above the composer, as a picked one does: friends drop it on the text
  // field or the sidebar as often as on the log. It is never left to the browser, which would open it in place of the
  // app; it is staged only while something can be sent.
  const [dragging, setDragging] = createSignal(false);
  /** Enters minus leaves: a drag across the page enters and leaves every element, and Safari gives no relatedTarget to tell them apart. */
  let depth = 0;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  // A leave can go missing: an element taken away under the pointer (a friend's row as they go offline) gets its
  // dragleave while detached, and it never reaches the page. A drag over the page brings a dragover every 350 ms or
  // so, even standing still (the HTML spec; maybe not every engine), so none for 3 s means it has gone.
  let lapse: ReturnType<typeof setTimeout> | undefined;
  const endDrag = () => { clearTimeout(lapse); depth = 0; setDragging(false); };
  const overPage = () => { clearTimeout(lapse); lapse = setTimeout(endDrag, 3000); setDragging(privateFriend() ? !privateFriend()!.blocked : writable()); };
  onCleanup(() => clearTimeout(lapse));
  // Not over an open dialog or popover (Report a problem, a profile card) or a share in fullscreen: those sit above the
  // frame, so a file staged from there would be staged unseen, to go with the next Enter. The cursor says no instead.
  const onTop = (t: EventTarget | null) => t instanceof Element && !!(t.closest('dialog[open], [popover]') || document.fullscreenElement?.contains(t));
  // Another room put on screen (a click, an invite link) ends the conversation on screen; the room behind it going away
  // (left, forgotten) does not: another simply takes its place behind.
  createEffect(() => current(), (now, prev) => { if (prev && now !== prev && untrack(links).includes(prev)) privates.close(); });
  /** Unread private texts from friends online in none of my rooms: only the folded list of direct messages has a row for them. */
  let dms: HTMLDetailsElement | undefined;
  const unfoldDms = createMemo(() => { const k = privates.openWith(); return !!k && !present(k) && privates.threads().some((t) => t.friend.publicKey === k); });
  createEffect(unfoldDms, (unfold) => { if (unfold && dms?.isConnected) dms.open = true; });
  const awayUnread = createMemo(() => privates.threads().reduce((n, t) => n + (present(t.friend.publicKey) ? 0 : privates.unread(t.friend.publicKey)), 0));
  /** The private conversation on screen: the friend as presence has them now, else as I last saw them. */
  const privateFriend = createMemo(() => {
    const key = privates.openWith();
    if (!key) return null;
    const friend = present(key) ?? privates.threads().find((t) => t.friend.publicKey === key)?.friend;
    return friend ? { key, friend: identityOf(friend), blocked: privates.blocked(key) } : null;
  });
  // The files in the order shown, then the text, as a message with pictures reads: handed to the room together, which
  // sends them in that order. One that could not be read is dropped; its chip said so.
  /** Hands the composer's text and files to the room on screen; false when they stay in the composer. */
  const send = (text: string): boolean => {
    const room = current()?.room;
    const files = staged();
    if (!room || !files.every(settled)) return false;
    const priv = privateFriend();
    if (priv) {
      // Files first, then the text, as in a room; each goes to the friend alone. One a room would not take stays staged.
      const kept = files.filter((x) => x.prepared && !privates.sendFile(priv.key, x.prepared));
      for (const x of files) if (x.url && !kept.includes(x)) URL.revokeObjectURL(x.url);
      setStaged(kept);
      const sent = text ? privates.send(priv.key, text) : false;
      if (sent || kept.length < files.length) setPrivateJump((n) => n + 1);
      // True when the text went, so the field empties: the files no room took stay staged, and the conversation says why.
      return text ? sent : kept.length === 0;
    }
    setStaged([]);
    for (const x of files) if (x.url) URL.revokeObjectURL(x.url);
    for (const x of files) if (x.prepared) room.sendPrepared(x.prepared);
    if (text) room.sendText(text);
    setJumpToken((n) => n + 1);
    return true;
  };
  // When the room on screen came on screen: texts from well before then start out folded away (ticket 38). The same for
  // a private conversation.
  const openedAt = createMemo(() => (current(), Date.now()));
  const privateOpenedAt = createMemo(() => (privates.openWith(), Date.now()));
  // The room on screen has nothing unread, however many lines arrive while it is up.
  createEffect(() => ({ link: current(), lines: current()?.room.lines().length, away: privates.openWith() !== null }), ({ link, away }, prev) => {
    if (!away) link?.room.markRead();
    if (prev && prev.link !== link) setJumpToken((n) => n + 1);
  });
  /**
   * At most one call at a time: joining here leaves the call in every other room first, and a join there still waiting
   * for its answer, or a Rejoin waiting for its socket: either would put me in two calls (ticket 47).
   */
  const joinCall = (l: Link) => {
    for (const o of untrack(links)) if (o !== l) o.call.leave();
    void l.call.join();
  };
  const renameSelf = (n: string) => { for (const l of links()) l.room.rename(n); props.onRename(n); posthog.capture('name_changed'); };
  const pictureSelf = (pic: string | null) => { for (const l of links()) l.room.setPicture(pic); setPicture(pic); posthog.capture('picture_changed', { cleared: pic === null }); };
  // Sidebar footer forms: a new room, a room from a pasted link, and the invite link of the room on screen.
  const [creating, setCreating] = createSignal(false);
  const [joining, setJoining] = createSignal(false);
  // The room whose invite panel is open. A room started in this browser opens with it: sending the link is the next step.
  const [inviteFor, setInviteFor] = createSignal<string | null>(untrack(() => props.created));
  const toggleInvite = (l: Link) => setInviteFor(inviteFor() === l.saved.secret ? null : l.saved.secret);
  const [roomDraft, setRoomDraft] = createSignal('');
  const createRoomFromDraft = (e: Event) => {
    e.preventDefault();
    const n = normaliseRoomName(roomDraft());
    if (!n) return;
    const opening = menuOpenings;
    void props.onCreate(n).then((room) => {
      setCreating(false); setRoomDraft(''); setInviteFor(room.secret); // the new room needs its link sent around
      if (menuOpenings === opening) closeMenu(); // not a menu opened again since, for something else
    });
  };
  const leaveRoom = (l: Link) => {
    if (!confirm(`Leave ${l.saved.name}? This browser forgets the room and its chat history. The invite link gets you back in.`)) return;
    if (untrack(active) === l) l.call.leave(); // say goodbye while the socket is still open, so nobody waits out the grace period
    privates.strand(l.room); // my private texts waiting in it: through another room, else not sent
    closeMenu();
    props.onForget(l.saved.secret); // disposing the room closes its socket
  };

  return (
    <Show when={current()}>{(cur) => (
      <div class={`app ${sharers().length > 0 ? 'split' : ''} ${dragging() ? 'dropping' : ''}`}
           onDragEnter={(e) => { if (hasFiles(e)) { depth++; if (!onTop(e.target)) overPage(); } }}
           onDragOver={(e) => {
             if (!hasFiles(e)) return;
             e.preventDefault();
             // Over a dialog, or a conversation with a friend I cannot write to now: the cursor says no.
             if (!onTop(e.target) && !privateFriend()?.blocked) overPage();
             else { e.dataTransfer!.dropEffect = 'none'; clearTimeout(lapse); setDragging(false); }
           }}
           onDragLeave={(e) => { if (hasFiles(e) && --depth <= 0) endDrag(); }}
           onDrop={(e) => { endDrag(); if (!hasFiles(e)) return; e.preventDefault(); if ((privateFriend() ? !privateFriend()!.blocked : writable()) && !onTop(e.target)) for (const f of e.dataTransfer?.files ?? []) stageFile(f); }}>
        <div class="scroll">
          <aside class="side">
            {/* On a phone only: dave, and ⚙ at the top, where a thumb finds it; my own row is in the room there, so no row of me at the bottom */}
            <div class="side-top">
              <span class="brand">dave</span>
              <button class="gear" ref={gearMenu.anchor} popovertarget="side-menu" title="New room, join by link, theme, report a problem, and more" aria-label="Settings and more">⚙</button>
            </div>
            {/* Friends online in my other rooms, not in a call: the room on screen lists its own at its top */}
            <Show when={elsewhere().length > 0}>
              <h2>In other rooms</h2>
              <ul class="plist visitors elsewhere">
                <For each={elsewhereKeys()}>{(key) => {
                  // The latest entry; the last one seen while the row is on its way out.
                  let last = untrack(() => elsewhere().find((p) => p.publicKey === key)!);
                  const p = () => (last = elsewhere().find((q) => q.publicKey === key) ?? last);
                  return <PersonRow p={p()} isMe={false} label={labelOf(p())} arrive={justCame(key)} onProfile={(el) => openProfile(p(), el)} unread={privates.unread(key)} on={privates.openWith() === key} />;
                }}</For>
              </ul>
            </Show>
            <For each={links()}>{(l) => {
              const selected = () => l === cur();
              const inThis = () => l.call.inCall();
              // Call list: you first, then by join order. Participants whose server socket dropped stay listed, dimmed, for the grace period.
              // You are listed from this browser's call state, like in Online, so your row and the buttons change together.
              const participants = createMemo(() => {
                const all = l.room.people().filter((p) => p.role === 'participant');
                const self = inThis() ? all.find((p) => p.publicKey === me) ?? l.room.people().find((p) => p.publicKey === me) : undefined;
                const others = all.filter((p) => p.publicKey !== me).sort((a, b) => (a.joinSeq ?? 0) - (b.joinSeq ?? 0));
                const lost = l.call.views().filter((v) => v.serverLost && !all.some((p) => p.publicKey === v.publicKey));
                return { self, others, lost };
              });
              const elsewhere = () => { const a = active(); return a && a !== l ? a : null; };
              // Only the room on screen lists them: the others need not work them out on every presence frame.
              const here = createMemo(() => (selected() ? hereIn(l) : []));
              const hereKeys = createMemo<string[]>(() => here().map((p) => p.publicKey), { equals: sameKeyList });
              // Another room's call faces, keyed by friend too: a face made anew on each presence frame would lose focus and its tooltip.
              const faceKeys = createMemo<string[]>(() => participants().others.map((p) => p.publicKey), { equals: sameKeyList });
              const inviteOpen = () => inviteFor() === l.saved.secret;
              // The room's ⋯ menu: below its button, else above it when there is more room there.
              const menuId = `room-menu-${++roomMenus}`;
              const roomMenu = sidebarMenu({ width: ROOM_MENU_W, prefer: 'below' });
              return (
                <section class={`room ${selected() ? 'selected' : ''} ${selected() && privates.openWith() ? 'behind' : ''} ${l.room.status().kind === 'connected' ? '' : 'frozen'}`}>
                  <div class="room-head">
                    <button class="room-name" onClick={() => { privates.close(); props.onSelect(l.saved.secret); }} title={selected() && !privates.openWith() ? 'This room is on screen' : `Read ${l.saved.name}`}>
                      <span class="room-title">{l.saved.name}</span>
                      <Show when={l.room.unread() > 0}><b class="unread" title="new messages">{l.room.unread()}</b></Show>
                    </button>
                    <Show when={selected()}>
                      <button class="room-more" ref={roomMenu.anchor} popovertarget={menuId} title="Invite, clear chat history, leave" aria-label={`More for ${l.saved.name}`}>⋯</button>
                      <div class="room-menu" id={menuId} popover="auto" ref={roomMenu.menu} onBeforeToggle={roomMenu.beforeToggle} onToggle={roomMenu.toggle}>
                        <button class="link" title="The link that gets a friend into this room" onClick={() => { roomMenu.close(); toggleInvite(l); }}>{inviteOpen() ? 'Hide invite link' : 'Invite'}</button>
                        <button class="link" title="Only this browser's copy; nothing is stored on the server" onClick={() => { roomMenu.close(); if (confirm(`Clear this browser's chat history of ${l.saved.name}? Nothing is stored on the server, so this cannot be undone.`)) void l.room.clearHistory(); }}>Clear chat history</button>
                        <button class="link" title="Forget this room in this browser" onClick={() => { roomMenu.close(); leaveRoom(l); }}>Leave {l.saved.name}</button>
                      </div>
                    </Show>
                  </div>
                  <Show when={selected() && inviteOpen()}><InvitePanel link={inviteLinkFor(l.saved)} name={l.saved.name} onClose={() => setInviteFor(null)} /></Show>
                  {/* Who is here and not in the call, me too, ready to join: at the top of the room on screen */}
                  <Show when={selected() && hereKeys().length > 0}>
                    <ul class="plist visitors here">
                      {/* Keyed by friend, as the list of other rooms: a presence frame replaces every Person, and a row made anew slides in again */}
                      <For each={hereKeys()}>{(key) => {
                        let last = untrack(() => here().find((p) => p.publicKey === key)!);
                        const p = () => (last = here().find((q) => q.publicKey === key) ?? last);
                        return <PersonRow p={p()} isMe={key === me} label={labelOf(p())} arrive={key !== me && justCame(key)} onProfile={(el) => openProfile(p(), el)} unread={privates.unread(key)} on={privates.openWith() === key} />;
                      }}</For>
                    </ul>
                  </Show>
                  {/* The room on screen, or the one whose call I am in: its call in full, in a box of its own */}
                  <Show when={selected() || inThis()} fallback={
                    <Show when={participants().others.length > 0}>
                      {/* Any other room: only who is in its call, as faces */}
                      {/* Out of PostHog's recordings with its names (`ph-no-capture`); a face carries its friend's unread private texts */}
                      <div class="callfaces ph-no-capture" title={`In the call: ${participants().others.map((p) => labelOf(p).shown).join(', ')}`}>
                        <For each={faceKeys()}>{(key) => {
                          let last = untrack(() => participants().others.find((p) => p.publicKey === key)!);
                          const p = () => (last = participants().others.find((q) => q.publicKey === key) ?? last);
                          return (
                            <span class={privates.openWith() === key ? 'face on' : 'face'}>
                              <Avatar initial={labelOf(p()).shown[0]!} picture={labelOf(p()).picture} title={labelOf(p()).shown} onOpen={(el) => openProfile(p(), el)} />
                              <Show when={privates.unread(key) > 0}><b class="unread" title="New private messages">{privates.unread(key)}</b></Show>
                            </span>
                          );
                        }}</For>
                      </div>
                    </Show>
                  }>
                  <ul class={`plist ${participants().self || participants().others.length || participants().lost.length ? 'callbox' : ''}`}>
                    <Show when={participants().self}>{(s) => <ParticipantRow p={s()} isMe label={labelOf(s())} onProfile={(el) => openProfile(s(), el)} speaking={l.call.speakingSelf()} />}</Show>
                    <For each={participants().others}>{(p) => <ParticipantRow p={p} isMe={false} label={labelOf(p)} onProfile={(el) => openProfile(p, el)} unread={privates.unread(p.publicKey)} on={privates.openWith() === p.publicKey} view={inThis() ? viewOf(l, p.publicKey) : undefined} speaking={viewOf(l, p.publicKey)?.speaking ?? false} onVolume={inThis() ? (v) => l.call.setVolume(p.publicKey, v) : undefined} />}</For>
                    <For each={participants().lost}>{(v) => <li class="lost"><span class="avatar">{displayName(v.name, contactOf(v.publicKey))[0]}</span><span class="pname">{displayName(v.name, contactOf(v.publicKey))} <em>connection to server lost</em></span></li>}</For>
                    <Show when={selected() && !participants().self && participants().others.length === 0 && participants().lost.length === 0}><li class="dim">nobody in the call</li></Show>
                  </ul>
                  </Show>
                  <Show when={selected() || inThis()}>
                    <div class="actions">
                      <Show when={!inThis()} fallback={<CallControls call={l.call} panel={panel()} onPanel={setPanel} canShare={canShare} />}>
                        <button class="join" disabled={l.room.status().kind !== 'connected'} title={holding() ? 'A new version of dave is loading' : elsewhere() ? `Leaves the call in ${elsewhere()!.saved.name}` : undefined} onClick={() => joinCall(l)}>Join</button>
                      </Show>
                      <Show when={l.call.joinError()}>{(e) => <div class="warn">{e()}</div>}</Show>
                      <Show when={l.call.shareError()}>{(e) => <div class="warn">{e()}</div>}</Show>
                    </div>
                  </Show>
                </section>
              );
            }}</For>
            {/* Everyone I have a private conversation with, folded away: the way back to older texts, to a friend offline too.
                A friend online is also in a list above, with their unread count; here only an offline friend's count shows. */}
            <Show when={privates.threads().length > 0}>
              {/* Unfolded for the conversation on screen with a friend offline: their row there is the only one left in the sidebar */}
              <details class="dms ph-no-capture" ref={(el) => { dms = el; if (untrack(unfoldDms)) el.open = true; }}>
                <summary>Direct messages<Show when={awayUnread() > 0}><b class="unread" title="New private messages">{awayUnread()}</b></Show></summary>
                <ul class="away" aria-label="Direct messages">
                  <For each={privates.threads()}>{(t) => {
                    // The friend as presence has them now, else as I last saw them
                    const friend = () => present(t.friend.publicKey) ?? t.friend;
                    return (
                    <li class={present(t.friend.publicKey) ? '' : `offline ${privates.openWith() === t.friend.publicKey ? 'on' : ''}`}>
                      <Avatar initial={labelOf(friend()).shown[0]!} picture={labelOf(friend()).picture} title={`Your private conversation with ${labelOf(friend()).shown}`} onOpen={() => openPrivate(friend())} />
                      <span class="pname" title={labelOf(friend()).title}><span class="tname">{labelOf(friend()).shown}</span>
                        <Show when={!labelOf(friend()).known}><b class="new">new</b></Show>
                        <Show when={!present(t.friend.publicKey) && privates.unread(t.friend.publicKey) > 0}><b class="unread" title="New private messages">{privates.unread(t.friend.publicKey)}</b></Show>
                      </span>
                    </li>
                    );
                  }}</For>
                </ul>
              </details>
            </Show>
            {/* Me, and what is mine to do: my profile from my avatar, the rest behind ⚙ */}
            <div class="side-me">
              <Avatar initial={labelOf(localSelf()).shown[0]!} picture={labelOf(localSelf()).picture} title="Your profile" onOpen={(el) => openProfile(withMe().find((p) => p.publicKey === me)!, el)} />
              <span class={connected() ? 'nm' : 'nm pending'} title={connected() ? undefined : 'Connecting…'}>{labelOf(localSelf()).shown}</span>
              <button class="gear" ref={gearMenu.anchor} popovertarget="side-menu" title="New room, join by link, theme, report a problem, and more" aria-label="Settings and more">⚙</button>
            </div>
            <div class="side-foot" id="side-menu" popover="auto" ref={gearMenu.menu} onBeforeToggle={gearMenu.beforeToggle} onToggle={(e) => {
              gearMenu.toggle(e);
              const open = (e as ToggleEvent).newState === 'open';
              // Put away, a half-filled form goes with it: opened again for something else, it would take the focus (and a phone's keyboard).
              if (!open) { setCreating(false); setJoining(false); }
            }}>
              <Show when={creating()} fallback={<button class="link" onClick={() => setCreating(true)}>New room</button>}>
                <form class="newroom" onSubmit={createRoomFromDraft}>
                  <input value={roomDraft()} onInput={(e) => setRoomDraft(e.currentTarget.value)} maxlength={MAX_NAME_LENGTH} autofocus placeholder="Room name" aria-label="Name of the new room" />
                  <button class="on" disabled={normaliseRoomName(roomDraft()) === null}>Start</button>
                  <button type="button" onClick={() => setCreating(false)}>Cancel</button>
                </form>
              </Show>
              <Show when={joining()} fallback={<button class="link" title="Enter a room from a pasted invite link" onClick={() => setJoining(true)}>Join by link</button>}>
                <JoinLinkForm autofocus onJoin={(link) => { setJoining(false); closeMenu(); props.onJoin(link); }} onCancel={() => setJoining(false)} />
              </Show>
              <button class={`link ${askingConsent() ? 'on' : ''}`} title={telemetryOn() ? 'This browser sends usage events, errors and a masked screen recording to PostHog. Click to read what is sent, or to stop.' : 'Send usage events, errors and a masked screen recording to PostHog, so bugs can be found. Click to read what is sent.'} onClick={() => { setAskingConsent((a) => !a); closeMenu(); }}>{telemetryOn() ? 'Stop helping find bugs' : 'Help find bugs'}</button>
              <ReportDialog collect={() => collectReport({ status: () => cur().room.status().kind, people: everyone, me: () => me, call: (active() ?? cur()).call.diagnostics })} />
              <VersionDialog />
              <Show when={THEMES.length > 0}>
                <select class="theme-pick" aria-label="Theme" title="The look of dave in this browser" value={theme()} onChange={(e) => setTheme(e.currentTarget.value)}>
                  <option value="">Default look</option>
                  <For each={THEME_GROUPS}>{(g) => <optgroup label={g.label}><For each={g.themes}>{(t) => <option value={t.name}>{t.label}</option>}</For></optgroup>}</For>
                </select>
              </Show>
            </div>
          </aside>
          <ProfileCard open={profile()} people={withMe()} me={me} label={labelOf} onClose={() => setProfile(null)} onRenameSelf={renameSelf} onPictureSelf={pictureSelf} />
          <Banner status={bannerStatus(cur())} onTakeOver={() => { for (const l of links()) l.room.takeOver(); }} />
          <Show when={sharers().length > 0 && stage()}>{(s) => (
            <section class="shares" style={`grid-template-columns: repeat(${sharers().length}, 1fr)`}>
              <For each={sharerKeys()}>
                {(key) => (
                  <ShareTile
                    p={sharerOf(key)}
                    name={labelOf(sharerOf(key)).shown}
                    isMe={key === me}
                    inCall={s().call.inCall()}
                    view={viewOf(s(), key)}
                    stream={key === me ? s().call.sharing() ?? undefined : s().call.shareStreamOf(key)}
                    outgoing={key === me ? s().call.outgoing() : undefined}
                    onWatch={(on) => s().call.watch(key, on)}
                    onFullscreen={() => s().call.watchOnly(key)}
                    onVolume={s().call.inCall() ? (v) => s().call.setShareVolume(key, v) : undefined}
                    onBlack={(element) => void s().call.reportBlackShare(key, element)}
                  />
                )}
              </For>
            </section>
          )}</Show>
          {/* Kept while a conversation is on screen, hidden: back from it, the reader is where they were in the room */}
          <ChatLog lines={cur().room.lines()} openedAt={openedAt()} jumpToken={jumpToken()} label={labelOf} hidden={!!privateFriend()}
                   attachment={(hash) => cur().room.attachment(hash)} onPull={(hash) => cur().room.pull(hash)} onCancel={(hash) => cur().room.cancelPull(hash)} />
          <Show when={privateFriend()}>{(pf) => (
            <ChatLog lines={privates.lines(pf().key)} openedAt={privateOpenedAt()} jumpToken={privateJump()} label={labelOf} private
                     empty={privates.isRead(pf().key) ? `Only ${labelOf(pf().friend).shown} gets what you write here.` : undefined}
                     attachment={(hash) => privates.attachment(hash, pf().key)} onPull={(hash) => privates.pull(hash, pf().key)} onCancel={(hash) => privates.cancelPull(hash, pf().key)}
                     holder={(from) => (from.publicKey === me ? labelOf(pf().friend).shown : labelOf(from).shown)}
                     head={<PrivateHead friend={pf().friend} me={me} label={labelOf} where={privates.onlineIn(pf().key)} blocked={pf().blocked}
                                        back={cur().saved.name} onBack={() => privates.close()} onForget={() => privates.forget(pf().key)} />} />
          )}</Show>
        </div>
        {/* In a private conversation it goes by the room that would carry the text, not the one on screen */}
        <Composer connected={privateFriend() ? privates.connected(privateFriend()!.key) : connected()} writable={privateFriend() ? true : writable()} roomName={cur().saved.name} onSend={send}
                  privateTo={privateFriend() ? { key: privateFriend()!.key, name: labelOf(privateFriend()!.friend).shown, blocked: privateFriend()!.blocked } : null}
                  staged={staged()} onStage={stageFile} onUnstage={unstageFile}>
          {/* Anchored to the composer's top edge, whatever its height on this device (ticket 32) */}
          <Show when={consent() === null || askingConsent()}><TelemetryNotice onAnswer={(c) => { setConsent(c); setAskingConsent(false); }} /></Show>
        </Composer>
        <Show when={dragging()}><div class="drop-hint">Drop to send to {privateFriend() ? labelOf(privateFriend()!.friend).shown : cur().saved.name}</div></Show>
      </div>
    )}</Show>
  );
}

/** The controls while in a call: mute and audio settings, share and share settings, leave. */
function CallControls(props: { call: Call; panel: 'audio' | 'share' | null; onPanel: (p: 'audio' | 'share' | null) => void; canShare: boolean }) {
  const toggle = (p: 'audio' | 'share') => props.onPanel(props.panel === p ? null : p);
  return (
    <>
      <Show when={props.call.audioBlocked()}>
        <button class="unblock" title="The browser held back the call's sound until you click" onClick={props.call.unblockAudio}>Click to hear the call</button>
      </Show>
      <div class="row">
        <button class={props.call.muted() ? 'on' : ''} onClick={() => void props.call.setMuted(!props.call.muted())}>{props.call.muted() ? 'Unmute' : 'Mute'}</button>
        <button class={`gear ${props.panel === 'audio' ? 'on' : ''}`} title="Audio settings" onClick={() => { toggle('audio'); void props.call.refreshDevices(); }}>⚙</button>
      </div>
      <Show when={props.call.micProblem()}>{(p) => <div class="hint">{p()} You can listen; Unmute asks for the microphone again.</div>}</Show>
      <Show when={props.panel === 'audio'}><AudioPanel call={props.call} /></Show>
      <Show when={props.canShare} fallback={<div class="hint">Screen sharing is not available on this device</div>}>
        <div class="row">
          <button class={props.call.sharing() ? 'on' : ''} onClick={() => void (props.call.sharing() ? props.call.stopShare() : props.call.startShare())}>{props.call.sharing() ? 'Stop sharing' : 'Share screen'}</button>
          <button class={`gear ${props.panel === 'share' ? 'on' : ''}`} title="Share settings" onClick={() => toggle('share')}>⚙</button>
        </div>
      </Show>
      <Show when={props.panel === 'share'}><SharePanel call={props.call} /></Show>
      <button class="leave" onClick={props.call.leave}>Leave</button>
    </>
  );
}

/**
 * The invite link of a room, ready to copy, and as a QR code for a phone in the same room to scan. The link
 * is the whole secret: whoever has it is in, so the code is as private as the screen it is on.
 */
function InvitePanel(props: { link: string; name: string; onClose: () => void }) {
  let input: HTMLInputElement | undefined;
  const [state, setState] = createSignal<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try { await navigator.clipboard.writeText(props.link); setState('copied'); posthog.capture('invite_link_copied'); } catch { input?.select(); setState('failed'); }
  };
  const qr = createMemo(() => encodeQr(props.link));
  return (
    <div class="panel invite">
      <p class="hint">Anyone with this link can enter {props.name}. Send it to friends only.</p>
      <Show when={qr()}>{(code) => (
        <svg class="qr" viewBox={`0 0 ${code().size + 8} ${code().size + 8}`} shape-rendering="crispEdges" role="img" aria-label={`QR code of the invite link to ${props.name}`}>
          <path d={qrPath(code())} />
        </svg>
      )}</Show>
      <input ref={input} readonly value={props.link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
      <button class="on" onClick={() => void copy()}>{state() === 'copied' ? 'Copied' : 'Copy link'}</button>
      <button onClick={() => props.onClose()}>Done</button>
      <Show when={state() === 'failed'}><div class="warn">Could not access the clipboard. The link is selected above: copy it yourself.</div></Show>
    </div>
  );
}

/** How a friend is shown here, computed by the Workspace from the address book and who else is around. */
type Label = { shown: string; known: boolean; title: string; picture?: string };

/** The avatar is the way into a friend's profile card. It shows the profile picture (issue #8), else the initial. */
function Avatar(props: { initial: string; picture?: string; speaking?: boolean; title: string; onOpen: (anchor: HTMLElement) => void }) {
  // Out of PostHog's autocapture (`ph-no-capture`): a friend's avatar opens my private conversation with them, and whom
  // I write to privately is mine.
  return <button class={`avatar ph-no-capture ${props.picture ? 'pic' : ''} ${props.speaking ? 'speaking' : ''}`} title={props.title} onClick={(e) => { e.stopPropagation(); props.onOpen(e.currentTarget); }}>{props.picture ?? props.initial}</button>;
}

/**
 * A menu of the sidebar's: a popover hanging from its button, on the side of it with more room (`prefer` on a tie), right
 * edges aligned, never past the window. Placed before it shows, so it never paints elsewhere first. Open, it follows its
 * button: a turned phone, the column scrolled, a row added above it (a friend comes online), a theme picked and its fonts
 * arriving. Placing only sets the menu's own style, which none of these watch, so it cannot loop; once a frame at most.
 */
function sidebarMenu(opts: { width: number; prefer: 'above' | 'below'; onOpen?: () => void }) {
  let menu: HTMLDivElement | undefined;
  // Its buttons: the one on screen is the one it hangs from (the ⚙ has one for a phone and one for a desktop).
  let anchors: HTMLElement[] = [];
  const shownAnchor = () => { anchors = anchors.filter((a) => a.isConnected); return anchors.find((a) => a.getClientRects().length > 0); }; // a button gone from the page is let go
  let changed: MutationObserver | undefined;
  let placing = 0;
  const isOpen = () => !!menu?.isConnected && menu.matches(':popover-open');
  const place = () => {
    const anchor = shownAnchor();
    if (!menu || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const width = Math.min(opts.width, innerWidth - 16);
    const above = a.top - 16;
    const below = innerHeight - a.bottom - 16;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(a.right - width, innerWidth - width - 8))}px`;
    if (opts.prefer === 'above' ? above >= below : above > below) {
      menu.style.top = 'auto';
      menu.style.bottom = `${Math.max(8, innerHeight - a.top + 8)}px`;
      menu.style.maxHeight = `${Math.max(0, Math.min(above, innerHeight - 16))}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${Math.max(8, a.bottom + 8)}px`;
      menu.style.maxHeight = `${Math.max(0, Math.min(below, innerHeight - 16))}px`;
    }
  };
  const follow = () => {
    // Gone from the page without a toggle (its room no longer on screen): nothing left to follow.
    if (!isOpen()) { watch(false); return; }
    if (!placing) placing = requestAnimationFrame(() => { placing = 0; place(); });
  };
  const watch = (open: boolean) => {
    changed?.disconnect();
    removeEventListener('resize', follow);
    removeEventListener('scroll', follow, true);
    document.fonts.removeEventListener('loadingdone', follow);
    if (!open) return;
    opts.onOpen?.();
    addEventListener('resize', follow);
    addEventListener('scroll', follow, true);
    document.fonts.addEventListener('loadingdone', follow);
    changed = new MutationObserver(follow);
    const side = shownAnchor()?.closest('.side');
    if (side) changed.observe(side, { childList: true, subtree: true, characterData: true });
    changed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  };
  onCleanup(() => { watch(false); cancelAnimationFrame(placing); });
  return {
    menu: (el: HTMLDivElement) => { menu = el; },
    anchor: (el: HTMLElement) => { if (!anchors.includes(el)) anchors.push(el); }, // refs run before the page has them: not filtered here
    close: () => { if (isOpen()) menu!.hidePopover(); },
    beforeToggle: (e: Event) => { if ((e as ToggleEvent).newState === 'open') place(); },
    toggle: (e: Event) => watch((e as ToggleEvent).newState === 'open'),
  };
}

/** A friend's row slides in this soon after they came online (or out of a call); later, a row is only moving lists. */
const ARRIVE_MS = 1500;
/** The ⚙ menu's width, at most (the window's, less a margin, on a phone). */
const MENU_W = 260;
/** A room's ⋯ menu's width, at most. */
const ROOM_MENU_W = 200;
/** Numbers the rooms' ⋯ menus, for the ids their buttons point at (a room's secret is not for the page's markup). */
let roomMenus = 0;
/** Whether two lists of keys are the same, in the same order: rows keyed by friend are not made anew for an equal list. */
const sameKeyList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);
/** How long the first connection may take before the room shows the "Connecting…" pill. */
const QUIET_CONNECT_MS = 2500;
/** Friends arriving as the room comes on screen wait this long, so they slide in after the phone's splash has faded. */
const SETTLE_MS = 400;
let roomShownAt = 0;
/** Rows arriving together follow each other this far apart; from the fifth on they come with the fourth. */
const STAGGER_MS = 160;
const MAX_STAGGER = 3;

/**
 * A row arriving in a list slides down into place, pushing the rows below it down, as if from above. Rows arriving
 * together come one after the other from the bottom up, so each lands on top of the one before; none comes before the
 * room has been on screen a moment.
 */
let arriving: HTMLElement[] = [];
function slideIn(el: HTMLElement): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  arriving.push(el);
  if (arriving.length > 1) return;
  // Measured once laid out. A hidden tab gets no frame until it is shown, and rows may come and go meanwhile: only
  // those still on screen open, the lowest first.
  requestAnimationFrame(() => {
    const rows = arriving.filter((r) => r.isConnected).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1));
    arriving = [];
    const wait = Math.max(0, roomShownAt + SETTLE_MS - performance.now());
    rows.forEach((row, i) => open(row, wait + Math.min(i, MAX_STAGGER) * STAGGER_MS));
  });
}

/** The row opens, and what is in it comes down from behind the row above: it never covers the list's heading. */
function open(el: HTMLElement, delay: number): void {
  const list = el.parentElement;
  if (!list) return;
  const height = el.offsetHeight;
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0; // taken back by the margin, so nothing moves before the slide
  const timing: KeyframeAnimationOptions = { duration: 460, delay, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'backwards' };
  el.style.overflow = 'hidden';
  const opening = el.animate([{ height: '0px', marginTop: `${-gap}px` }, { height: `${height}px`, marginTop: '0px' }], timing);
  for (const child of el.children) child.animate([{ transform: `translateY(${-height}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], timing);
  opening.finished.then(() => { el.style.overflow = ''; }, () => {});
}

/** `unread`: private texts from this friend I have not read; `on`: my conversation with them is on screen (ADR 0007). */
function PersonRow(props: { p: Person; isMe: boolean; label: Label; onProfile: (anchor: HTMLElement) => void; pending?: boolean; arrive?: boolean; unread?: number; on?: boolean }) {
  const acknowledge = () => { if (!props.label.known) { markKnown(props.p.publicKey, props.p.name); posthog.capture('new_key_acknowledged'); } };
  return (
    <li ref={(el) => { if (untrack(() => props.arrive)) slideIn(el); }} class={[props.pending ? 'pending' : '', props.on ? 'on' : ''].join(' ').trim() || undefined} onClick={acknowledge} title={props.label.known ? props.label.title : `${props.label.title}. Click to acknowledge.`}>
      <Avatar initial={props.label.shown[0]!} picture={props.label.picture} title={props.isMe ? 'Your profile' : `Your private conversation with ${props.label.shown}`} onOpen={props.onProfile} />
      <span class="pname"><span class="nm">{props.label.shown}{props.isMe ? ' (you)' : ''}</span>
        <Show when={!props.label.known}><b class="new">new</b></Show>
        <Show when={props.unread}><b class="unread" title="New private messages">{props.unread}</b></Show>
      </span>
    </li>
  );
}

/**
 * The profile card (issues #6, #7, #8): a popover hanging from my own avatar, with my name, my fingerprint, and the edits
 * that are mine to make: the name everyone sees, and the profile picture from the emoji picker, which opens from my big
 * avatar. A friend's profile is the head of my private conversation with them (`PrivateHead`), not a card.
 */
function ProfileCard(props: { open: { publicKey: string; anchor: HTMLElement } | null; people: Person[]; me: string; label: (id: Identity) => Label; onClose: () => void; onRenameSelf: (name: string) => void; onPictureSelf: (picture: string | null) => void }) {
  let card: HTMLDivElement | undefined;
  const person = createMemo(() => (props.open ? props.people.find((p) => p.publicKey === props.open!.publicKey) ?? null : null));
  const isOpen = () => card?.matches(':popover-open') ?? false;
  createEffect(() => props.open, (o) => {
    if (!card) return;
    if (!o) { if (isOpen()) card.hidePopover(); return; }
    if (!isOpen()) card.showPopover();
    place(card, o.anchor);
  });
  // Placed again when it changes size (✎ makes it taller): from my avatar at the bottom of the sidebar it would grow past the
  // window. Placing moves it and does not resize it, so this cannot loop.
  const resized = new ResizeObserver(() => { if (card && props.open?.anchor.isConnected && isOpen()) place(card, props.open.anchor); });
  onCleanup(() => resized.disconnect());
  // Gone from presence (the socket rebuilt it without me): nothing to show.
  createEffect(() => props.open !== null && person() === null, (gone) => { if (gone) props.onClose(); });
  // Light dismiss (click outside, Escape) closes the popover; the state follows. Clicking another avatar
  // dismisses and reopens in the same task, so only report a close that stuck.
  const onToggle = (e: Event) => { if ((e as ToggleEvent).newState === 'closed' && !isOpen()) props.onClose(); };
  return (
    <div class="profile" popover="auto" ref={(el) => { card = el; resized.observe(el); }} onToggle={onToggle}>
      {/* Keyed by the opening: each one starts out not editing */}
      <Show when={props.open} keyed>{(_opened) => (
        <Show when={person()}>{(p) => <Profile person={p()} me={props.me} label={props.label} onRenameSelf={props.onRenameSelf} onPictureSelf={props.onPictureSelf} />}</Show>
      )}</Show>
    </div>
  );
}

/**
 * Who someone is, and the edits that fit: a friend gets a nickname only this browser shows; I change the name everyone
 * sees and pick my profile picture. Follows presence live, so a friend renaming themselves shows up.
 */
function Profile(props: { person: Identity; me: string; label: (id: Identity) => Label; onRenameSelf: (name: string) => void; onPictureSelf: (picture: string | null) => void }) {
  let input: HTMLInputElement | undefined;
  let ownAvatar: HTMLButtonElement | undefined;
  const isMe = () => props.person.publicKey === props.me;
  const contact = () => contactOf(props.person.publicKey);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const startEdit = () => {
    const p = untrack(() => props.person);
    setDraft(untrack(() => (p.publicKey === props.me ? p.name : contactOf(p.publicKey)?.nick ?? '')));
    setEditing(true);
    queueMicrotask(() => input?.select());
  };
  const save = (e: Event) => {
    e.preventDefault();
    const p = untrack(() => props.person);
    if (p.publicKey === props.me) {
      const name = normaliseName(draft());
      if (!name) return;
      if (name !== p.name) props.onRenameSelf(name);
    } else {
      setNickname(p.publicKey, p.name, draft());
      posthog.capture('friend_renamed', { cleared: draft().trim() === '' });
    }
    setEditing(false);
  };
  const useOwnName = () => {
    const p = untrack(() => props.person);
    setNickname(p.publicKey, p.name, null);
    posthog.capture('friend_renamed', { cleared: true });
    setEditing(false);
  };
  const editTitle = () => (isMe() ? 'Change your name' : contact()?.nick ? 'Change nickname' : 'Give a nickname');
  const picture = () => props.label(props.person).picture;
  const BigAvatar = () => <span class={`avatar big ${picture() ? 'pic' : ''}`}>{picture() ?? props.label(props.person).shown[0]}</span>;
  return (
    <>
      <Show when={editing()} fallback={
        <div class="profile-head">
          <Show when={isMe()} fallback={<BigAvatar />}>
            <button class={`avatar big own ${picture() ? 'pic' : ''}`} ref={ownAvatar} popovertarget="profile-emoji" title="Choose a profile picture" aria-label="Choose a profile picture">{picture() ?? props.label(props.person).shown[0]}</button>
            <EmojiPicker id="profile-emoji" anchor={() => ownAvatar} onPick={(c) => props.onPictureSelf(c)} closeOnPick />
          </Show>
          <div class="profile-names">
            <span class="profile-name">
              <strong>{props.label(props.person).shown}{isMe() ? ' (you)' : ''}</strong>
              <button class="edit" title={editTitle()} aria-label={editTitle()} onClick={startEdit}>✎</button>
            </span>
            <Show when={!isMe() && contact()?.nick}><span class="dim">calls themselves {props.person.name}</span></Show>
            <Show when={isMe()}><span class="dim">what friends see, unless they gave you a nickname</span></Show>
            <Show when={isMe()}>
              <span class="dim">
                <Show when={picture()} fallback="click the circle to pick an emoji picture">
                  <button class="link" type="button" onClick={() => props.onPictureSelf(null)}>remove the picture</button>
                </Show>
              </span>
            </Show>
          </div>
        </div>
      }>
        <form class="profile-edit" onSubmit={save}>
          <div class="profile-head">
            <BigAvatar />
            <input ref={input} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={MAX_NAME_LENGTH} placeholder={isMe() ? 'Your name' : props.person.name} aria-label={editTitle()} />
          </div>
          <p class="hint">{isMe() ? 'Everyone in the room sees this name, unless they gave you a nickname of their own.' : `Only this browser shows the name you pick. ${props.person.name} keeps their own name everywhere else.`}</p>
          <div class="row">
            <button class="on" disabled={isMe() && normaliseName(draft()) === null}>Save</button>
            <Show when={!isMe() && contact()?.nick}><button type="button" onClick={useOwnName}>Use their own name</button></Show>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      </Show>
      <dl class="profile-facts">
        <dt>Fingerprint</dt><dd><code>{props.person.fingerprint}</code></dd>
        <Show when={!isMe()} fallback={<><dt>Identity</dt><dd>this browser's key</dd></>}>
          <dt>Known since</dt><dd title={contact() ? new Date(contact()!.since).toLocaleString() : undefined}>{knownAgo(contact()) ?? 'now'}</dd>
        </Show>
      </dl>
    </>
  );
}

/**
 * The head of a private conversation (ADR 0007), above its log: who it is with, as their profile shows them, and where
 * they are now, the rooms we share, or why I cannot write to them. The friend's own profile, at the top of the page,
 * is what tells a conversation from a room at a glance.
 */
function PrivateHead(props: { friend: Identity; me: string; label: (id: Identity) => Label; where: string[]; blocked: string | null; back: string; onBack: () => void; onForget: () => void }) {
  return (
    <header class="private-head ph-no-capture">
      <button type="button" class="link private-back" onClick={props.onBack} title={`Back to ${props.back}`}>← {props.back}</button>
      <div class="private-who">
        {/* Keyed by the friend: another conversation starts out not editing, so a nickname typed for one is never saved on another */}
        <Show when={props.friend.publicKey} keyed>{(_key) => <Profile person={props.friend} me={props.me} label={props.label} onRenameSelf={() => {}} onPictureSelf={() => {}} />}</Show>
      </div>
      <p class="private-where">
        <span class={props.where.length && !props.blocked ? 'here on' : 'here'}>
          {props.blocked ? `Can't write now: ${props.blocked}` : props.where.length ? `In ${props.where.join(', ')}` : 'Your rooms with them are reconnecting'}
        </span>
        <button type="button" class="link" title="Only this browser's copy: nothing is stored on the server" onClick={() => { if (confirm(`Delete your private conversation with ${props.label(props.friend).shown} from this browser? Nothing is stored on the server, so this cannot be undone.`)) props.onForget(); }}>Delete conversation</button>
      </p>
    </header>
  );
}

type Call = ReturnType<typeof createCall>;

function SharePanel(props: { call: Call }) {
  const s = () => props.call.shareSettings();
  const mbps = (bps: number) => (bps / 1_000_000).toFixed(1);
  return (
    <div class="panel">
      <label>Frame rate <select class="picker" value={String(s().frameRate)} onChange={(e) => props.call.changeShare({ frameRate: Number(e.currentTarget.value) as FrameRate })}>
        <option value="15">15 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></label>
      <label>Resolution <select class="picker" value={String(s().maxHeight)} onChange={(e) => props.call.changeShare({ maxHeight: Number(e.currentTarget.value) as MaxHeight })}>
        <option value="0">native</option><option value="1080">up to 1080p</option><option value="720">up to 720p</option></select></label>
      <label>Under pressure keep <select class="picker" value={s().degradation} onChange={(e) => props.call.changeShare({ degradation: e.currentTarget.value as Degradation })}>
        <option value="maintain-resolution">resolution</option><option value="maintain-framerate">frame rate</option><option value="balanced">a balance</option></select></label>
      <label>Upload budget <input type="number" min="1" max="50" step="0.5" value={mbps(s().budgetBps)} onChange={(e) => props.call.changeShare({ budgetBps: mbpsToBps(e.currentTarget.value, s().budgetBps, 1, 50) })} /> Mbps total</label>
      <label>Per viewer up to <input type="number" min="0.5" max="20" step="0.5" value={mbps(s().ceilingBps)} onChange={(e) => props.call.changeShare({ ceilingBps: mbpsToBps(e.currentTarget.value, s().ceilingBps, 0.5, 20) })} /> Mbps</label>
    </div>
  );
}

// Audio and listening settings. Lives under Mute so it is reachable on phones too, where screen sharing (and its gear) is absent.
function AudioPanel(props: { call: Call }) {
  const a = () => props.call.audioSettings();
  const set = (change: Partial<AudioSettings>) => void props.call.changeAudio(change);
  const label = (d: MediaDeviceInfo, i: number) => d.label || `${d.kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${i + 1}`;
  const masterPercent = () => Math.round(a().masterVolume * 100);
  /** Noise removal is on and has not given up in this browser: the gate shows, the browser's suppression steps aside. */
  const removing = () => a().noiseRemoval && props.call.noiseRemoval() !== 'unavailable';
  return (
    <div class="panel">
      <label>Microphone <select class="picker" value={a().microphoneId} onChange={(e) => set({ microphoneId: e.currentTarget.value })}>
        <option value="">Default</option><For each={props.call.devices().microphones}>{(d, i) => <option value={d.deviceId}>{label(d, i())}</option>}</For></select></label>
      <Show when={props.call.canPickSpeaker}>
        <label>Speaker
          <Show when={props.call.devices().speakers.length > 0 || !props.call.canPickSpeakerDialog} fallback={<span class="dim">{a().speakerId ? 'chosen' : 'Default'}</span>}>
            <select class="picker" value={a().speakerId} onChange={(e) => set({ speakerId: e.currentTarget.value })}>
              <option value="">Default</option><For each={props.call.devices().speakers}>{(d, i) => <option value={d.deviceId}>{label(d, i())}</option>}</For></select>
          </Show>
        </label>
        <Show when={props.call.canPickSpeakerDialog}>
          <button onClick={() => void props.call.pickSpeaker()}>Choose speaker…</button>
        </Show>
      </Show>
      <Show when={!props.call.canPickSpeaker}><div class="hint">This browser cannot choose an output device; it uses the system default.</div></Show>
      <label class="mvol" title="How loud everyone is for you, on top of each friend's own volume. Double-click to reset.">Volume
        <input type="range" min="0" max={MAX_VOLUME * 100} step="5" value={masterPercent()} onInput={(e) => set({ masterVolume: Number(e.currentTarget.value) / 100 })} onDblClick={() => set({ masterVolume: 1 })} />
        <span class="dim">{masterPercent()}%</span>
      </label>
      <MicTest call={props.call} />
      <div class={processingIsDefault(a()) ? 'hint' : 'warn'}>
        {processingIsDefault(a()) ? 'Turning these off usually makes you sound worse to others.' : 'Audio processing is off. Turn everything back on if friends complain.'}
      </div>
      <label class="check" title="Takes keyboard clicks, fans and other noise out of your voice, and lets it through only while you speak.">
        <input type="checkbox" checked={a().noiseRemoval} onChange={(e) => set({ noiseRemoval: e.currentTarget.checked })} /> Noise removal
      </label>
      <Show when={removing()}>
        <div class="vgate" title="Your voice goes out while the bar passes the mark. Drag the mark left if your first words get cut off, right if noise still gets through; all the way left lets everything through. Double-click to reset.">
          <span>Voice gate</span>
          <span class="vtrack">
            <span class="vmeter"><span class={`fill ${props.call.voiceLevel().open ? 'open' : ''}`} style={{ width: `${props.call.voiceLevel().voice * 100}%` }} /></span>
            <input type="range" aria-label="Voice gate" min="0" max="100" step="5" value={Math.round(a().voiceThreshold * 100)}
              onInput={(e) => set({ voiceThreshold: Math.min(MAX_VOICE_THRESHOLD, Number(e.currentTarget.value) / 100) })} onDblClick={() => set({ voiceThreshold: DEFAULT_VOICE_THRESHOLD })} />
          </span>
        </div>
      </Show>
      <Show when={a().noiseRemoval && props.call.noiseRemoval() === 'unavailable'}>
        <div class="hint">
          <Switch fallback="Noise removal cannot run in this browser, so the browser's own noise suppression is used.">
            <Match when={props.call.noiseRemovalStop() === 'drift'}>Noise removal stopped: with it your voice went out too fast or too slow on this device, which friends hear as a weird voice. The browser's own noise suppression is used instead.</Match>
            <Match when={props.call.noiseRemovalStop() === 'overload'}>Noise removal stopped: this device could not keep up with it, which friends hear as a choppy voice. The browser's own noise suppression is used instead.</Match>
          </Switch>
        </div>
      </Show>
      <label class="check"><input type="checkbox" checked={a().echoCancellation} onChange={(e) => set({ echoCancellation: e.currentTarget.checked })} /> Echo cancellation</label>
      <label class="check" title={removing() ? 'Noise removal takes its place while it is on.' : undefined}>
        <input type="checkbox" checked={a().noiseSuppression} disabled={removing()} onChange={(e) => set({ noiseSuppression: e.currentTarget.checked })} /> Noise suppression
      </label>
      <label class="check"><input type="checkbox" checked={a().autoGainControl} onChange={(e) => set({ autoGainControl: e.currentTarget.checked })} /> Automatic gain</label>
      <label class="check" title="For a slow or overloaded internet connection: your voice, and every voice sent to you, travels with about a third of the data, so it stops arriving seconds late, and friends' voices wait a moment longer before they play, which smooths out an uneven line. Voices sound a little duller. Switched on by the friend with the slow line, it helps all their connections; switched on by you, the one between you.">
        <input type="checkbox" checked={a().lowBandwidthVoice} onChange={(e) => set({ lowBandwidthVoice: e.currentTarget.checked })} /> Low bandwidth voice
      </label>
      <div class="vrepair" role="radiogroup" aria-label="Voice repair" title="How lost bits of voice are made up for. Opus FEC, the usual: a rough copy of each packet rides in the next one, at little extra data. RED: a full copy of the previous packet in every packet, about double the voice data, for a line that drops many. Chosen by either side, it holds both ways between the two; off on either side switches both off.">
        <span>Voice repair</span>
        <For each={VOICE_REPAIRS}>{(mode) => (
          <label class="check"><input type="radio" name="vrepair" value={mode} checked={a().voiceRepair === mode} onChange={() => set({ voiceRepair: mode })} /> {VOICE_REPAIR_LABEL[mode]}</label>
        )}</For>
      </div>
      <label class="check"><input type="checkbox" checked={props.call.viewerSettings().jitterBufferTargetMs > 0} onChange={(e) => props.call.setViewerSettings({ jitterBufferTargetMs: e.currentTarget.checked ? LOW_LATENCY_MS : 0 })} /> Low latency when watching shares</label>
    </div>
  );
}

/**
 * The mic test (ticket 40): hear yourself live, or record 5 s and hear them back, as friends would get your voice, while
 * the settings below change. Friends meanwhile get silence and you hear none of them; closing the panel ends it.
 */
function MicTest(props: { call: Call }) {
  const t = () => props.call.micTest();
  const toggle = (phase: MicTestPhase, start: () => void) => (t() === phase ? props.call.stopMicTest() : start());
  onCleanup(() => props.call.stopMicTest('panel'));
  return (
    <>
      <div class="mictest">
        <span>Mic test</span>
        <button class={t() === 'live' ? 'on' : ''} disabled={props.call.micProblem() !== null} onClick={() => toggle('live', props.call.hearYourself)}
          title="Hear your voice as friends get it while you change the settings below. Use headphones: through speakers it comes back as an echo or a howl.">Hear yourself</button>
        <Show when={props.call.canRecordMicTest}>
          <button class={t() === 'recording' ? 'recording' : ''} style={{ '--record-ms': `${MIC_TEST_RECORD_MS}ms` }} disabled={props.call.micProblem() !== null} onClick={() => toggle('recording', props.call.recordMicTest)}
            title="Records 5 seconds of your voice as friends get it, then plays them back. Works through speakers too.">{t() === 'recording' ? 'Recording…' : 'Record 5 s'}</button>
          <Show when={props.call.hasMicTestClip()}>
            <button class={t() === 'playing' ? 'on' : ''} onClick={() => toggle('playing', props.call.playMicTest)} title="Plays the last recording again">Play</button>
          </Show>
        </Show>
      </div>
      <Show when={t()}>{(phase) => (
        <div class="warn">
          {MIC_TEST_NOTE[phase()]} Friends can't hear you and you hear none of them until the test ends.
        </div>
      )}</Show>
    </>
  );
}
type MicTestPhase = NonNullable<ReturnType<Call['micTest']>>;
const MIC_TEST_NOTE: Record<MicTestPhase, string> = {
  live: 'You hear yourself as friends would, but with echo cancellation off: here it would only cut into your own voice. Use headphones, or your voice comes back as an echo.',
  recording: 'Recording: say something.',
  playing: 'Playing back what friends would have heard.',
};

const VOICE_REPAIR_LABEL: Record<VoiceRepair, string> ={ off: 'Off', fec: 'Opus FEC', red: 'RED' };

const CONN_LABEL: Record<ConnState, string> = { connecting: 'connecting…', direct: 'direct', relayed: 'via relay', reconnecting: 'reconnecting…', unreachable: 'unreachable' };

/** The round trip to one friend (ticket 27): quiet while it is small, a warning once a call gets hard to follow. */
function Lag(props: { ms: number }) {
  const level = () => lagLevel(props.ms);
  const title = () => `Round trip: ${formatDelay(props.ms)}. You hear them about half of that late.`
    + (level() === 'ok' ? '' : ' A line this slow usually queues up at one end; Low bandwidth voice in the audio settings may help, on either side.');
  return <span class={`lag lag-${level()}`} title={title()}>{formatDelay(props.ms)}</span>;
}

const NAME_FLOOR_CH = 8;
let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Whether a participant line holds every badge at full width beside a name of at least NAME_FLOOR_CH characters.
 *  Measured from the badges' natural widths, so the answer does not depend on whether the line is tight right now. */
function badgesFitWhole(line: HTMLElement): boolean {
  const [avatar, name, flags] = [...line.children] as HTMLElement[];
  if (!avatar || !name || !flags) return true;
  const gap = (el: HTMLElement) => parseFloat(getComputedStyle(el).columnGap) || 0;
  let need = 0;
  for (const badge of flags.children as HTMLCollectionOf<HTMLElement>) {
    const label = badge.querySelector<HTMLElement>('.conn-label');
    const dot = badge.querySelector<HTMLElement>('i');
    need += label && dot ? dot.offsetWidth + gap(badge) + label.offsetWidth : badge.scrollWidth + badge.offsetWidth - badge.clientWidth;
  }
  need += gap(flags) * Math.max(0, flags.children.length - 1);
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (measureCtx) measureCtx.font = getComputedStyle(name).font;
  const floor = (measureCtx?.measureText('0').width ?? 8) * NAME_FLOOR_CH;
  return avatar.offsetWidth + floor + need + 2 * gap(line) <= line.clientWidth;
}

function ParticipantRow(props: { p: Person; isMe: boolean; label: Label; view?: PeerView; speaking: boolean; onVolume?: (v: number) => void; onProfile: (anchor: HTMLElement) => void; unread?: number; on?: boolean }) {
  const [sliderOpen, setSliderOpen] = createSignal(false);
  const volume = () => props.view?.volume ?? 1;
  const percent = () => Math.round(volume() * 100);
  const [tight, setTight] = createSignal(false);
  let watcher: { disconnect(): void }[] = [];
  onCleanup(() => watcher.forEach((w) => w.disconnect()));
  const watchFit = (line: HTMLDivElement) => {
    const check = () => setTight(!badgesFitWhole(line));
    const resize = new ResizeObserver(check), mutation = new MutationObserver(check);
    resize.observe(line);
    mutation.observe(line, { childList: true, subtree: true, characterData: true });
    watcher = [resize, mutation];
  };
  return (
    <li class={props.on ? 'prow on' : 'prow'}>
      <div class={`pline ${tight() ? 'tight' : ''}`} ref={watchFit}>
      <Avatar initial={props.label.shown[0]!} picture={props.label.picture} speaking={props.speaking} title={props.isMe ? 'Your profile' : `Your private conversation with ${props.label.shown}`} onOpen={props.onProfile} />
      <span class="pname" title={props.label.title}><span class="nm">{props.label.shown}{props.isMe ? ' (you)' : ''}</span>
        <Show when={props.unread}><b class="unread" title="New private messages">{props.unread}</b></Show>
      </span>
      <span class="pflags">
        <Show when={props.p.muted}><em>muted</em></Show>
        <Show when={props.p.sharing}><em>sharing</em></Show>
        <Show when={props.view}>{(v) => <span class={`conn conn-${v().conn}`} title={CONN_LABEL[v().conn]}><i /><span class="conn-label">{CONN_LABEL[v().conn]}</span></span>}</Show>
        <Show when={props.view && props.view.rttMs !== null}><Lag ms={props.view!.rttMs!} /></Show>
        <Show when={props.onVolume && props.view}>
          <button class={`vol ${percent() !== 100 ? 'on' : ''}`} title={`Their voice for you: ${percent()}%`} onClick={() => setSliderOpen(!sliderOpen())}>
            {percent() === 0 ? '🔇' : '🔊'}<Show when={percent() !== 100}><small>{percent()}%</small></Show>
          </button>
        </Show>
      </span>
      </div>
      <Show when={sliderOpen() && props.onVolume}>
        <label class="volrow">
          <input type="range" min="0" max={MAX_VOLUME * 100} step="5" value={percent()} onInput={(e) => props.onVolume?.(Number(e.currentTarget.value) / 100)} title="Double-click to reset" onDblClick={() => props.onVolume?.(1)} />
          <span class="dim">{percent()}%</span>
        </label>
      </Show>
    </li>
  );
}

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fullscreenElement = (): Element | null => { const d = document as FullscreenDoc; return d.fullscreenElement ?? d.webkitFullscreenElement ?? null; };
const exitFullscreenSafely = (): void => {
  const d = document as FullscreenDoc;
  try { void Promise.resolve(d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.()).catch(() => {}); } catch { /* not in fullscreen anymore */ }
};
const requestFullscreenSafely = (el: FullscreenEl, video?: HTMLVideoElement & { webkitEnterFullscreen?: () => void }): void => {
  try {
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) void Promise.resolve(el.webkitRequestFullscreen()).catch(() => {});
    else video?.webkitEnterFullscreen?.(); // iPhone Safari has no element fullscreen, only the native video player
  } catch { /* not allowed here */ }
};

type ShareTileProps = {
  /** The sharer as this browser names them. */
  p: Person; name: string; isMe: boolean; inCall: boolean; view?: PeerView; stream?: MediaStream; outgoing?: OutgoingShare | null;
  onWatch: (on: boolean) => void; onFullscreen: () => void; onVolume?: (v: number) => void;
  /** The tile has been live for a while and still shows no frame (ticket 12). */
  onBlack?: (element: Record<string, unknown>) => void;
};

/** The share volume's tooltip while nothing confirms the share carries sound; on its container too, as Firefox shows none on a disabled control. */
const NO_SHARE_SOUND = 'This video has no audio';
/** The volume each friend's share had when its speaker muted it, for the speaker to give back; until a reload. */
const unmutedShares = new Map<string, number>();

/** A live tile must have shown a frame this long after going live, or it is reported as black. */
const BLACK_CHECK_MS = 4000;

/**
 * One share. Click: closed → watch, running → fullscreen, fullscreen → back. The tile itself goes
 * fullscreen (not the video), so the header, the stats bar and our own controls stay and the browser's
 * playback controls, meaningless for a live stream, never appear (spec §6.5).
 */
function ShareTile(props: ShareTileProps) {
  let root: HTMLDivElement | undefined;
  let video: HTMLVideoElement | undefined;
  // Playback is started explicitly and the element carries no `autoplay` attribute, on purpose. Brave with
  // autoplay set to Block ignores the attribute even for a muted MediaStream and refuses play() outside a
  // user gesture; worse, its patch to Blink's autoplay policy clears the page's user activation whenever
  // a paused `autoplay` video re-checks the policy, which happens on every click, so with the attribute
  // present not even a click could start the picture (reproduced in headless Brave, Sep 10; the friend's
  // share_black event showed a paused element with frames decoding). Chrome and Firefox play a muted
  // stream either way. So play() runs inside the click that starts watching, while the gesture counts,
  // again when the tile turns live or my own capture arrives, and after every source reset (the load
  // algorithm pauses the element). A refusal is logged, so problem reports carry it, and the tile says
  // "Click to play": that click is the gesture play() needs.
  const [needsClick, setNeedsClick] = createSignal(false);
  const play = (why: 'click' | 'live' | 'own' | 'reset'): void => {
    if (!video) return;
    setNeedsClick(false);
    const gesture = navigator.userActivation?.isActive ?? null;
    video.play().catch((e: unknown) => {
      const name = e instanceof Error ? e.name : String(e);
      if (name === 'AbortError') return; // a newer load or pause superseded this call; not a refusal
      console.warn(`share video play() refused (${why}, gesture ${gesture}):`, name);
      setNeedsClick(true);
    });
  };
  // Frames the element has actually presented, counted with requestVideoFrameCallback (Chrome, Safari,
  // Firefox 132+): getVideoPlaybackQuality() stays at zero for a MediaStream in Firefox, which made the
  // black check below fire on every Firefox viewer. The count is mirrored to data-frames so a problem
  // report reads the same number (diagnostics.ts, core/report.ts).
  let framesShown = 0;
  const countFrames = (): void => {
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    video.dataset['frames'] = '0';
    const tick = (): void => { framesShown++; if (video) { video.dataset['frames'] = String(framesShown); video.requestVideoFrameCallback(tick); } };
    video.requestVideoFrameCallback(tick);
  };
  // Mirror the stream into the element; never read state off the media object in JSX (spec §2.1).
  createEffect(() => props.stream, (stream) => {
    if (!video || video.srcObject === (stream ?? null)) return;
    if (video.dataset['frames'] === undefined) countFrames();
    video.srcObject = stream ?? null;
    if (stream && props.isMe) play('own'); // a viewer's tile plays from the click that starts watching
  });
  // The invariant watchdog reads the same rule (quality ticket 04).
  const state = () => shareTileState(props.isMe, props.inCall, props.view);
  const running = () => state() === 'live' || state() === 'opening' || state() === 'own';
  const showsVideo = () => state() === 'live' || state() === 'own';
  // Black-tile check: bytes arrive (the tile is live) but nothing shows. Report it with what the
  // element says, nudge the element (re-attach the source, play), and let the call re-subscribe.
  // At most two rounds per subscription so a genuinely broken share does not loop forever.
  let blackTimer: ReturnType<typeof setTimeout> | undefined;
  let blackChecks = 0;
  // A memo, so the effect runs on the transition only: an effect on a plain expression reruns with every
  // view update (kbps, speaking), which would re-arm the timer forever and call play() in a loop.
  const live = createMemo(() => state() === 'live' && !props.isMe);
  createEffect(live, (on) => {
    clearTimeout(blackTimer);
    if (!on) { setNeedsClick(false); return; }
    play('live');
    const framesAtLive = framesShown;
    blackTimer = setTimeout(() => {
      if (!video || untrack(state) !== 'live' || blackChecks >= 2) return;
      const q = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
      const counted = video.dataset['frames'] !== undefined; // requestVideoFrameCallback available
      const framed = counted ? framesShown > framesAtLive : q === null || q.totalVideoFrames > 0;
      const shows = video.videoWidth > 0 && framed && !video.paused;
      if (shows) { blackChecks = 0; return; }
      const element = { readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, paused: video.paused, frames: counted ? framesShown - framesAtLive : q?.totalVideoFrames ?? null, error: video.error?.code ?? null, attempt: blackChecks };
      blackChecks++;
      const source = video.srcObject; video.srcObject = null; video.srcObject = source; play('reset');
      props.onBlack?.(element);
    }, BLACK_CHECK_MS);
  });
  onCleanup(() => clearTimeout(blackTimer));
  // Whether this tile is the fullscreen element, mirrored from the document event.
  const [fullscreen, setFullscreen] = createSignal(false);
  // In fullscreen the overlays fade after a moment without pointer movement, so the picture is all
  // there is; any movement brings them back, and they stay while the pointer rests on the controls.
  const [idle, setIdle] = createSignal(false);
  const [onControls, setOnControls] = createSignal(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => { setIdle(false); clearTimeout(idleTimer); idleTimer = setTimeout(() => { setIdle(true); }, OVERLAY_HIDE_MS); };
  const onFsChange = () => {
    const on = root !== undefined && fullscreenElement() === root;
    setFullscreen(on);
    if (on) wake(); else { clearTimeout(idleTimer); setIdle(false); }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  const holdsFullscreen = () => root !== undefined && fullscreenElement() === root;
  // Fullscreen ends the moment the share can no longer show anything (sharer quit, I stopped, peer
  // unreachable, I left the call, tile gone); the page must never stay stuck black.
  const isRunning = createMemo(running);
  createEffect(isRunning, (on) => { if (!on && holdsFullscreen()) exitFullscreenSafely(); });
  onCleanup(() => {
    clearTimeout(idleTimer);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    if (holdsFullscreen()) exitFullscreenSafely();
  });
  const enterFullscreen = () => {
    if (!root) return;
    if (!props.isMe) props.onFullscreen(); // drops every other share (spec §6.5)
    requestFullscreenSafely(root, video);
  };
  const onTileClick = () => {
    if (fullscreen()) exitFullscreenSafely();
    else if (state() === 'closed') { props.onWatch(true); play('click'); }
    else if (needsClick()) play('click');
    else if (running()) enterFullscreen();
  };
  const stopWatching = (e: MouseEvent) => { e.stopPropagation(); props.onWatch(false); };
  const percent = () => Math.round((props.view?.shareVolume ?? 1) * 100);
  // The speaker mutes (0 %) and gives back the volume it took, also to a tile made anew when the share started again.
  const toggleMute = () => {
    const v = props.view?.shareVolume ?? 1;
    if (v > 0) { unmutedShares.set(props.p.publicKey, v); props.onVolume?.(0); } else props.onVolume?.(unmutedShares.get(props.p.publicKey) ?? 1);
  };
  const stats = () => {
    if (props.isMe) {
      const o = props.outgoing;
      if (!o || o.viewers === 0) return 'you are sharing · nobody watching yet';
      const who = o.viewers === 1 ? '1 viewer' : `${o.viewers} viewers`;
      return [who, formatBitrate(o.kbps), ...o.formats.map(formatVideo)].join(' · ');
    }
    const v = props.view;
    if (!v) return '';
    if (state() !== 'live') return CONN_LABEL[v.conn];
    return [formatBitrate(v.shareKbps), ...(v.shareFormat ? [formatVideo(v.shareFormat)] : []), CONN_LABEL[v.conn]].join(' · ');
  };
  return (
    <div class={`share share-${state()} ${fullscreen() ? 'share-fs' : ''} ${fullscreen() && idle() && !onControls() ? 'share-idle' : ''}`} ref={root} onClick={onTileClick}
      onPointerMove={() => { if (fullscreen()) wake(); }} onPointerDown={() => { if (fullscreen()) wake(); }}>
      <div class="share-head" onPointerEnter={() => setOnControls(true)} onPointerLeave={() => setOnControls(false)}>
        <span>{props.isMe ? 'Your screen' : `${props.name}'s screen`}</span>
        <Show when={!props.isMe && props.view ? props.view : undefined}>{(v) => <span class={`conn conn-${v().conn}`}><i />{CONN_LABEL[v().conn]}</span>}</Show>
        <Show when={!props.isMe && (state() === 'live' || state() === 'opening')}><button class="stop" title="Stop receiving this share" onClick={stopWatching}>Stop watching</button></Show>
      </div>
      <video ref={video} playsinline muted hidden={!showsVideo()} />
      <Show when={showsVideo() && needsClick()}><div class="share-note share-play">Click to play</div></Show>
      <Switch>
        <Match when={state() === 'locked'}><div class="share-note">Join to watch</div></Match>
        <Match when={state() === 'closed'}><div class="share-note">Click to watch</div></Match>
        <Match when={state() === 'opening'}><div class="share-note"><span class="spinner" /> Opening…</div></Match>
        <Match when={state() === 'unreachable'}><div class="share-note">No connection to {props.name}</div></Match>
      </Switch>
      <Show when={running()}>
        <div class="share-bar" onClick={(e) => e.stopPropagation()} onPointerEnter={() => setOnControls(true)} onPointerLeave={() => setOnControls(false)}>
          <span class="share-stats">{stats()}</span>
          {/* Disabled until sound has arrived: a window, or anything shared from Firefox, has none to set. Always there, so
              the bar does not jump when it comes. */}
          <Show when={!props.isMe && props.onVolume}>
            <div class={`share-vol ${props.view?.shareSound ? '' : 'share-vol-none'}`} title={props.view?.shareSound ? `${percent()}%. Double-click the slider to reset.` : NO_SHARE_SOUND}>
              <button class="share-mute" disabled={!props.view?.shareSound} onClick={toggleMute} aria-label={percent() === 0 ? "Unmute this share's sound" : "Mute this share's sound"}>{percent() === 0 ? '🔇' : '🔊'}</button>
              <input type="range" min="0" max={MAX_VOLUME * 100} step="5" value={percent()} disabled={!props.view?.shareSound} aria-label="This share's sound" title={props.view?.shareSound ? undefined : NO_SHARE_SOUND} onInput={(e) => props.onVolume?.(Number(e.currentTarget.value) / 100)} onDblClick={() => props.onVolume?.(1)} />
              <span class="share-vol-pct">{percent()}%</span>
            </div>
          </Show>
          <button class="fs" title={fullscreen() ? 'Leave fullscreen' : 'Fullscreen'} onClick={(e) => { e.stopPropagation(); if (fullscreen()) exitFullscreenSafely(); else enterFullscreen(); }}>{fullscreen() ? '⤡' : '⛶'}</button>
        </div>
      </Show>
    </div>
  );
}

function Banner(props: { status: ServerStatus; onTakeOver: () => void }) {
  return (
    <Switch>
      <Match when={props.status.kind === 'elsewhere'}><div class="banner banner-warn">This room is open in another tab or window of this browser. <button class="link" onClick={props.onTakeOver}>Use it here instead</button></div></Match>
      <Match when={props.status.kind === 'connecting'}><div class="banner banner-warn">Connecting…</div></Match>
      <Match when={props.status.kind === 'reconnecting'}><div class="banner banner-warn">Reconnecting to server… voice and shares continue, texts go out once it is back</div></Match>
      <Match when={props.status.kind === 'unavailable'}><div class="banner banner-bad">Server unavailable, retrying. Voice and shares continue, texts wait.</div></Match>
      <Match when={props.status.kind === 'refused' && props.status}>{(s) => <div class="banner banner-bad">Refused: {s().reason}. Ask for a fresh invite link.</div>}</Match>
    </Switch>
  );
}

/**
 * The question (ticket 32), asked by the dave mascot peeking in from the corner, after Josh Comeau's blog: once on its
 * own, then again whenever the sidebar's button is clicked. Until it is answered, and after a no, nothing goes to PostHog.
 */
function TelemetryNotice(props: { onAnswer: (c: Consent) => void }) {
  return (
    <section class="consent" aria-label="Help find bugs">
      <div class="bubble">
        <p class="hello">Hi friend! Hope I didn't startle you. Want to help me find bugs?</p>
        <p>
          If you say yes, this browser sends usage events, errors, connection problems and a screen recording with every text and input blanked out
          to PostHog, an analytics service with servers in the EU. Never your messages or names.
        </p>
        <p class="dim">
          {telemetryOn() ? 'You are helping right now, thank you! Maybe later stops it.' : 'Nothing is sent unless you say yes.'} You can change your mind any time at the bottom of the sidebar.
        </p>
        <div class="row">
          {/* type=button: the notice sits inside the composer's form, and must not send the draft */}
          <button type="button" class="link" onClick={() => props.onAnswer('on')}>Sure!</button>
          <button type="button" class="link" onClick={() => props.onAnswer('off')}>Maybe later</button>
        </div>
      </div>
      <div class="peek"><img class="dino" src={dino} alt="" /></div>
    </section>
  );
}

/**
 * "Report a problem" (ticket 12): a category, a severity and a description plus a technical snapshot
 * go to the room's error log (PostHog), next to this tab's masked session replay. Copy is the fallback
 * for browsers that block it.
 */
function ReportDialog(props: { collect: () => Promise<Report> }) {
  let dialog: HTMLDialogElement | undefined;
  const [text, setText] = createSignal('');
  const [category, setCategory] = createSignal<Category>('other');
  const [severity, setSeverity] = createSignal<Severity>('annoying');
  const [phase, setPhase] = createSignal<'idle' | 'sending' | 'sent' | 'copied' | 'copy_failed'>('idle');
  const form = () => ({ text: text(), category: category(), severity: severity() });
  const open = () => { setPhase('idle'); dialog?.showModal(); };
  const send = async () => { setPhase('sending'); sendReport(form(), await props.collect()); setPhase('sent'); };
  const copy = async () => {
    const body = formatReport(form(), await props.collect());
    try { await navigator.clipboard.writeText(body); setPhase('copied'); } catch { setPhase('copy_failed'); }
  };
  return (
    <>
      <button class="link" onClick={open}>Report a problem</button>
      <dialog class="report" ref={dialog}>
        <h3>Report a problem</h3>
        <label class="field">What is broken?
          <select value={category()} onChange={(e) => { const v = e.currentTarget.value; if (isCategory(v)) setCategory(v); }}>
            <For each={Object.entries(CATEGORIES)}>{([key, label]) => <option value={key}>{label}</option>}</For>
          </select>
        </label>
        <fieldset class="field severity">
          <legend>How bad is it?</legend>
          <For each={Object.entries(SEVERITIES)}>{([key, label]) => (
            <label><input type="radio" name="severity" value={key} checked={severity() === key} onChange={() => { if (isSeverity(key)) setSeverity(key); }} /> {label}</label>
          )}</For>
        </fieldset>
        <textarea value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder="What went wrong, and what did you expect? When did it happen?" rows={4} />
        <p class="hint">
          Your description is sent to PostHog, the room's error log, together with a technical snapshot of your connection: states and counters, never message texts or names.
          {telemetryOn() ? ' The last minutes of this tab are already kept as a masked session replay.' : ' Only this report goes, nothing before or after it.'}
        </p>
        <Switch>
          <Match when={phase() === 'sent'}><p class="ok">Sent, thank you. Brave and strict tracking protection can block this silently: if in doubt, also use Copy and paste it to the person running this room.</p></Match>
          <Match when={phase() === 'copied'}><p class="ok">Copied. Paste it to the person running this room.</p></Match>
          <Match when={phase() === 'copy_failed'}><p class="warn">Could not access the clipboard. Try Send instead.</p></Match>
        </Switch>
        <div class="row">
          <button class="on" onClick={() => void send()} disabled={phase() === 'sending' || !text().trim()}>{phase() === 'sending' ? 'Sending…' : 'Send'}</button>
          <button onClick={() => void copy()} disabled={!text().trim()}>Copy</button>
          <button onClick={() => dialog?.close()}>Close</button>
        </div>
      </dialog>
    </>
  );
}

/** Date and 24-hour clock time, always with the day: a version's age is the point. */
const stamp = (iso: string): string => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Which version of dave this is: the commit it was built from, its message, when it was deployed, and where the code lives. */
function VersionDialog() {
  let dialog: HTMLDialogElement | undefined;
  const deployed = build.target === 'local' ? 'Built' : 'Deployed';
  return (
    <div class="about-link">
      <button class="link" title={`Version ${shortCommit(build.commit)}${build.dirty ? '+' : ''}, ${deployed.toLowerCase()} ${formatAgo(Date.parse(build.builtAt))}`} onClick={() => dialog?.showModal()}>About</button>
      {/* A click on the backdrop reaches the dialog itself, outside its box; its padding is the dialog too, so the box decides. */}
      <dialog class="about" ref={dialog} onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.target === e.currentTarget && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) e.currentTarget.close();
      }}>
        <h3>About dave</h3>
        <dl>
          <dt>Version</dt>
          <dd><a href={commitUrl(build.commit)} target="_blank" rel="noopener"><code>{shortCommit(build.commit)}</code></a>{build.dirty ? ' plus uncommitted changes' : ''}</dd>
          <dt>Latest change</dt>
          {/* The commit message: its title, and the description behind it for whoever wants the detail. */}
          <dd>
            <Show when={build.body} fallback={<span class="change">{build.subject || 'No commit message'}</span>}>
              <details class="change"><summary>{build.subject || 'No commit message'}</summary><p>{build.body}</p></details>
            </Show>
          </dd>
          <dt>Committed</dt>
          <dd>{stamp(build.committedAt)}</dd>
          <dt>{deployed}</dt>
          <dd>{stamp(build.builtAt)} ({formatAgo(Date.parse(build.builtAt))}){build.target === 'local' ? ', on a developer\'s machine' : `, to ${build.target === 'live' ? 'the live site' : build.target}`}</dd>
          <dt>Source</dt>
          <dd><a href={REPO_URL} target="_blank" rel="noopener">{REPO_URL.replace(/^https:\/\//, '')}</a></dd>
        </dl>
        <div class="row"><button onClick={() => dialog?.close()}>Close</button></div>
      </dialog>
    </div>
  );
}

/** Fullscreen overlays hide this long after the pointer last moved. */
const OVERLAY_HIDE_MS = 2500;

/** Clock time on a 24-hour clock; older than a day also says which day. */
const when = (at: number): string => new Date(at).toLocaleString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(Date.now() - at > 20 * 3600 * 1000 ? { day: '2-digit', month: 'short' } : {}) });

/**
 * A file waiting above the composer: `original` while a pasted picture's original may still come, `preparing` while it
 * is hashed, then `ready` with what the room needs to send it at once, or `unreadable`.
 */
type Staged = { id: number; file: File; url: string | null; state: 'original' | 'preparing' | 'ready' | 'unreadable'; prepared: PreparedFile | null };
/** Whether Send can take this file: ready, or never going to be. */
const settled = (x: Staged): boolean => x.state === 'ready' || x.state === 'unreadable';
const STAGED_STATE: Record<Staged['state'], string> = { original: 'Getting the original…', preparing: 'Preparing…', ready: '', unreadable: "Can't be read, won't be sent" };

/** A blob URL for a staged file's thumbnail, for pictures shown inline (never SVG); the caller revokes it. */
const thumbnailUrl = (file: File): string | null => (inlineKind(file.type) === 'image' ? URL.createObjectURL(file) : null);

/** "PDF": what a staged file without a thumbnail shows instead, from its name. */
const fileEnding = (name: string): string => /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toUpperCase() ?? 'FILE';

/** How long a paste waits for the original of a picture copied in a browser before it stages the clipboard's copy. */
const ORIGINAL_WAIT_MS = 10_000;

/**
 * The picture at `url` as a file, or null: its site does not let other pages read it (CORS), it is not a picture shown
 * inline, it took longer than ORIGINAL_WAIT_MS, or it is not the picture the browser copied (`still`) by its shape and
 * size. A page that loads pictures late may have a 1-pixel placeholder, or a small fallback, as the `src` it puts there.
 */
async function originalPicture(url: string, still: File): Promise<File | null> {
  try {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(ORIGINAL_WAIT_MS) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || inlineKind(type) !== 'image') return null;
    const last = new URL(res.url || url).pathname.split('/').pop() ?? '';
    let name = last;
    try { name = decodeURIComponent(last); } catch { /* the name as the URL has it */ }
    const original = new File([await res.blob()], name || 'image', { type });
    // The same picture by its shape, and no smaller: not a placeholder, nor a small fallback for a sharp copy.
    const [a, b] = await Promise.all([createImageBitmap(original, { imageOrientation: 'from-image' }), createImageBitmap(still, { imageOrientation: 'from-image' })]);
    const same = Math.abs(a.width / a.height - b.width / b.height) <= 0.02 * (b.width / b.height) && a.width >= b.width - 1;
    a.close();
    b.close();
    return same ? original : null;
  } catch {
    return null;
  }
}

/**
 * The message input. A separate grid item from the log so phones can keep it as the bottom row of the screen.
 * The emoji button opens the picker (issue #3); a pick lands at the caret and the picker stays for the next one.
 */
function Composer(props: {
  connected: boolean; writable: boolean; roomName: string; children?: any;
  /** The friend this writes to privately (ADR 0007), and why they cannot be written to now, if so; null writes to the room. */
  privateTo: { key: string; name: string; blocked: string | null } | null;
  /** Sends the text (maybe empty) with the staged files; false when it was not taken, and stays in the field. */
  onSend: (text: string) => boolean;
  staged: Staged[]; onStage: (file: File, original?: Promise<File | null>) => void; onUnstage: (id: number) => void;
}) {
  const [draft, setDraft] = createSignal('');
  let input: HTMLInputElement | undefined;
  let emojiButton: HTMLButtonElement | undefined;
  let picker: HTMLInputElement | undefined;
  // A picture pasted from the clipboard (a screenshot) is staged as a file; pasted text stays text. A picture copied in a
  // browser comes as a still PNG; the original it points at takes its place when the page can read it, so a GIF moves.
  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    // Not where no file can go now (a conversation with a friend I cannot write to): the attach button and a drop say no too.
    if (!files.length || !props.writable || privateHeld()) return;
    e.preventDefault();
    const url = files.length === 1 && files[0]!.type.startsWith('image/') ? pastedImageUrl(e.clipboardData?.getData('text/html') ?? '') : null;
    if (!url) for (const f of files) props.onStage(f);
    else props.onStage(files[0]!, originalPicture(url, files[0]!));
  };
  // A file staged from the attach button or a drop: Enter sends it, so the text field takes the focus where there is a
  // keyboard. A phone's would cover the chat, and it has the Send button.
  createEffect(() => props.staged.length, (n, prev) => { if (n > (prev ?? 0) && matchMedia('(pointer: fine)').matches) input?.focus(); });
  // A private conversation coming on screen takes the focus, where there is a keyboard. A draft written in one goes when
  // it leaves the screen (back to a room, another friend): the next Enter would send it to more people than it was for.
  // A room's draft waits while a conversation is on screen (a look at a friend's profile, say) and comes back after.
  let roomDraft = '';
  createEffect(() => props.privateTo?.key, (key, prev) => {
    if (key === prev) return;
    if (!prev && key) roomDraft = untrack(draft);
    if (prev || key) setDraft(key ? '' : roomDraft);
    if (!key) roomDraft = '';
    if (key && matchMedia('(pointer: fine)').matches) input?.focus();
  });
  /** Why Send cannot send right now while writing privately, or null. */
  const privateHeld = () => (props.privateTo?.blocked ? `Can't write to ${props.privateTo.name} now: ${props.privateTo.blocked}` : null);
  const submit = (e: Event) => {
    e.preventDefault();
    const text = draft().trim();
    // Waits for files still being made ready: the text stays, and Send says why.
    if ((!text && !props.staged.length) || !props.writable || !props.staged.every(settled) || privateHeld()) return;
    if (props.onSend(text)) setDraft('');
  };
  const insert = (emoji: string) => {
    const at = input?.selectionStart ?? draft().length;
    const to = input?.selectionEnd ?? at;
    const next = draft().slice(0, at) + emoji + draft().slice(to);
    if (next.length > MAX_TEXT_LENGTH) return;
    setDraft(next);
    posthog.capture('emoji_picked', { via: 'composer' });
    // Typing continues right after the emoji; the picker stays open (a popover does not take focus back).
    queueMicrotask(() => { input?.focus(); input?.setSelectionRange(at + emoji.length, at + emoji.length); });
  };
  // Private, out of PostHog, recordings too (`ph-no-capture`): its placeholder and Send's title name the friend.
  return (
    <form class={props.privateTo ? 'chat-input private ph-no-capture' : 'chat-input'} onSubmit={submit}>
      <Show when={props.staged.length}>
        <ul class="staged" aria-label="To send">
          <For each={props.staged}>{(x) => (
            <li class={settled(x) ? x.state : `${x.state} pending`}>
              <span class="thumb"><Show when={x.url} fallback={fileEnding(x.file.name)}>{(u) => <Picture src={u()} type={x.file.type} alt="" />}</Show></span>
              <span class="meta"><span class="name" title={x.file.name}>{x.file.name}</span><span class="size">{STAGED_STATE[x.state] || formatSize(x.file.size)}</span></span>
              <button type="button" class="unstage" onClick={() => props.onUnstage(x.id)} title={`Don't send ${x.file.name}`} aria-label={`Remove ${x.file.name}`}>✕</button>
            </li>
          )}</For>
        </ul>
      </Show>
      {/* The text field with its two buttons over its edges, as messengers do; the field itself keeps the theme's look */}
      <div class="chat-field">
        <button type="button" class="emoji-open" ref={emojiButton} popovertarget="composer-emoji" disabled={!props.writable} title="Emoji" aria-label="Emoji">🙂</button>
        <EmojiPicker id="composer-emoji" anchor={() => emojiButton} onPick={insert} />
        <input ref={input} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} onPaste={onPaste} disabled={!props.writable} maxlength={MAX_TEXT_LENGTH}
               placeholder={props.privateTo?.blocked ? `Can't write to ${props.privateTo.name} now: ${props.privateTo.blocked}` : props.privateTo && props.writable ? `Message ${props.privateTo.name}${props.connected ? '' : ', sent once reconnected'}` : props.connected ? `Message ${props.roomName}` : props.writable ? `Message ${props.roomName}, sent once reconnected` : holding() ? 'A new version of dave is loading…' : "Can't send while disconnected"} />
        {/* Looks like the emoji button, in every theme: the themes style that one by its class */}
        <button type="button" class="emoji-open attach-open" disabled={!props.writable || !!privateHeld()} onClick={() => picker?.click()} title={props.privateTo ? `Send ${props.privateTo.name} a picture, a video or a file` : 'Send a picture, a video or a file'} aria-label="Attach a file">📎</button>
        {/* Wrapped: the text field is the field's one direct input child (styles and the e2e fixtures find it so) */}
        <span hidden><input ref={picker} type="file" multiple data-testid="attach" onChange={(e) => { const files = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; for (const f of files) props.onStage(f); }} /></span>
      </div>
      <button disabled={!props.writable || (!draft().trim() && !props.staged.length) || !props.staged.every(settled) || !!privateHeld()}
              title={privateHeld() ?? (props.staged.every(settled) ? undefined : 'Waiting for the files to be ready')}>Send</button>
      {props.children}
    </form>
  );
}

/**
 * The log with the new-messages pill. `jumpToken` changes when I send, which brings me back to the newest line.
 * Texts from more than 18 h before the room came on screen (`openedAt`) wait behind a button above the log, until
 * clicked or until the room comes on screen again (ticket 38).
 */
function ChatLog(props: {
  lines: ChatLine[]; openedAt: number; jumpToken: number; label: (id: Identity) => Label;
  /** Above the log: a private conversation's head (ADR 0007), which is all `private` then. */
  head?: any; private?: boolean; hidden?: boolean;
  /** What an empty log says. */
  empty?: string;
  /** Whom a file's bytes come from, by its writer (a private file of mine, after a reload: the friend who pulled it). */
  holder?: (from: Identity) => string;
  attachment: (hash: string) => Attachment | undefined; onPull: (hash: string) => void; onCancel: (hash: string) => void;
}) {
  let log: HTMLDivElement | undefined;
  let viewer: HTMLDialogElement | undefined;
  const [viewing, setViewing] = createSignal<{ url: string; name: string; type: string } | null>(null);
  const view = (url: string, name: string, type: string) => { setViewing({ url, name, type }); if (viewer && !viewer.open) viewer.showModal(); };
  // The tooltip (the time, or that it is not sent yet) is on the text or the attachment, not on the whole row.
  const file = (m: Extract<ChatLine, { kind: 'file' }>, title: string | undefined) => (
    <FileView file={m.file} title={title} attachment={props.attachment(m.file.hash)} holder={props.holder?.(m.from) ?? props.label(m.from).shown}
              onPull={() => props.onPull(m.file.hash)} onCancel={() => props.onCancel(m.file.hash)} onView={view} />
  );
  const [unfoldedFor, setUnfoldedFor] = createSignal<number | null>(null); // the opening the reader unfolded the older lines in
  const folded = createMemo(() => (unfoldedFor() === props.openedAt ? 0 : olderCount(props.lines, props.openedAt - FOLD_OLDER_MS)));
  const lines = createMemo(() => props.lines.slice(folded()));
  // Lines in reading order, so selecting text works as it reads. The browser measures scroll positions from the
  // top edge, which is the edge that moves when the share strip comes or goes, so the log keeps its own distance
  // to the bottom edge and restores it after every size change (ResizeObserver) and every change of the lines:
  // a reader at the newest line stays there, a reader who scrolled up keeps the lines they were reading in
  // place. Browser scroll anchoring is off (CSS); it snapped a scrolled-up reader to the bottom.
  let top = 0; // the scroll position at the last measurement, from the top edge
  let gap = 0; // distance from the bottom edge at the last measurement; 0 is "at the newest line"
  let size = ''; // client and scroll height at that measurement: a scroll event under a different size is the browser clamping, not the reader
  const sizeKey = () => `${log?.clientHeight}x${log?.scrollHeight}`;
  const atBottom = () => gap < 8;
  const [unseen, setUnseen] = createSignal(false);
  // Hidden (display: none), the log has no size to measure or restore by: what it had stays for when it shows again.
  const measure = () => { if (!log || props.hidden) return; gap = log.scrollHeight - log.clientHeight - log.scrollTop; size = sizeKey(); top = log.scrollTop; };
  const restore = () => { if (!log || props.hidden) return; log.scrollTop = log.scrollHeight - log.clientHeight - gap; size = sizeKey(); top = log.scrollTop; };
  const onScroll = () => { if (size === sizeKey()) measure(); else restore(); if (atBottom()) setUnseen(false); };
  const jump = () => { gap = 0; restore(); setUnseen(false); };
  const observer = new ResizeObserver(restore);
  onCleanup(() => observer.disconnect());
  createEffect(() => ({ n: lines().length, last: lines().at(-1)?.id }), (now, prev) => {
    if (!log) return;
    if (prev === undefined) observer.observe(log);
    // Hidden behind a private conversation, it measures nothing: the reader's place is kept for when it shows again.
    if (props.hidden) return;
    // A line arrived while the reader was up in the older lines: the browser has left them in place and the
    // new line waits below, so only the distance to the bottom changes. Otherwise the log stays at the newest line;
    // lines that came in above it (the history as it loads, the older lines unfolded) leave the reader where they were.
    if (prev !== undefined && now.n > prev.n && now.last !== prev.last && !atBottom()) { measure(); setUnseen(true); } else restore();
  });
  createEffect(() => props.jumpToken, (t, prev) => { if (prev !== undefined && t !== prev) jump(); });
  // Hidden behind a private conversation and shown again: back where the reader was, counted from the top, which lines
  // arriving meanwhile do not move; the pill says when some came. One at the newest line stays at the newest line.
  // Taken from the last measurement: by the time this runs the log is hidden already, and reads 0. Forgotten when the
  // log shows another room meanwhile (`openedAt`), which starts at its newest line.
  let hiddenAt: { top: number; bottom: boolean; n: number } | null = null;
  createEffect(() => props.openedAt, (_now, prev) => { if (prev !== undefined) hiddenAt = null; });
  createEffect(() => !!props.hidden, (hidden, was) => {
    if (!log || was === undefined || hidden === was) return;
    if (hidden) {
      hiddenAt = { top, bottom: atBottom(), n: lines().length };
      // Out of sight, a video or a sound playing in the room would go on with nothing on screen to stop it.
      for (const m of log.querySelectorAll('video, audio')) (m as HTMLMediaElement).pause();
      return;
    }
    const at = hiddenAt;
    hiddenAt = null;
    if (!at || at.bottom) { jump(); return; }
    gap = Math.max(0, log.scrollHeight - log.clientHeight - at.top);
    restore();
    if (untrack(lines).length > at.n) setUnseen(true);
  });
  return (
    // A private conversation is kept out of PostHog's autocapture too (`ph-no-capture`): a click on a link would carry it.
    <div class={props.private ? 'chat private ph-no-capture' : 'chat'} hidden={props.hidden}>
      {props.head}
      <div class="chat-log" ref={log} onScroll={onScroll}>
        <Show when={props.empty && props.lines.length === 0}><p class="chat-empty">{props.empty}</p></Show>
        <Show when={folded() > 0}>
          <button class="chat-older" onClick={() => setUnfoldedFor(props.openedAt)} title="Messages from more than 18 hours before you opened this room">
            Show older messages
          </button>
        </Show>
        <For each={lines()}>
          {(l, i) => (
            <Switch>
              <Match when={l.kind === 'system' && l}>{(s) => <div class="msg msg-sys"><span class="msg-text">{s().text}</span><span class="msg-at">{when(s().at)}</span></div>}</Match>
              <Match when={l.kind === 'text' && l}>
                {(m) => (
                  <Show when={!continues(lines(), i())} fallback={
                    <div class={msgClass('msg msg-cont', m())}><div class="msg-text" title={m().pending ? 'Not sent yet' : when(m().at)}><Linkified text={m().text} /></div></div>
                  }>
                    <div class={msgClass('msg', m())}>
                      <span class="msg-from" title={props.label(m().from).title}>{props.label(m().from).shown}</span>
                      <span class="msg-at">{when(m().at)}</span>
                      <div class="msg-text" title={m().pending ? 'Not sent yet' : undefined}><Linkified text={m().text} /></div>
                    </div>
                  </Show>
                )}
              </Match>
              <Match when={l.kind === 'file' && l}>
                {(m) => (
                  <Show when={!continues(lines(), i())} fallback={<div class={m().pending ? 'msg msg-cont msg-pending' : 'msg msg-cont'}>{file(m(), m().pending ? 'Not sent yet' : when(m().at))}</div>}>
                    <div class={m().pending ? 'msg msg-pending' : 'msg'}>
                      <span class="msg-from" title={props.label(m().from).title}>{props.label(m().from).shown}</span>
                      <span class="msg-at">{when(m().at)}</span>
                      {file(m(), m().pending ? 'Not sent yet' : undefined)}
                    </div>
                  </Show>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
      <Show when={unseen()}><button class="chat-new" onClick={jump} title="Scroll to the newest message">new messages ↓</button></Show>
      <dialog class="viewer" ref={viewer} onClick={() => viewer?.close()} onClose={() => setViewing(null)}>
        <Show when={viewing()} keyed>{(v) => <Picture src={v.url} type={v.type} alt={v.name} />}</Show>
      </dialog>
    </div>
  );
}

/** The longest side of a picture or a video in the chat, in CSS pixels; a portrait one is as tall, and narrower. */
const MEDIA_SIDE = 320;
const PULL_FAILED: Record<PullError, (holder: string) => string> = {
  unreachable: (h) => `Couldn't reach ${h}`,
  lost: () => 'The connection dropped',
  'not there': (h) => `${h} doesn't have it any more`,
  damaged: () => 'It arrived damaged',
  busy: (h) => `${h} is sending to others`,
  'no room': () => "This browser can't keep files this large",
};

/**
 * An attachment in the chat (ADR 0006): a picture or a video inline once its bytes are here, its preview until then,
 * with what is happening over it; anything else a card with its name, size and a button. A picture opens full size.
 */
function FileView(props: { file: FileMeta; title: string | undefined; attachment: Attachment | undefined; holder: string; onPull: () => void; onCancel: () => void; onView: (url: string, name: string, type: string) => void }) {
  const kind = () => inlineKind(props.file.type);
  const a = () => props.attachment ?? { status: 'idle' as const };
  const url = () => { const now = a(); return now.status === 'ready' ? now.url : null; };
  // One tooltip over all of a picture or a video, whatever shows in its box (the preview, the picture, its still).
  const tip = () => (props.title ? `${props.file.name}, ${props.title}` : props.file.name);
  // The box keeps the picture's shape, so the log does not jump when the bytes replace the preview.
  const box = () => {
    const { width: w, height: h } = props.file;
    return w && h ? { 'aspect-ratio': `${w} / ${h}`, width: `${Math.round(Math.min(MEDIA_SIDE, (MEDIA_SIDE * w) / h))}px` } : {};
  };
  const state = () => {
    const now = a();
    switch (now.status) {
      case 'pulling': return (
        <span class="att-state" aria-live="polite">
          {/* A bar of its own: a native progress this thin is drawn as a bare track in Chromium, its fill not seen */}
          <span class="att-bar" role="progressbar" aria-label={`Loading ${props.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor((100 * now.received) / Math.max(1, props.file.size))}>
            <span style={{ width: `${(100 * now.received) / Math.max(1, props.file.size)}%` }} />
          </span>
          {Math.floor((100 * now.received) / Math.max(1, props.file.size))}% of {formatSize(props.file.size)}
          <button type="button" class="att-cancel" onClick={(e) => { e.stopPropagation(); props.onCancel(); }} title="Stop loading it" aria-label="Cancel">✕</button>
        </span>
      );
      case 'waiting': return <span class="att-state">Waiting for {props.holder} to come online</span>;
      case 'failed': return <span class="att-state">{PULL_FAILED[now.reason](props.holder)}.{now.retryAt ? ' Trying again soon.' : ''} <button type="button" onClick={(e) => { e.stopPropagation(); props.onPull(); }}>Try again</button></span>;
      case 'idle': return (
        <button type="button" class="att-get" onClick={(e) => { e.stopPropagation(); props.onPull(); }}>
          ⬇ {now.partial ? `Resume, ${Math.floor((100 * now.partial) / Math.max(1, props.file.size))}% of ${formatSize(props.file.size)}` : formatSize(props.file.size)}
        </button>
      );
      default: return null;
    }
  };
  return (
    <Switch fallback={
      <div class="att att-card" data-status={a().status} title={props.title}>
        <span class="att-icon" aria-hidden="true">📄</span>
        <span class="att-name" title={props.file.name}>{props.file.name}</span>
        <span class="att-size">{formatSize(props.file.size)}</span>
        <Show when={url()} fallback={state()}>{(u) => <a class="att-save" href={u()} download={props.file.name}>Save</a>}</Show>
      </div>
    }>
      <Match when={kind() === 'image'}>
        <figure class="att att-media" data-status={a().status} style={box()} title={tip()}>
          <Show when={url()} fallback={<Show when={props.file.preview}>{(p) => <img class="att-preview" src={p()} alt="" />}</Show>}>
            {(u) => <Picture src={u()} type={props.file.type} alt={props.file.name} onClick={() => props.onView(u(), props.file.name, props.file.type)} />}
          </Show>
          <Show when={!url()}><figcaption>{state()}</figcaption></Show>
        </figure>
      </Match>
      <Match when={kind() === 'video'}>
        <figure class="att att-media" data-status={a().status} style={box()} title={tip()}>
          <Show when={url()} fallback={<Show when={props.file.preview}>{(p) => <img class="att-preview" src={p()} alt="" />}</Show>}>
            {(u) => <video src={u()} controls playsinline preload="metadata" />}
          </Show>
          <Show when={!url()}><figcaption>{state()}</figcaption></Show>
        </figure>
      </Match>
    </Switch>
  );
}

/** Picture types that can move: a GIF, or a WebP, which friends' stickers often are. An APNG or an AVIF could, rarely. */
const MAY_MOVE = new Set(['image/gif', 'image/webp']);

/**
 * A picture in the chat or the viewer. One that can move is held still while this window is not focused, so a room left
 * open on a second screen does not flicker at the edge of the eye. An <img> has no pause: a still of it, drawn on a
 * canvas as the focus goes (the frame showing then in Chromium, the first frame in Firefox), covers it until the focus
 * comes back, and the picture goes on underneath. Only a picture on screen gets one, so a long log of GIFs costs a few.
 */
function Picture(props: { src: string; type: string; alt: string; onClick?: () => void }) {
  const moves = untrack(() => MAY_MOVE.has(props.type.toLowerCase())); // a picture keeps its type
  const [loaded, setLoaded] = createSignal(false);
  const [onScreen, setOnScreen] = createSignal(false);
  let img: HTMLImageElement | undefined;
  let seen: IntersectionObserver | undefined;
  onCleanup(() => seen?.disconnect());
  const watch = (el: HTMLImageElement) => {
    img = el;
    if (!moves) return;
    seen = new IntersectionObserver((entries) => { for (const e of entries) setOnScreen(e.isIntersecting); });
    seen.observe(el);
  };
  const still = () => moves && loaded() && onScreen() && !windowFocused();
  // Drawn no larger than the picture shows, in device pixels: a big GIF is not copied whole.
  const draw = (canvas: HTMLCanvasElement) => {
    if (!img?.naturalWidth || !img.naturalHeight) return;
    const shown = img.getBoundingClientRect();
    const scale = Math.min(1, (Math.max(shown.width, shown.height) * devicePixelRatio) / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  return (
    <>
      {/* Kept in place under its still, see-through, so it still takes the click and lets the hover reach its box */}
      <img ref={watch} src={props.src} alt={props.alt} onClick={props.onClick} onLoad={() => setLoaded(true)} style={{ opacity: still() ? 0 : undefined }} />
      <Show when={still()}><canvas class="still" ref={draw} aria-hidden="true" /></Show>
    </>
  );
}

/** How long after a line the same writer's next one still joins it under one name. */
const GROUP_MS = 5 * 60 * 1000;
/** Whether line i follows straight on from the same writer's previous text, so it goes under that name without its own. */
const continues = (lines: ChatLine[], i: number): boolean => {
  const l = lines[i], prev = lines[i - 1];
  return l?.kind !== 'system' && !!l && prev?.kind !== undefined && prev.kind !== 'system' && prev.from.publicKey === l.from.publicKey && l.at - prev.at < GROUP_MS;
};
const msgClass = (base: string, m: Extract<ChatLine, { kind: 'text' }>): string => `${base}${m.pending ? ' msg-pending' : ''}`;

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function Linkified(props: { text: string }) {
  const parts = createMemo(() => props.text.split(URL_RE));
  // Odd indices are the URLs captured by the split. Reading i() inside JSX keeps it tracked.
  return <For each={parts()}>{(part, i) => <Show when={i() % 2 === 1} fallback={<>{part}</>}><a href={part} target="_blank" rel="noopener noreferrer">{part}</a></Show>}</For>;
}
