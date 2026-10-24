import { createSignal, untrack } from 'solid-js';
import posthog from './posthog';
import { local } from './storage';

// Each file in themes/ is one look, every rule scoped under :root[data-theme="<file name>"], so the app's own look
// stays the default and a theme only applies while picked. The pick is kept per browser; a stored name whose file is
// gone (a theme dropped in a later deploy) reads as the default look.
const files = import.meta.glob('./themes/*.css', { eager: true });
export const THEMES: readonly string[] = Object.keys(files).map((path) => path.replace(/^.*\/(.*)\.css$/, '$1')).sort();

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
// on screen. The look picked before rooms had their own (`dave.theme`) is the look of every room with no pick yet, so
// nobody's look changes on the update. A stored name whose file is gone reads as the default look.
const known = (name: string): string => (name === '' || THEMES.includes(name) ? name : '');
const stored = local.read('theme');
const fallback = stored !== null ? known(stored) : '';
const [picks, setPicks] = createSignal<Record<string, string>>(local.read('roomThemes'));
/** The look of a room: its own pick, else the one from before rooms had their own. */
export const themeOf = (roomId: string): string => { const p = picks()[roomId]; return p === undefined ? fallback : known(p); };
const [theme, setThemeSignal] = createSignal(fallback);
/** The look on screen: the room on screen's. */
export { theme };

// Which themes friends keep, not only try (the bake-off of PR #63, .scratch/themes/issues/01-keep-or-drop.md): every
// event carries the theme on screen, and each pick says how long the theme before it lasted. Only with the opt-in.
const apply = (name: string): void => {
  if (name) document.documentElement.dataset['theme'] = name;
  else delete document.documentElement.dataset['theme'];
  posthog.register({ theme: name || 'default' });
};
apply(theme());
/** When the theme on screen was picked in this page; null for one this browser had kept from an earlier visit. */
let pickedAt: number | null = null;
let shownRoom: string | null = null;

/** A room comes on screen: the page wears its look. */
export function showRoomTheme(roomId: string): void {
  shownRoom = roomId;
  const name = untrack(() => themeOf(roomId));
  if (name === untrack(theme) && (document.documentElement.dataset['theme'] ?? '') === name) return;
  setThemeSignal(name);
  apply(name);
}

/** Picks a room's look; on screen if the room is. */
export function setRoomTheme(roomId: string, name: string): void {
  const previous = untrack(() => themeOf(roomId));
  if (name === previous && untrack(picks)[roomId] !== undefined) return;
  posthog.capture('theme_picked', {
    theme: name || 'default',
    previous: previous || 'default',
    previous_ms: pickedAt === null ? null : Date.now() - pickedAt,
    $set: { theme: name || 'default' },
  });
  pickedAt = Date.now();
  const next = { ...untrack(picks), [roomId]: name };
  setPicks(next);
  local.set('roomThemes', JSON.stringify(next));
  if (roomId === shownRoom) { setThemeSignal(name); apply(name); }
}

/** A room left: its look goes with it. */
export function forgetRoomTheme(roomId: string): void {
  const { [roomId]: _gone, ...rest } = untrack(picks);
  if (_gone === undefined) return;
  setPicks(rest);
  local.set('roomThemes', JSON.stringify(rest));
}
