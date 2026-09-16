import { formatInviteFragment, parseInviteFragment, type InviteLink } from '../core/rooms';
import { local } from './storage';
import { normalisePicture } from '../core/protocol';

// The invite link carries the room's secret and name in the URL fragment, which browsers never send to
// the server. It is read on first load and stripped from the address bar at once, so a screenshared
// browser does not leak it.
export function takeInviteLink(): InviteLink | null {
  const link = parseInviteFragment(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return link;
}

/** The link to send a friend so they land in this room. */
export const inviteLinkFor = (room: InviteLink): string => `${location.origin}${location.pathname}${formatInviteFragment(room)}`;

export const getName = (): string | null => local.get('name');
export const setName = (name: string): void => local.set('name', name);
/** The chosen profile picture, checked on the way out so a stale or edited value can never fail the handshake. */
export const getPicture = (): string | null => { const p = local.get('picture'); return p ? normalisePicture(p) : null; };
export const setPicture = (picture: string | null): void => (picture ? local.set('picture', picture) : local.remove('picture'));
