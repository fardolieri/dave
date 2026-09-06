import { render } from '@solidjs/web';
import App from './App';
import posthog from './posthog';

// If the reactive system halts (an uncaught error inside an effect), the page silently stops updating.
// Say so, loudly, with a reload, and keep the error visible in the console.
function showCrash(reason: unknown): void {
  if (document.getElementById('crash')) return;
  posthog.capture('reactivity_halted', { message: reason instanceof Error ? reason.message : String(reason) });
  const bar = document.createElement('div');
  bar.id = 'crash';
  bar.setAttribute('style', 'position:fixed;left:0;right:0;top:0;z-index:1000;background:#7a1f1f;color:#fff;padding:10px 14px;font:14px system-ui;display:flex;gap:12px;align-items:center');
  const text = document.createElement('span');
  text.textContent = `Something broke and the page stopped updating: ${reason instanceof Error ? reason.message : String(reason)}`;
  const button = document.createElement('button');
  button.textContent = 'Reload';
  button.setAttribute('style', 'margin-left:auto;padding:6px 12px;border-radius:8px;border:0;cursor:pointer');
  button.onclick = () => location.reload();
  bar.append(text, button);
  document.body.prepend(bar);
}
window.addEventListener('error', (e) => { if (String(e.message).includes('REACTIVITY_HALTED') || e.error) showCrash(e.error ?? e.message); });
window.addEventListener('unhandledrejection', (e) => { if (String(e.reason).includes('REACTIVITY_HALTED')) showCrash(e.reason); });

render(() => <App />, document.getElementById('app')!);
