import { createSignal } from 'solid-js';
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

const stored = local.read('theme');
const [theme, setThemeSignal] = createSignal(stored !== null && THEMES.includes(stored) ? stored : '');
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

export function setTheme(name: string): void {
  const previous = theme();
  if (name === previous) return;
  posthog.capture('theme_picked', {
    theme: name || 'default',
    previous: previous || 'default',
    previous_ms: pickedAt === null ? null : Date.now() - pickedAt,
    $set: { theme: name || 'default' },
  });
  pickedAt = Date.now();
  setThemeSignal(name);
  apply(name);
  if (name) local.set('theme', name);
  else local.remove('theme');
}
