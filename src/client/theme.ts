import { createSignal, untrack } from 'solid-js';
import posthog from './posthog';
import { local } from './storage';

// Each file in themes/ is one look, its rules scoped to an element with data-theme="<file name>" up to the next element
// with a data-theme in (`@scope`): the page, a room's box, a room's chat. The app's own look stays the default.
const files = import.meta.glob('./themes/*.css', { eager: true });
// Scoped with @scope: a browser without it (Firefox before 146) drops every rule of every theme, so it is offered none, and
// a stored pick reads as the default look there.
export const THEMES: readonly string[] = 'CSSScopeRule' in globalThis ? Object.keys(files).map((path) => path.replace(/^.*\/(.*)\.css$/, '$1')).sort() : [];

// The prefix of a file name says which design skill made the theme (the bake-off of PR #63); the menu groups by it.
const SKILLS: Record<string, string> = { fd: 'frontend-design', imp: 'Impeccable', tf: 'theme-factory', ds: 'designer-skills' };
/** The themes in the menu, grouped by the skill that made them: `tf-midnight-galaxy` shows as "Midnight galaxy". */
export const THEME_GROUPS: readonly { label: string; themes: { name: string; label: string }[] }[] = [...new Set(THEMES.map((t) => t.split('-')[0]!))]
  .map((prefix) => ({
    label: SKILLS[prefix] ?? prefix,
    themes: THEMES.filter((t) => t.split('-')[0] === prefix).map((name) => {
      const words = name.split('-').slice(1).join(' ');
      return { name, label: words.charAt(0).toUpperCase() + words.slice(1) };
    }),
  }));

// Each room has its own look, picked from its ⋯ menu (`dave.roomThemes`, by room id); the page wears the look of the room
// on screen. The look picked before rooms had their own (`dave.theme`) becomes the pick of every room there is on the
// update (adoptOldTheme), so nobody's look changes. A stored name whose file is gone reads as the default look.
const known = (name: string): string => (name === '' || THEMES.includes(name) ? name : '');
const stored = local.read('theme');
let fallback = stored !== null ? known(stored) : '';
const [picks, setPicks] = createSignal<Record<string, string>>(local.read('roomThemes'));
// Another tab's picks (a tab that took the app over, client/tablock.ts): this one shows them, and writes on top of them.
addEventListener('storage', (e) => {
  if (e.key === 'dave.roomThemes') setPicks(local.read('roomThemes'));
  if (e.key === 'dave.theme' && e.newValue === null) forgetOldTheme(); // the other tab adopted it (below)
});
/** The old look gone: no room without a pick of its own wears it any more. */
function forgetOldTheme(): void {
  if (!fallback) return;
  fallback = '';
  setPicks({ ...untrack(picks) }); // themeOf reads the fallback: read again
}

/**
 * The look picked before rooms had their own becomes the pick of each room there is, once, and is gone: a room joined
 * later starts in the default look, as there is no picker left that could put the old look away.
 */
export function adoptOldTheme(roomIds: readonly string[]): void {
  // As stored now, not as this page read it: another tab may have adopted it, or (one of before) picked it again.
  const raw = local.read('theme');
  if (raw === null) { forgetOldTheme(); return; }
  if (THEMES.length === 0) return; // kept for a browser that can show themes later
  const old = known(raw);
  const next = { ...local.read('roomThemes') };
  for (const id of roomIds) if (next[id] === undefined && old) next[id] = old;
  local.set('roomThemes', JSON.stringify(next));
  local.remove('theme');
  fallback = '';
  setPicks(next);
}
/** The look of a room: its own pick, else the one from before rooms had their own. */
export const themeOf = (roomId: string): string => { const p = picks()[roomId]; return p === undefined ? fallback : known(p); };
const [theme, setThemeSignal] = createSignal(fallback);
/** A room's look is not the page's: its box and its chat wear it apart (and the chat carries it only then). */
export const lookApart = (roomId: string): boolean => themeOf(roomId) !== theme();
/** The look of the page: the top room's (each room's box and the chat of the room on screen wear their own). */
export { theme };

// Which themes friends keep, not only try (the bake-off of PR #63, .scratch/themes/issues/01-keep-or-drop.md): every
// event carries the theme on screen, and each pick says how long the theme before it lasted. Only with the opt-in.
const apply = (name: string): void => {
  if (name) document.documentElement.dataset['theme'] = name;
  else delete document.documentElement.dataset['theme'];
  posthog.register({ theme: name || 'default' });
};
apply(theme());
/** Since when the page wears its look; null for one this browser had kept from an earlier visit. */
let pickedAt: number | null = null;
let shownRoom: string | null = null;

/** A room is the top one (the first in the list): the page wears its look. */
export function showTopTheme(roomId: string): void {
  shownRoom = roomId;
  const name = untrack(() => themeOf(roomId));
  if (name === untrack(theme) && (document.documentElement.dataset['theme'] ?? '') === name) return;
  if (name !== untrack(theme)) pickedAt = Date.now(); // not a pick: the page wears another room's look from now on
  setThemeSignal(name);
  apply(name);
}

/** Picks a room's look; the page's too if the room is the top one. */
export function setRoomTheme(roomId: string, name: string): void {
  // Against the stored name, not the look: a pick of a dropped theme reads as the default look, and picking that is kept.
  if (untrack(picks)[roomId] === name) return;
  // Only the page's look is counted, which is the top room's (a pick for a room further down is not on screen):
  // previous_ms is how long the look before had been on the page.
  if (roomId === shownRoom && name !== untrack(theme)) {
    posthog.capture('theme_picked', {
      theme: name || 'default',
      previous: untrack(theme) || 'default',
      previous_ms: pickedAt === null ? null : Date.now() - pickedAt,
      $set: { theme: name || 'default' },
    });
    pickedAt = Date.now();
  }
  const next = { ...local.read('roomThemes'), [roomId]: name }; // read again: another tab may have picked since
  setPicks(next);
  local.set('roomThemes', JSON.stringify(next));
  if (roomId === shownRoom) { setThemeSignal(name); apply(name); }
}

/** A room left: its look goes with it. */
export function forgetRoomTheme(roomId: string): void {
  const { [roomId]: _gone, ...rest } = local.read('roomThemes');
  if (_gone === undefined) return;
  setPicks(rest);
  local.set('roomThemes', JSON.stringify(rest));
}
