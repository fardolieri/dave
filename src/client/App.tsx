import { createSignal, Switch, Match, createMemo, createEffect, For, Show, untrack, onCleanup, mapArray } from 'solid-js';
import './styles.css';
import posthog, { isTestAccount } from './posthog';
import { loadIdentity, type LocalIdentity } from './identity';
import { getName, getPicture, inviteLinkFor, setName, setPicture, takeInviteLink } from './invite';
import { addRoom, forgetRoom, getSelectedRoom, loadRooms, setSelectedRoom, type SavedRoom } from './rooms';
import { newRoomSecret, normaliseRoomName, parseInviteText, type InviteLink } from '../core/rooms';
import { createRoom, type ChatLine, type ServerStatus } from './room';
import { createCall, type ConnState, type OutgoingShare, type PeerView } from './call';
import { createAttention, type RoomLink } from './attention';
import { contactOf, isKnown, markKnown, setNickname } from './contacts';
import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH, normaliseName, type Identity, type Person } from '../core/protocol';
import { ambiguousNames, displayName, knownAgo, showsFingerprint } from '../core/names';
import { LOW_LATENCY_MS, MAX_VOLUME, mbpsToBps, processingIsDefault, type AudioSettings, type Degradation, type FrameRate, type MaxHeight } from '../core/settings';
import { formatBitrate, formatVideo } from '../core/format';
import { collectReport, formatReport, sendReport, type Report } from './diagnostics';
import { CATEGORIES, SEVERITIES, isCategory, isSeverity, type Category, type Severity } from '../core/report';
import { EmojiPicker } from './EmojiPicker';
import { place } from './place';

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

  loadIdentity().then(setIdentity, (e: unknown) => setIdentityError(e instanceof Error ? e.message : String(e)));

  const select = (secret: string) => { setSelectedRoom(secret); setSelected(secret); };
  /** The room from a link joins the list (or takes the link's name if already known) and comes on screen. */
  const enter = async (list: SavedRoom[], link: InviteLink, via: 'opened' | 'pasted'): Promise<SavedRoom[]> => {
    const known = list.some((r) => r.secret === link.secret);
    const next = await addRoom(list, link);
    select(link.secret);
    posthog.capture('room_entered_by_link', { known, via });
    return next;
  };
  void loadRooms().then(async (list) => setRooms(invite ? await enter(list, invite, 'opened') : list));
  // A link opened in a tab that already shows the app only changes the fragment: no load, so it is read here.
  window.addEventListener('hashchange', () => {
    const link = takeInviteLink();
    const list = rooms();
    if (link && list) void enter(list, link, 'opened').then(setRooms);
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
    return list && list.length > 0 && name() && identity() ? { rooms: list, selected: selected(), created: created(), name: name()!, identity: identity()! } : null;
  });

  return (
    <Switch>
      <Match when={rooms() === null}>
        <Notice title="Loading…"> </Notice>
      </Match>
      <Match when={rooms()?.length === 0}>
        <main class="notice">
          <h1>dave</h1>
          <h2>You need an invite link</h2>
          <p>Open the link a friend sent you, or paste it here. Nothing else gets you in.</p>
          <JoinLinkForm autofocus onJoin={join} />
          <p class="dim">
            Installed on an iPhone or iPad home screen? Tapped links open in Safari, which keeps its rooms to itself, so pasting is the only way in here.
            This copy of the app also starts with its own identity: friends will see you as new.
          </p>
        </main>
      </Match>
      <Match when={!name()}>
        <NameForm onSubmit={rename} />
      </Match>
      <Match when={identityError()}>
        <Notice title="No identity key">This browser could not create or load an identity key ({identityError()}). Private windows and blocked site data cause this.</Notice>
      </Match>
      <Match when={!identity()}>
        <Notice title="Preparing your identity…"> </Notice>
      </Match>
      <Match when={ready()}>{(r) => <Workspace {...r()} onSelect={select} onCreate={create} onJoin={join} onForget={forget} onRename={rename} />}</Match>
    </Switch>
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
    else { setDraft(text); setNote('The clipboard does not hold an invite link.'); }
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
  const identity = untrack(() => props.identity);
  const me = identity.publicKey;
  posthog.identify(me, { fingerprint: identity.fingerprint, ...(isTestAccount ? { $internal_or_test_user: true } : {}) });
  const links = mapArray(() => props.rooms, (saved): Link => {
    // A deliberate one-time snapshot of name and picture: the socket is created once; changes go through `rename` and `setPicture`.
    const room = createRoom({ identity, roomId: saved.id, authKey: saved.authKey, name: untrack(() => props.name), picture: getPicture() });
    const call = createCall(room, identity);
    posthog.capture('room_entered');
    return { saved, room, call };
  });
  createAttention(links, me);
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
  // Shown names that more than one key uses, among everyone present and everyone in the loaded history:
  // only those get their fingerprint next to the name (issue #7).
  const ambiguous = createMemo(() => {
    const present = everyone().map((p) => ({ publicKey: p.publicKey, shown: displayName(p.name, contactOf(p.publicKey)) }));
    const wrote = (current()?.room.lines() ?? []).flatMap((l) => (l.kind === 'text' ? [{ publicKey: l.from.publicKey, shown: displayName(l.from.name, contactOf(l.from.publicKey)) }] : []));
    return ambiguousNames([...present, ...wrote]);
  });
  /** A friend's current presence entry, from any room; a chat line keeps the name and picture they had when they wrote it. */
  const present = (publicKey: string): Person | undefined => everyone().find((p) => p.publicKey === publicKey);
  const currentName = (publicKey: string): string | undefined => present(publicKey)?.name;
  const myName = createMemo(() => currentName(me) ?? props.name);
  /** How this browser shows a friend: the name, whether the fingerprint accompanies it, the picture, and the hover title with the rest. */
  const labelOf = (id: Identity): Label => {
    const c = contactOf(id.publicKey);
    const isMe = id.publicKey === me;
    const now = present(id.publicKey);
    const own = now?.name ?? id.name;
    const shown = displayName(own, c);
    const known = isMe || c !== undefined;
    const ago = knownAgo(c);
    const title = [c?.nick ? `calls themselves ${own}` : null, `fingerprint ${id.fingerprint}`, isMe ? null : ago ? `known since ${ago}` : 'first time this key shows up here'].filter(Boolean).join(' · ');
    return { shown, fp: showsFingerprint(known, shown, ambiguous()), known, title, picture: now ? now.picture : id.picture };
  };
  // The profile card: which friend it is about and the avatar it hangs from. Opening it acknowledges the key.
  const [profile, setProfile] = createSignal<{ publicKey: string; anchor: HTMLElement } | null>(null);
  const openProfile = (p: Person, anchor: HTMLElement) => {
    if (p.publicKey !== me && !isKnown(p.publicKey)) { markKnown(p.publicKey, p.name); posthog.capture('new_key_acknowledged'); }
    setProfile({ publicKey: p.publicKey, anchor });
    posthog.capture('profile_opened', { own: p.publicKey === me });
  };
  // Online: friends who are in none of the calls, across all rooms; you are listed last (spec §7.1).
  const online = createMemo(() => {
    const others = everyone().filter((p) => p.role === 'visitor' && p.publicKey !== me).sort((a, b) => labelOf(a).shown.localeCompare(labelOf(b).shown));
    const self = everyone().find((p) => p.publicKey === me);
    return self && self.role === 'visitor' ? [...others, self] : others;
  });
  const viewOf = (l: Link, key: string): PeerView | undefined => l.call.views().find((v) => v.publicKey === key);
  const [panel, setPanel] = createSignal<'audio' | 'share' | null>(null);
  // Sharers, from the staged room's presence (tiles render from signaling state, never from track events).
  const sharers = createMemo(() => stage()?.room.people().filter((p) => p.role === 'participant' && p.sharing) ?? []);
  // Tiles are keyed by public key, not by Person object: every presence frame (a join, a leave, a mute, a rename)
  // replaces every Person, and a tile recreated for that would lose its video element and its fullscreen.
  const sameKeys = (a: string[], b: string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);
  const sharerKeys = createMemo<string[]>(() => sharers().map((p) => p.publicKey), { equals: sameKeys });
  const sharerOf = (key: string): Person => sharers().find((p) => p.publicKey === key) ?? sharers()[0]!;
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const clash = createMemo(() => everyone().some((p) => p.publicKey !== me && p.name === myName()));
  const connected = () => current()?.room.status().kind === 'connected';
  // Bumped when I send or switch rooms: the log jumps to the newest line (the composer and the log are separate grid items).
  const [jumpToken, setJumpToken] = createSignal(0);
  // The room on screen has nothing unread, however many lines arrive while it is up.
  createEffect(() => ({ link: current(), lines: current()?.room.lines().length }), ({ link }, prev) => {
    link?.room.markRead();
    if (prev && prev.link !== link) setJumpToken((n) => n + 1);
  });
  /** At most one call at a time: joining here leaves the call in another room first. */
  const joinCall = (l: Link) => {
    const a = untrack(active);
    if (a && a !== l) a.call.leave();
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
    void props.onCreate(n).then((room) => { setCreating(false); setRoomDraft(''); setInviteFor(room.secret); }); // the new room needs its link sent around
  };
  const leaveRoom = (l: Link) => {
    if (!confirm(`Leave ${l.saved.name}? This browser forgets the room and its chat history. The invite link gets you back in.`)) return;
    if (untrack(active) === l) l.call.leave(); // say goodbye while the socket is still open, so nobody waits out the grace period
    props.onForget(l.saved.secret); // disposing the room closes its socket
  };

  return (
    <Show when={current()}>{(cur) => (
      <div class={`app ${sharers().length > 0 ? 'split' : ''}`}>
        <div class="scroll">
          <aside class="side">
            <h2>Online</h2>
            <ul class="plist">
              <For each={online()}>{(p) => <PersonRow p={p} isMe={p.publicKey === me} label={labelOf(p)} onProfile={(el) => openProfile(p, el)} />}</For>
              <Show when={online().length === 0}><li class="dim">nobody yet</li></Show>
            </ul>
            <For each={links()}>{(l) => {
              const selected = () => l === cur();
              const inThis = () => l.call.inCall();
              // Call list: you first, then by join order. Participants whose server socket dropped stay listed, dimmed, for the grace period.
              const participants = createMemo(() => {
                const all = l.room.people().filter((p) => p.role === 'participant');
                const self = all.find((p) => p.publicKey === me);
                const others = all.filter((p) => p.publicKey !== me).sort((a, b) => (a.joinSeq ?? 0) - (b.joinSeq ?? 0));
                const lost = l.call.views().filter((v) => v.serverLost && !all.some((p) => p.publicKey === v.publicKey));
                return { self, others, lost };
              });
              const elsewhere = () => { const a = active(); return a && a !== l ? a : null; };
              const inviteOpen = () => inviteFor() === l.saved.secret;
              return (
                <section class={`room ${selected() ? 'selected' : ''} ${l.room.status().kind === 'connected' ? '' : 'frozen'}`}>
                  <div class="room-head">
                    <button class="room-name" onClick={() => props.onSelect(l.saved.secret)} title={selected() ? 'This room is on screen' : `Read ${l.saved.name}`}>
                      <span class="room-title">{l.saved.name}</span>
                      <Show when={l.room.unread() > 0}><b class="unread" title="new messages">{l.room.unread()}</b></Show>
                    </button>
                    <Show when={selected()}><button class={`link ${inviteOpen() ? 'on' : ''}`} title="The link that gets a friend into this room" onClick={() => toggleInvite(l)}>invite</button></Show>
                  </div>
                  <Show when={selected() && inviteOpen()}><InvitePanel link={inviteLinkFor(l.saved)} name={l.saved.name} /></Show>
                  <ul class="plist">
                    <Show when={participants().self}>{(s) => <ParticipantRow p={s()} isMe label={labelOf(s())} onProfile={(el) => openProfile(s(), el)} speaking={l.call.speakingSelf()} />}</Show>
                    <For each={participants().others}>{(p) => <ParticipantRow p={p} isMe={false} label={labelOf(p)} onProfile={(el) => openProfile(p, el)} view={inThis() ? viewOf(l, p.publicKey) : undefined} speaking={viewOf(l, p.publicKey)?.speaking ?? false} onVolume={inThis() ? (v) => l.call.setVolume(p.publicKey, v) : undefined} />}</For>
                    <For each={participants().lost}>{(v) => <li class="lost"><span class="avatar">{displayName(v.name, contactOf(v.publicKey))[0]}</span><span class="pname">{displayName(v.name, contactOf(v.publicKey))} <em>connection to server lost</em></span></li>}</For>
                    <Show when={selected() && !participants().self && participants().others.length === 0}><li class="dim">nobody in the call</li></Show>
                  </ul>
                  <Show when={selected() || inThis()}>
                    <div class="actions">
                      <Show when={!inThis()} fallback={<CallControls call={l.call} panel={panel()} onPanel={setPanel} canShare={canShare} />}>
                        <button class="join" disabled={l.room.status().kind !== 'connected'} title={elsewhere() ? `Leaves the call in ${elsewhere()!.saved.name}` : undefined} onClick={() => joinCall(l)}>Join</button>
                      </Show>
                      <Show when={l.call.joinError()}>{(e) => <div class="warn">{e()}</div>}</Show>
                      <Show when={l.call.shareError()}>{(e) => <div class="warn">{e()}</div>}</Show>
                    </div>
                  </Show>
                </section>
              );
            }}</For>
            <Show when={clash()}>
              <div class="warn">Someone else here is also called {myName()}. Your fingerprint <code>{identity.fingerprint}</code> tells you apart.</div>
            </Show>
            <div class="side-foot">
              <Show when={creating()} fallback={<button class="link" onClick={() => setCreating(true)}>New room</button>}>
                <form class="newroom" onSubmit={createRoomFromDraft}>
                  <input value={roomDraft()} onInput={(e) => setRoomDraft(e.currentTarget.value)} maxlength={MAX_NAME_LENGTH} autofocus placeholder="Room name" aria-label="Name of the new room" />
                  <button class="on" disabled={normaliseRoomName(roomDraft()) === null}>Start</button>
                  <button type="button" onClick={() => setCreating(false)}>Cancel</button>
                </form>
              </Show>
              <Show when={joining()} fallback={<button class="link" title="Enter a room from a pasted invite link" onClick={() => setJoining(true)}>Join by link</button>}>
                <JoinLinkForm autofocus onJoin={(link) => { setJoining(false); props.onJoin(link); }} onCancel={() => setJoining(false)} />
              </Show>
              <button class="link" title="Forget this room in this browser" onClick={() => leaveRoom(cur())}>Leave {cur().saved.name}</button>
              <ReportDialog collect={() => collectReport({ status: () => cur().room.status().kind, people: everyone, me: () => me, call: (active() ?? cur()).call.diagnostics })} />
              <button class="link" title="Only this browser's copy; nothing is stored on the server" onClick={() => { if (confirm(`Clear this browser's chat history of ${cur().saved.name}? Nothing is stored on the server, so this cannot be undone.`)) void cur().room.clearHistory(); }}>Clear chat history</button>
            </div>
          </aside>
          <ProfileCard open={profile()} people={everyone()} me={me} label={labelOf} onClose={() => setProfile(null)} onRenameSelf={renameSelf} onPictureSelf={pictureSelf} />
          <Banner status={cur().room.status()} onTakeOver={() => { for (const l of links()) l.room.takeOver(); }} />
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
                    onVolume={s().call.inCall() ? (v) => s().call.setVolume(key, v) : undefined}
                    onBlack={(element) => void s().call.reportBlackShare(key, element)}
                  />
                )}
              </For>
            </section>
          )}</Show>
          <ChatLog lines={cur().room.lines()} jumpToken={jumpToken()} label={labelOf} />
        </div>
        <Composer connected={connected()} roomName={cur().saved.name} onSend={(text) => { cur().room.sendText(text); setJumpToken((n) => n + 1); }} />
      </div>
    )}</Show>
  );
}

