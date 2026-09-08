import { createSignal, Switch, Match, createMemo, createEffect, For, Show, untrack } from 'solid-js';
import './styles.css';
import posthog from './posthog';
import { loadIdentity, type LocalIdentity } from './identity';
import { getName, getSecret, setName, takeSecretFromInviteLink } from './invite';
import { createRoom, type ChatLine, type ServerStatus } from './room';
import { createCall, type ConnState, type PeerView } from './call';
import { createAttention } from './attention';
import { isKnown, markKnown } from './seenKeys';
import { MAX_TEXT_LENGTH, normaliseName, type Person } from '../core/protocol';
import { LOW_LATENCY_MS, MAX_VOLUME, mbpsToBps, processingIsDefault, type AudioSettings, type Degradation, type FrameRate, type MaxHeight } from '../core/settings';

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
      <form onSubmit={(e) => { e.preventDefault(); const n = normaliseName(draft()); if (n) { posthog.capture('name_set'); props.onSubmit(n); } }}>
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
  // Pseudonymous identity for analytics: the public key, nothing personal. One-time read on purpose.
  posthog.identify(untrack(() => props.identity.publicKey));
  posthog.capture('room_entered');
  // A deliberate one-time snapshot: the socket is created once with the props at mount.
  const room = createRoom(untrack(() => ({ secret: props.secret, name: props.name, identity: props.identity })));
  const me = () => props.identity.publicKey;
  const call = createCall(room, untrack(me));
  createAttention(room, call, untrack(me));
  const online = createMemo(() => {
    const others = room.people().filter((p) => p.role === 'visitor' && p.publicKey !== me()).sort((a, b) => a.name.localeCompare(b.name));
    const self = room.people().find((p) => p.publicKey === me());
    return self && self.role === 'visitor' ? [...others, self] : others; // you are listed last in Online (spec §7.1)
  });
  // Call list: you first, then by join order. Participants whose server socket dropped stay listed, dimmed, for the grace period.
  const inCallList = createMemo(() => {
    const participants = room.people().filter((p) => p.role === 'participant');
    const self = participants.find((p) => p.publicKey === me());
    const others = participants.filter((p) => p.publicKey !== me()).sort((a, b) => (a.joinSeq ?? 0) - (b.joinSeq ?? 0));
    const lost = call.views().filter((v) => v.serverLost && !participants.some((p) => p.publicKey === v.publicKey));
    return { self, others, lost };
  });
  const viewOf = (key: string): PeerView | undefined => call.views().find((v) => v.publicKey === key);
  const [panel, setPanel] = createSignal<'audio' | 'share' | null>(null);
  const callExists = () => inCallList().others.length > 0 || inCallList().self !== undefined;
  // Sharers, from presence (tiles render from signaling state, never from track events).
  const sharers = createMemo(() => room.people().filter((p) => p.role === 'participant' && p.sharing));
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
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
            <For each={inCallList().others}>{(p) => <ParticipantRow p={p} isMe={false} view={call.inCall() ? viewOf(p.publicKey) : undefined} speaking={viewOf(p.publicKey)?.speaking ?? false} onVolume={call.inCall() ? (v) => call.setVolume(p.publicKey, v) : undefined} />}</For>
            <For each={inCallList().lost}>{(v) => <li class="lost"><span class="avatar">{v.name[0]}</span><span class="pname">{v.name} <em>connection to server lost</em></span></li>}</For>
          </ul>
          <div class="actions">
            <Show when={!call.inCall()} fallback={
              <>
                <Show when={call.connecting()}>
                  <div class={call.slowConnect() ? 'warn' : 'hint'}>
                    {call.slowConnect() ? 'Still connecting. The first join can take a few seconds.' : 'Connecting…'}
                  </div>
                </Show>
                <div class="row">
                  <button class={call.muted() ? 'on' : ''} onClick={() => call.setMuted(!call.muted())}>{call.muted() ? 'Unmute' : 'Mute'}</button>
                  <button class={`gear ${panel() === 'audio' ? 'on' : ''}`} title="Audio settings" onClick={() => { setPanel(panel() === 'audio' ? null : 'audio'); void call.refreshDevices(); }}>⚙</button>
                </div>
                <Show when={panel() === 'audio'}><AudioPanel call={call} /></Show>
                <Show when={canShare} fallback={<div class="hint">Screen sharing is not available on this device</div>}>
                  <div class="row">
                    <button class={call.sharing() ? 'on' : ''} onClick={() => void (call.sharing() ? call.stopShare() : call.startShare())}>{call.sharing() ? 'Stop sharing' : 'Share screen'}</button>
                    <button class={`gear ${panel() === 'share' ? 'on' : ''}`} title="Share settings" onClick={() => setPanel(panel() === 'share' ? null : 'share')}>⚙</button>
                  </div>
                </Show>
                <Show when={panel() === 'share'}><SharePanel call={call} /></Show>
                <button class="leave" onClick={call.leave}>Leave</button>
              </>
            }>
              <button class="join" disabled={!connected()} onClick={() => void call.join()}>Join</button>
            </Show>
            <Show when={call.joinError()}>{(e) => <div class="warn">{e()}</div>}</Show>
            <Show when={call.shareError()}>{(e) => <div class="warn">{e()}</div>}</Show>
          </div>
          <Show when={clash()}>
            <div class="warn">Someone else here is also called {props.name}. Your fingerprint <code>{props.identity.fingerprint}</code> tells you apart.</div>
          </Show>
        </aside>
        <main class={`main ${sharers().length > 0 ? 'split' : ''}`}>
          <Show when={sharers().length > 0}>
            <section class="shares" style={`grid-template-columns: repeat(${sharers().length}, 1fr)`}>
              <For each={sharers()}>
                {(p) => (
                  <ShareTile
                    p={p}
                    isMe={p.publicKey === me()}
                    inCall={call.inCall()}
                    view={viewOf(p.publicKey)}
                    stream={p.publicKey === me() ? call.sharing() ?? undefined : call.shareStreamOf(p.publicKey)}
                    onToggle={() => call.watch(p.publicKey, !viewOf(p.publicKey)?.watching)}
                    onFullscreen={() => call.watchOnly(p.publicKey)}
                  />
                )}
              </For>
            </section>
          </Show>
          <Chat lines={room.lines()} connected={connected()} onSend={room.sendText} onClear={() => void room.clearHistory()} />
        </main>
      </div>
    </div>
  );
}

