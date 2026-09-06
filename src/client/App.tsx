import { createSignal, Switch, Match, createMemo, createEffect, For, Show, untrack } from 'solid-js';
import './styles.css';
import { loadIdentity, type LocalIdentity } from './identity';
import { getName, getSecret, setName, takeSecretFromInviteLink } from './invite';
import { createRoom, type ChatLine, type ServerStatus } from './room';
import { createCall, type ConnState, type PeerView } from './call';
import { isKnown, markKnown } from './seenKeys';
import { MAX_TEXT_LENGTH, normaliseName, type Person } from '../core/protocol';

export default function App() {
  takeSecretFromInviteLink();
  const [secret] = createSignal(getSecret());
  const [name, setNameSignal] = createSignal(getName());
  const [identity, setIdentity] = createSignal<LocalIdentity | null>(null);
  const [identityError, setIdentityError] = createSignal<string | null>(null);

  loadIdentity().then(setIdentity, (e: unknown) => setIdentityError(e instanceof Error ? e.message : String(e)));

  const ready = createMemo(() => (secret() && name() && identity() ? { secret: secret()!, name: name()!, identity: identity()! } : null));

  return (
    <Switch>
      <Match when={!secret()}>
        <Notice title="You need an invite link">Open the link a friend sent you. Nothing else gets you in.</Notice>
      </Match>
      <Match when={!name()}>
        <NameForm onSubmit={(n) => { setName(n); setNameSignal(n); }} />
      </Match>
      <Match when={identityError()}>
        <Notice title="No identity key">This browser could not create or load an identity key ({identityError()}). Private windows and blocked site data cause this.</Notice>
      </Match>
      <Match when={!identity()}>
        <Notice title="Preparing your identity…"> </Notice>
      </Match>
      <Match when={ready()}>{(r) => <RoomView {...r()} />}</Match>
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
      <form onSubmit={(e) => { e.preventDefault(); const n = normaliseName(draft()); if (n) props.onSubmit(n); }}>
        <p>What should your friends call you?</p>
        <input value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={32} autofocus placeholder="Your name" />
        <button disabled={!valid()}>Continue</button>
        <p class="dim">Names are not unique. A six-character fingerprint derived from this browser's key tells friends apart.</p>
      </form>
    </main>
  );
}

// Owns the socket: a component body runs once, so `createRoom` is called exactly once.
function RoomView(props: { secret: string; name: string; identity: LocalIdentity }) {
  // A deliberate one-time snapshot: the socket is created once with the props at mount.
  const room = createRoom(untrack(() => ({ secret: props.secret, name: props.name, identity: props.identity })));
  const me = () => props.identity.publicKey;
  const call = createCall(room, untrack(me));
  const online = createMemo(() => {
    const others = room.people().filter((p) => p.role === 'visitor' && p.publicKey !== me()).sort((a, b) => a.name.localeCompare(b.name));
    const self = room.people().find((p) => p.publicKey === me());
    return self && self.role === 'visitor' ? [...others, self] : others; // you are listed last in Online (spec §7.1)
  });
  // Call list: you first, then by join order. Peers whose server socket dropped stay listed, dimmed, for the grace period.
  const inCallList = createMemo(() => {
    const participants = room.people().filter((p) => p.role === 'participant');
    const self = participants.find((p) => p.publicKey === me());
    const others = participants.filter((p) => p.publicKey !== me()).sort((a, b) => (a.joinSeq ?? 0) - (b.joinSeq ?? 0));
    const lost = call.views().filter((v) => v.serverLost && !participants.some((p) => p.publicKey === v.publicKey));
    return { self, others, lost };
  });
  const viewOf = (key: string): PeerView | undefined => call.views().find((v) => v.publicKey === key);
  const callExists = () => inCallList().others.length > 0 || inCallList().self !== undefined;
  const clash = createMemo(() => room.people().some((p) => p.publicKey !== me() && p.name === props.name));
  const connected = () => room.status().kind === 'connected';

  return (
    <div class="app">
      <Banner status={room.status()} />
      <div class="cols">
        <aside class={`side ${connected() ? '' : 'frozen'}`}>
          <h2>Online</h2>
          <ul class="plist">
            <For each={online()}>{(p) => <PersonRow p={p} isMe={p.publicKey === me()} />}</For>
            <Show when={online().length === 0}><li class="dim">nobody yet</li></Show>
          </ul>
          <h2>Call <Show when={!callExists()}><small class="dim">nobody in the call</small></Show></h2>
          <ul class="plist">
            <Show when={inCallList().self}>{(s) => <ParticipantRow p={s()} isMe speaking={call.speakingSelf()} />}</Show>
            <For each={inCallList().others}>{(p) => <ParticipantRow p={p} isMe={false} view={call.inCall() ? viewOf(p.publicKey) : undefined} speaking={viewOf(p.publicKey)?.speaking ?? false} />}</For>
            <For each={inCallList().lost}>{(v) => <li class="lost"><span class="avatar">{v.name[0]}</span><span class="pname">{v.name} <em>connection to server lost</em></span></li>}</For>
          </ul>
          <div class="actions">
            <Show when={!call.inCall()} fallback={
              <>
                <button class={call.muted() ? 'on' : ''} onClick={() => call.setMuted(!call.muted())}>{call.muted() ? 'Unmute' : 'Mute'}</button>
                <button class="leave" onClick={call.leave}>Leave</button>
              </>
            }>
              <button class="join" disabled={!connected()} onClick={() => void call.join()}>Join</button>
            </Show>
            <Show when={call.joinError()}>{(e) => <div class="warn">{e()}</div>}</Show>
          </div>
          <Show when={clash()}>
            <div class="warn">Someone else here is also called {props.name}. Your fingerprint <code>{props.identity.fingerprint}</code> tells you apart.</div>
          </Show>
        </aside>
        <main class="main">
          <Chat lines={room.lines()} connected={connected()} onSend={room.sendText} />
        </main>
      </div>
    </div>
  );
}