/** The controls while in a call: mute and audio settings, share and share settings, leave. */
function CallControls(props: { call: Call; panel: 'audio' | 'share' | null; onPanel: (p: 'audio' | 'share' | null) => void; canShare: boolean }) {
  const toggle = (p: 'audio' | 'share') => props.onPanel(props.panel === p ? null : p);
  return (
    <>
      <div class="row">
        <button class={props.call.muted() ? 'on' : ''} onClick={() => props.call.setMuted(!props.call.muted())}>{props.call.muted() ? 'Unmute' : 'Mute'}</button>
        <button class={`gear ${props.panel === 'audio' ? 'on' : ''}`} title="Audio settings" onClick={() => { toggle('audio'); void props.call.refreshDevices(); }}>⚙</button>
      </div>
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

/** The invite link of a room, ready to copy. The link is the whole secret: whoever has it is in. */
function InvitePanel(props: { link: string; name: string }) {
  let input: HTMLInputElement | undefined;
  const [state, setState] = createSignal<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try { await navigator.clipboard.writeText(props.link); setState('copied'); posthog.capture('invite_link_copied'); } catch { input?.select(); setState('failed'); }
  };
  return (
    <div class="panel invite">
      <p class="hint">Anyone with this link can enter {props.name}. Send it to friends only.</p>
      <input ref={input} readonly value={props.link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
      <button class="on" onClick={() => void copy()}>{state() === 'copied' ? 'Copied' : 'Copy link'}</button>
      <Show when={state() === 'failed'}><div class="warn">Could not access the clipboard. The link is selected above: copy it yourself.</div></Show>
    </div>
  );
}

/** How a friend is shown here, computed by the Workspace from the address book and who else is around. */
type Label = { shown: string; fp: boolean; known: boolean; title: string; picture?: string };

/** The avatar is the way into a friend's profile card. It shows the profile picture (issue #8), else the initial. */
function Avatar(props: { initial: string; picture?: string; speaking?: boolean; title: string; onOpen: (anchor: HTMLElement) => void }) {
  return <button class={`avatar ${props.picture ? 'pic' : ''} ${props.speaking ? 'speaking' : ''}`} title={props.title} onClick={(e) => { e.stopPropagation(); props.onOpen(e.currentTarget); }}>{props.picture ?? props.initial}</button>;
}

function PersonRow(props: { p: Person; isMe: boolean; label: Label; onProfile: (anchor: HTMLElement) => void }) {
  const acknowledge = () => { if (!props.label.known) { markKnown(props.p.publicKey, props.p.name); posthog.capture('new_key_acknowledged'); } };
  return (
    <li onClick={acknowledge} title={props.label.known ? props.label.title : `${props.label.title}. Click to acknowledge.`}>
      <Avatar initial={props.label.shown[0]!} picture={props.label.picture} title={props.isMe ? 'Your profile' : 'Profile'} onOpen={props.onProfile} />
      <span class="pname"><span class="nm">{props.label.shown}{props.isMe ? ' (you)' : ''}</span> <Show when={props.label.fp}><code class="fp">{props.p.fingerprint}</code></Show>
        <Show when={!props.label.known}><b class="new">new</b></Show>
      </span>
    </li>
  );
}

/**
 * The profile card (issues #6, #7, #8): a popover hanging from the avatar that was clicked, with the name,
 * the fingerprint and since when this browser knows the key, and the edits that fit the person: a
 * friend gets a nickname only this browser shows; you change the name everyone sees and pick your
 * profile picture from the emoji picker, which opens from your own big avatar. Follows presence
 * live, so a friend renaming themselves while the card is open shows up, and closes if they leave.
 */
function ProfileCard(props: { open: { publicKey: string; anchor: HTMLElement } | null; people: Person[]; me: string; label: (id: Identity) => Label; onClose: () => void; onRenameSelf: (name: string) => void; onPictureSelf: (picture: string | null) => void }) {
  let card: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let ownAvatar: HTMLButtonElement | undefined;
  const person = createMemo(() => (props.open ? props.people.find((p) => p.publicKey === props.open!.publicKey) ?? null : null));
  const isMe = () => person()?.publicKey === props.me;
  const contact = () => (person() ? contactOf(person()!.publicKey) : undefined);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const isOpen = () => card?.matches(':popover-open') ?? false;
  createEffect(() => props.open, (o) => {
    if (!card) return;
    if (!o) { if (isOpen()) card.hidePopover(); return; }
    setEditing(false);
    if (!isOpen()) card.showPopover();
    place(card, o.anchor);
  });
  // The friend left (or the socket rebuilt presence without them): nothing to show.
  createEffect(() => props.open !== null && person() === null, (gone) => { if (gone) props.onClose(); });
  const startEdit = () => {
    const p = untrack(person);
    if (!p) return;
    setDraft(untrack(() => (p.publicKey === props.me ? p.name : contactOf(p.publicKey)?.nick ?? '')));
    setEditing(true);
    queueMicrotask(() => input?.select());
  };
  const save = (e: Event) => {
    e.preventDefault();
    const p = untrack(person);
    if (!p) return;
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
    const p = untrack(person);
    if (!p) return;
    setNickname(p.publicKey, p.name, null);
    posthog.capture('friend_renamed', { cleared: true });
    setEditing(false);
  };
  const editTitle = () => (isMe() ? 'Change your name' : contact()?.nick ? 'Change nickname' : 'Give a nickname');
  const picture = () => (person() ? props.label(person()!).picture : undefined);
  const BigAvatar = (p: { of: Person }) => <span class={`avatar big ${picture() ? 'pic' : ''}`}>{picture() ?? props.label(p.of).shown[0]}</span>;
  // Light dismiss (click outside, Escape) closes the popover; the state follows. Clicking another avatar
  // dismisses and reopens in the same task, so only report a close that stuck.
  const onToggle = (e: Event) => { if ((e as ToggleEvent).newState === 'closed' && !isOpen()) props.onClose(); };
  return (
    <div class="profile" popover="auto" ref={card} onToggle={onToggle}>
      <Show when={person()}>{(p) => (
        <>
          <Show when={editing()} fallback={
            <div class="profile-head">
              <Show when={isMe()} fallback={<BigAvatar of={p()} />}>
                <button class={`avatar big own ${picture() ? 'pic' : ''}`} ref={ownAvatar} popovertarget="profile-emoji" title="Choose a profile picture" aria-label="Choose a profile picture">{picture() ?? props.label(p()).shown[0]}</button>
                <EmojiPicker id="profile-emoji" anchor={() => ownAvatar} onPick={(c) => props.onPictureSelf(c)} closeOnPick />
              </Show>
              <div class="profile-names">
                <span class="profile-name">
                  <strong>{props.label(p()).shown}{isMe() ? ' (you)' : ''}</strong>
                  <button class="edit" title={editTitle()} aria-label={editTitle()} onClick={startEdit}>✎</button>
                </span>
                <Show when={!isMe() && contact()?.nick}><span class="dim">calls themselves {p().name}</span></Show>
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
                <BigAvatar of={p()} />
                <input ref={input} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={MAX_NAME_LENGTH} placeholder={isMe() ? 'Your name' : p().name} aria-label={editTitle()} />
              </div>
              <p class="hint">{isMe() ? 'Everyone in the room sees this name, unless they gave you a nickname of their own.' : `Only this browser shows the name you pick. ${p().name} keeps their own name everywhere else.`}</p>
              <div class="row">
                <button class="on" disabled={isMe() && normaliseName(draft()) === null}>Save</button>
                <Show when={!isMe() && contact()?.nick}><button type="button" onClick={useOwnName}>Use their own name</button></Show>
                <button type="button" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </form>
          </Show>
          <dl class="profile-facts">
            <dt>Fingerprint</dt><dd><code>{p().fingerprint}</code></dd>
            <Show when={!isMe()} fallback={<><dt>Identity</dt><dd>this browser's key</dd></>}>
              <dt>Known since</dt><dd title={contact() ? new Date(contact()!.since).toLocaleString() : undefined}>{knownAgo(contact()) ?? 'now'}</dd>
            </Show>
          </dl>
        </>
      )}</Show>
    </div>
  );
}

type Call = ReturnType<typeof createCall>;

function SharePanel(props: { call: Call }) {
  const s = () => props.call.shareSettings();
  const mbps = (bps: number) => (bps / 1_000_000).toFixed(1);
  return (
    <div class="panel">
      <div class="row presets">
        <button class={s().preset === 'detail' ? 'on' : ''} onClick={() => props.call.setPreset('detail')} title="Browsers and documents: native resolution, sharp text">Detail</button>
        <button class={s().preset === 'motion' ? 'on' : ''} onClick={() => props.call.setPreset('motion')} title="Games and video: 60 fps, reduced resolution">Motion</button>
      </div>
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
      <div class={processingIsDefault(a()) ? 'hint' : 'warn'}>
        {processingIsDefault(a()) ? 'Turning these off usually makes you sound worse to others.' : 'Audio processing is off. Turn everything back on if friends complain.'}
      </div>
      <label class="check"><input type="checkbox" checked={a().echoCancellation} onChange={(e) => set({ echoCancellation: e.currentTarget.checked })} /> Echo cancellation</label>
      <label class="check"><input type="checkbox" checked={a().noiseSuppression} onChange={(e) => set({ noiseSuppression: e.currentTarget.checked })} /> Noise suppression</label>
      <label class="check"><input type="checkbox" checked={a().autoGainControl} onChange={(e) => set({ autoGainControl: e.currentTarget.checked })} /> Automatic gain</label>
      <label class="check"><input type="checkbox" checked={props.call.viewerSettings().jitterBufferTargetMs > 0} onChange={(e) => props.call.setViewerSettings({ jitterBufferTargetMs: e.currentTarget.checked ? LOW_LATENCY_MS : 0 })} /> Low latency when watching shares</label>
    </div>
  );
}

const CONN_LABEL: Record<ConnState, string> = { connecting: 'connecting…', direct: 'direct', relayed: 'via relay', reconnecting: 'reconnecting…', unreachable: 'unreachable' };

function ParticipantRow(props: { p: Person; isMe: boolean; label: Label; view?: PeerView; speaking: boolean; onVolume?: (v: number) => void; onProfile: (anchor: HTMLElement) => void }) {
  const [sliderOpen, setSliderOpen] = createSignal(false);
  const volume = () => props.view?.volume ?? 1;
  const percent = () => Math.round(volume() * 100);
  return (
    <li class="prow">
      <Avatar initial={props.label.shown[0]!} picture={props.label.picture} speaking={props.speaking} title={props.isMe ? 'Your profile' : 'Profile'} onOpen={props.onProfile} />
      <span class="pname" title={props.label.title}><span class="nm">{props.label.shown}{props.isMe ? ' (you)' : ''}</span> <Show when={props.label.fp}><code class="fp">{props.p.fingerprint}</code></Show></span>
      <span class="pflags">
        <Show when={props.p.muted}><em>muted</em></Show>
        <Show when={props.p.sharing}><em>sharing</em></Show>
        <Show when={props.view}>{(v) => <span class={`conn conn-${v().conn}`} title={CONN_LABEL[v().conn]}><i />{CONN_LABEL[v().conn]}</span>}</Show>
        <Show when={props.onVolume && props.view}>
          <button class={`vol ${percent() !== 100 ? 'on' : ''}`} title={`Volume for you: ${percent()}%`} onClick={() => setSliderOpen(!sliderOpen())}>
            {percent() === 0 ? '🔇' : '🔊'}<Show when={percent() !== 100}><small>{percent()}%</small></Show>
          </button>
        </Show>
      </span>
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
  const state = () => {
    if (props.isMe) return 'own';
    if (!props.inCall) return 'locked';
    if (props.view?.conn === 'unreachable') return 'unreachable';
    if (!props.view?.watching) return 'closed';
    return props.view.shareLive ? 'live' : 'opening';
  };
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
  const percent = () => Math.round((props.view?.volume ?? 1) * 100);
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
          <Show when={fullscreen() && props.onVolume}>
            <label class="share-vol" title="Volume for you, double-click to reset">
              <span>{percent() === 0 ? '🔇' : '🔊'}</span>
              <input type="range" min="0" max={MAX_VOLUME * 100} step="5" value={percent()} onInput={(e) => props.onVolume?.(Number(e.currentTarget.value) / 100)} onDblClick={() => props.onVolume?.(1)} />
              <span>{percent()}%</span>
            </label>
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
      <Match when={props.status.kind === 'reconnecting'}><div class="banner banner-warn">Reconnecting to server… voice and shares continue, chat is paused</div></Match>
      <Match when={props.status.kind === 'unavailable'}><div class="banner banner-bad">Server unavailable, retrying. Voice and shares continue.</div></Match>
      <Match when={props.status.kind === 'refused' && props.status}>{(s) => <div class="banner banner-bad">Refused: {s().reason}. Ask for a fresh invite link.</div>}</Match>
    </Switch>
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
        <p class="hint">Your description is sent to this room's error log together with a technical snapshot of your connection: states and counters, never message texts or names. The last minutes of this tab are already kept as a masked session replay.</p>
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

/** Fullscreen overlays hide this long after the pointer last moved. */
const OVERLAY_HIDE_MS = 2500;

/** Clock time on a 24-hour clock; older than a day also says which day. */
const when = (at: number): string => new Date(at).toLocaleString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(Date.now() - at > 20 * 3600 * 1000 ? { day: '2-digit', month: 'short' } : {}) });

/**
 * The message input. A separate grid item from the log so phones can keep it as the bottom row of the screen.
 * The emoji button opens the picker (issue #3); a pick lands at the caret and the picker stays for the next one.
 */
function Composer(props: { connected: boolean; roomName: string; onSend: (text: string) => void }) {
  const [draft, setDraft] = createSignal('');
  let input: HTMLInputElement | undefined;
  let emojiButton: HTMLButtonElement | undefined;
  const submit = (e: Event) => {
    e.preventDefault();
    const text = draft().trim();
    if (!text || !props.connected) return;
    props.onSend(text);
    setDraft('');
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
  return (
    <form class="chat-input" onSubmit={submit}>
      <button type="button" class="emoji-open" ref={emojiButton} popovertarget="composer-emoji" disabled={!props.connected} title="Emoji" aria-label="Emoji">🙂</button>
      <EmojiPicker id="composer-emoji" anchor={() => emojiButton} onPick={insert} />
      <input ref={input} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} disabled={!props.connected} maxlength={MAX_TEXT_LENGTH}
             placeholder={props.connected ? `Message ${props.roomName}` : "Can't send while disconnected"} />
      <button disabled={!props.connected || !draft().trim()}>Send</button>
    </form>
  );
}

/** The log with the new-messages pill. `jumpToken` changes when I send, which brings me back to the newest line. */
function ChatLog(props: { lines: ChatLine[]; jumpToken: number; label: (id: Identity) => Label }) {
  let log: HTMLDivElement | undefined;
  // The log is a reversed flex column (newest line first in the DOM, drawn at the bottom), so the
  // scroll origin is the bottom edge: position 0 is "at the newest line" and the browser keeps that
  // offset when lines arrive or the log changes size. The browser's own scroll anchoring is off (CSS):
  // it measures from the top edge, which is the edge that moves when a share strip comes or goes, and
  // it snapped a scrolled-up reader to the bottom. The one thing it did for us, holding a scrolled-up
  // reader in place when a new line pushes everything up, is the two lines in the effect below.
  const newestFirst = createMemo(() => [...props.lines].reverse());
  let atBottom = true;
  let contentHeight = 0; // scrollHeight at the last scroll or line change
  const [unseen, setUnseen] = createSignal(false);
  const onScroll = () => { if (!log) return; atBottom = Math.abs(log.scrollTop) < 8; contentHeight = log.scrollHeight; if (atBottom) setUnseen(false); };
  // Block bodies on purpose: an effect callback's return value is taken as a cleanup, and browser
  // extensions that hook scrolling make scrollTo return a value, which halted the whole page once.
  const jump = () => { log?.scrollTo({ top: 0 }); setUnseen(false); };
  createEffect(() => props.lines.length, (n, prev) => {
    if (!log) return;
    if (prev !== undefined && n > prev && !atBottom) {
      log.scrollTop -= log.scrollHeight - contentHeight; // scrollTop is negative here: further up by the added height
      setUnseen(true);
    }
    contentHeight = log.scrollHeight;
  });
  createEffect(() => props.jumpToken, (t, prev) => { if (prev !== undefined && t !== prev) jump(); });
  return (
    <div class="chat">
      <div class="chat-log" ref={log} onScroll={onScroll}>
        <For each={newestFirst()}>
          {(l) => (
            <Switch>
              <Match when={l.kind === 'system' && l}>{(s) => <div class="msg msg-sys"><span class="msg-text">{s().text}</span><span class="msg-at">{when(s().at)}</span></div>}</Match>
              <Match when={l.kind === 'text' && l}>
                {(m) => (
                  <div class="msg">
                    <span class="msg-from" title={props.label(m().from).title}>{props.label(m().from).shown} <Show when={props.label(m().from).fp}><code class="fp">{m().from.fingerprint}</code></Show></span>
                    <span class="msg-at">{when(m().at)}</span>
                    <div class="msg-text"><Linkified text={m().text} /></div>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
      <Show when={unseen()}><button class="chat-new" onClick={jump} title="Scroll to the newest message">new messages ↓</button></Show>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function Linkified(props: { text: string }) {
  const parts = createMemo(() => props.text.split(URL_RE));
  // Odd indices are the URLs captured by the split. Reading i() inside JSX keeps it tracked.
  return <For each={parts()}>{(part, i) => <Show when={i() % 2 === 1} fallback={<>{part}</>}><a href={part} target="_blank" rel="noopener noreferrer">{part}</a></Show>}</For>;
}