function PersonRow(props: { p: Person; isMe: boolean }) {
  // One-time snapshot on purpose: whether this key was known when the row appeared.
  const [known, setKnown] = createSignal(untrack(() => props.isMe || isKnown(props.p.publicKey)));
  const acknowledge = () => { if (!known()) { markKnown(props.p.publicKey, props.p.name); setKnown(true); posthog.capture('new_key_acknowledged'); } };
  return (
    <li onClick={acknowledge} title={known() ? undefined : 'First time this key shows up here. Click to acknowledge.'}>
      <span class="avatar">{props.p.name[0]}</span>
      <span class="pname"><span class="nm" title={props.p.name}>{props.p.name}{props.isMe ? ' (you)' : ''}</span> <code class="fp">{props.p.fingerprint}</code>
        <Show when={!known()}><b class="new">new</b></Show>
      </span>
    </li>
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

function ParticipantRow(props: { p: Person; isMe: boolean; view?: PeerView; speaking: boolean; onVolume?: (v: number) => void }) {
  const [sliderOpen, setSliderOpen] = createSignal(false);
  const volume = () => props.view?.volume ?? 1;
  const percent = () => Math.round(volume() * 100);
  return (
    <li class="prow">
      <span class={`avatar ${props.speaking ? 'speaking' : ''}`}>{props.p.name[0]}</span>
      <span class="pname" title={`${props.p.name} ${props.p.fingerprint}`}><span class="nm">{props.p.name}{props.isMe ? ' (you)' : ''}</span> <code class="fp">{props.p.fingerprint}</code></span>
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

function ShareTile(props: { p: Person; isMe: boolean; inCall: boolean; view?: PeerView; stream?: MediaStream; onToggle: () => void; onFullscreen: () => void }) {
  let video: HTMLVideoElement | undefined;
  // Mirror the stream into the element; never read state off the media object in JSX (spec §2.1).
  createEffect(() => props.stream, (stream) => { if (video && video.srcObject !== (stream ?? null)) video.srcObject = stream ?? null; });
  const state = () => {
    if (props.isMe) return 'own';
    if (!props.inCall) return 'locked';
    if (props.view?.conn === 'unreachable') return 'unreachable';
    if (!props.view?.watching) return 'closed';
    return props.view.shareLive ? 'live' : 'opening';
  };
  const showsVideo = () => state() === 'live' || state() === 'own';
  const goFullscreen = (e: MouseEvent) => {
    e.stopPropagation();
    props.onFullscreen(); // subscribes to this share if needed and drops the others
    const el = video as (HTMLVideoElement & { webkitRequestFullscreen?: () => Promise<void> }) | undefined;
    (el?.requestFullscreen?.() ?? el?.webkitRequestFullscreen?.())?.catch(() => {});
  };
  return (
    <div class={`share share-${state()}`} onClick={() => { if (!props.isMe && props.inCall) props.onToggle(); }}>
      <div class="share-head">
        <span>{props.isMe ? 'Your screen' : `${props.p.name}'s screen`}</span>
        <Show when={!props.isMe && props.view ? props.view : undefined}>{(v) => <span class={`conn conn-${v().conn}`}><i />{CONN_LABEL[v().conn]}</span>}</Show>
        <Show when={state() !== 'locked' && state() !== 'unreachable'}><button class="fs" title="Fullscreen" onClick={goFullscreen}>⛶</button></Show>
      </div>
      <video ref={video} autoplay playsinline muted hidden={!showsVideo()} />
      <Switch>
        <Match when={state() === 'locked'}><div class="share-note">Join to watch</div></Match>
        <Match when={state() === 'closed'}><div class="share-note">Click to watch</div></Match>
        <Match when={state() === 'opening'}><div class="share-note"><span class="spinner" /> Opening…</div></Match>
        <Match when={state() === 'unreachable'}><div class="share-note">No connection to {props.p.name}</div></Match>
        <Match when={state() === 'live' && props.view}>{(v) => <div class="share-caption">{v().shareKbps} kbps · {CONN_LABEL[v().conn]}</div>}</Match>
        <Match when={state() === 'own'}><div class="share-caption">you are sharing</div></Match>
      </Switch>
    </div>
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

function Chat(props: { lines: ChatLine[]; connected: boolean; onSend: (text: string) => void; onClear: () => void }) {
  const [draft, setDraft] = createSignal('');
  let log: HTMLDivElement | undefined;
  const submit = (e: Event) => {
    e.preventDefault();
    const text = draft().trim();
    if (!text || !props.connected) return;
    props.onSend(text);
    setDraft('');
  };
  // keep the newest line in view: compute phase tracks the length, apply phase touches the DOM.
  // Block body on purpose: an effect callback's return value is taken as a cleanup, and browser
  // extensions that hook scrolling make scrollTo return a value, which halted the whole page once.
  createEffect(() => props.lines.length, () => { log?.scrollTo({ top: log.scrollHeight }); });
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
                    <span class="msg-at">{new Date(m().at).toLocaleString([], { hour: '2-digit', minute: '2-digit', ...(Date.now() - m().at > 20 * 3600 * 1000 ? { day: '2-digit', month: 'short' } : {}) })}</span>
                    <div class="msg-text"><Linkified text={m().text} /></div>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
      <Show when={props.lines.some((l) => l.kind === 'text')}>
        <div class="chat-tools"><button class="link" onClick={props.onClear} title="Only this browser's copy; nothing is stored on the server">clear history</button></div>
      </Show>
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
