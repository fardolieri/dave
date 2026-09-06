import { createSignal, onCleanup } from 'solid-js';
import type { ClientMessage, ServerMessage } from '../core/protocol';

// Skeleton page: proves the SPA is served and a WebSocket round-trips through the Room.
export default function App() {
  const [status, setStatus] = createSignal('connecting…');
  const [echo, setEcho] = createSignal<string | null>(null);

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  ws.onopen = () => {
    setStatus('connected');
    send({ t: 'echo', text: `hello from ${navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chromium'}` });
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    if (m.t === 'echo') setEcho(m.text);
  };
  ws.onclose = () => setStatus('closed');
  ws.onerror = () => setStatus('error');
  onCleanup(() => ws.close());

  return (
    <main style="font-family: system-ui; padding: 2rem">
      <h1>dave</h1>
      <p>socket: {status()}</p>
      <p>room says: {echo() ?? '…'}</p>
    </main>
  );
}
