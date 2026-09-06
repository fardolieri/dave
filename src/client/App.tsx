import { createSignal, Switch, Match, createMemo, onCleanup } from 'solid-js';
import { loadIdentity, type LocalIdentity } from './identity';
import { getName, getSecret, setName, takeSecretFromInviteLink } from './invite';
import { connect, type ConnectionStatus } from './connection';
import { normaliseName } from '../core/protocol';

// Ticket 02: gate and identity. Presence and chat arrive with ticket 03.
export default function App() {
  takeSecretFromInviteLink();
  const [secret] = createSignal(getSecret());
  const [name, setNameSignal] = createSignal(getName());
  const [identity, setIdentity] = createSignal<LocalIdentity | null>(null);
  const [identityError, setIdentityError] = createSignal<string | null>(null);

  loadIdentity().then(setIdentity, (e: unknown) => setIdentityError(e instanceof Error ? e.message : String(e)));

  const ready = createMemo(() => (secret() && name() && identity() ? { secret: secret()!, name: name()!, identity: identity()! } : null));

  return (
    <main style="font-family: system-ui; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
      <h1>dave</h1>
      <Switch>
        <Match when={!secret()}>
          <p>You need an invite link from a friend to get in. Open the link they sent you; nothing else works.</p>
        </Match>
        <Match when={!name()}>
          <NameForm onSubmit={(n) => { setName(n); setNameSignal(n); }} />
        </Match>
        <Match when={identityError()}>
          <p style="color: #c33">This browser could not create or load an identity key ({identityError()}). Private windows and blocked site data cause this.</p>
        </Match>
        <Match when={!identity()}>
          <p>Preparing your identity…</p>
        </Match>
        <Match when={ready()}>{(r) => <Gate {...r()} />}</Match>
      </Switch>
    </main>
  );
}

// Owns the socket: a component body runs once, so `connect` is called exactly once.
function Gate(props: { secret: string; name: string; identity: LocalIdentity }) {
  const conn = connect({ secret: props.secret, name: props.name, identity: props.identity });
  onCleanup(conn.close);
  return <Status status={conn.status()} identity={props.identity} name={props.name} />;
}

function NameForm(props: { onSubmit: (name: string) => void }) {
  const [draft, setDraft] = createSignal('');
  const valid = () => normaliseName(draft()) !== null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); const n = normaliseName(draft()); if (n) props.onSubmit(n); }}>
      <p>What should your friends call you?</p>
      <input value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={32} autofocus placeholder="Your name" />
      <button disabled={!valid()}>Continue</button>
      <p style="color: #888; font-size: 0.9em">Names are not unique. A six-character fingerprint derived from this browser's key tells friends apart.</p>
    </form>
  );
}

function Status(props: { status: ConnectionStatus; identity: LocalIdentity; name: string }) {
  return (
    <Switch>
      <Match when={props.status.kind === 'connecting' || props.status.kind === 'authenticating'}>
        <p>Connecting as {props.name} <code>{props.identity.fingerprint}</code>…</p>
      </Match>
      <Match when={props.status.kind === 'connected'}>
        <p>You are in. <b>{props.name}</b> <code>{props.identity.fingerprint}</code></p>
        <details><summary style="color: #888">your identity key</summary><code style="word-break: break-all">{props.identity.publicKey}</code></details>
      </Match>
      <Match when={props.status.kind === 'refused' && props.status}>
        {(s) => <p style="color: #c33">Refused: {s().reason}. Ask for a fresh invite link.</p>}
      </Match>
      <Match when={props.status.kind === 'closed' && props.status}>
        {(s) => <p style="color: #c33">Disconnected: {s().reason || 'connection closed'}.</p>}
      </Match>
    </Switch>
  );
}