function PersonRow(props: { p: Person; isMe: boolean }) {
  // One-time snapshot on purpose: whether this key was known when the row appeared.
  const [known, setKnown] = createSignal(untrack(() => props.isMe || isKnown(props.p.publicKey)));
  const acknowledge = () => { if (!known()) { markKnown(props.p.publicKey, props.p.name); setKnown(true); } };
  return (
    <li onClick={acknowledge} title={known() ? undefined : 'First time this key shows up here. Click to acknowledge.'}>
      <span class="avatar">{props.p.name[0]}</span>
      <span class="pname">{props.p.name}{props.isMe ? ' (you)' : ''} <code class="fp">{props.p.fingerprint}</code>
        <Show when={!known()}><b class="new">new</b></Show>
      </span>
    </li>
  );
}

const CONN_LABEL: Record<ConnState, string> = { connecting: 'connecting…', direct: 'direct', relayed: 'via relay', reconnecting: 'reconnecting…', unreachable: 'unreachable' };

function ParticipantRow(props: { p: Person; isMe: boolean; view?: PeerView; speaking: boolean }) {
  return (
    <li>
      <span class={`avatar ${props.speaking ? 'speaking' : ''}`}>{props.p.name[0]}</span>
      <span class="pname">{props.p.name}{props.isMe ? ' (you)' : ''} <code class="fp">{props.p.fingerprint}</code></span>
      <span class="pflags">
        <Show when={props.p.muted}><em>muted</em></Show>
        <Show when={props.view}>{(v) => <span class={`conn conn-${v().conn}`} title={CONN_LABEL[v().conn]}><i />{CONN_LABEL[v().conn]}</span>}</Show>
      </span>
    </li>
  );
}

function Banner(props: { status: ServerStatus }) {
  return (
    <Switch>
      <Match when={props.status.kind === 'connecting'}><div class="banner banner-warn">Connecting…</div></Match>
      <Match when={props.status.kind === 'reconnecting'}><div class="banner banner-warn">Reconnecting to server… voice and shares continue, chat is paused</div></Match>
      <Match when={props.status.kind === 'unavailable'}><div class="banner banner-bad">Server unavailable, retrying. Voice and shares continue.</div></Match>
      <Match when={props.status.kind === 'refused' && props.status}>{(s) => <div class="banner banner-bad">Refused: {s().reason}. Ask for a fresh invite link.</div>}</Match>
    </Switch>
  );
}

function Chat(props: { lines: ChatLine[]; connected: boolean; onSend: (text: string) => void }) {
  const [draft, setDraft] = createSignal('');
  let log: HTMLDivElement | undefined;
  const submit = (e: Event) => {
    e.preventDefault();
    const text = draft().trim();
    if (!text || !props.connected) return;
    props.onSend(text);
    setDraft('');
  };
  // keep the newest line in view: compute phase tracks the length, apply phase touches the DOM
  createEffect(() => props.lines.length, () => log?.scrollTo({ top: log.scrollHeight }));
  return (
    <div class="chat">
      <div class="chat-log" ref={log}>
        <For each={props.lines}>
          {(l) => (
            <Switch>
              <Match when={l.kind === 'system' && l}>{(s) => <div class="msg-sys">{s().text}</div>}</Match>
              <Match when={l.kind === 'text' && l}>
                {(m) => (
                  <div class="msg">
                    <span class="msg-from">{m().from.name} <code class="fp">{m().from.fingerprint}</code></span>
                    <span class="msg-at">{new Date(m().at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <div class="msg-text"><Linkified text={m().text} /></div>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
      <form class="chat-input" onSubmit={submit}>
        <input value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} disabled={!props.connected} maxlength={MAX_TEXT_LENGTH}
               placeholder={props.connected ? 'Message the room' : "Can't send while disconnected"} />
        <button disabled={!props.connected || !draft().trim()}>Send</button>
      </form>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function Linkified(props: { text: string }) {
  const parts = createMemo(() => props.text.split(URL_RE));
  // Odd indices are the URLs captured by the split. Reading i() inside JSX keeps it tracked.
  return <For each={parts()}>{(part, i) => <Show when={i() % 2 === 1} fallback={<>{part}</>}><a href={part} target="_blank" rel="noopener noreferrer">{part}</a></Show>}</For>;
}
