import { local } from './storage';

// The invite link carries the shared secret in the URL fragment, which browsers
// never send to the server. Store it on first load and strip it from the address
// bar at once, so a screenshared browser does not leak it.
export function takeSecretFromInviteLink(): void {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hash) return;
  local.set('secret', decodeURIComponent(hash));
  history.replaceState(null, '', location.pathname + location.search);
}

export const getSecret = (): string | null => local.get('secret');
export const getName = (): string | null => local.get('name');
export const setName = (name: string): void => local.set('name', name);
