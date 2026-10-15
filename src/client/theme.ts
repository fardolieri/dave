import { createSignal } from 'solid-js';
import { local } from './storage';

// Each file in themes/ is one look, every rule scoped under :root[data-theme="<file name>"], so the app's own look
// stays the default and a theme only applies while picked. The pick is kept per browser; a stored name whose file is
// gone (a theme dropped in a later deploy) reads as the default look.
const files = import.meta.glob('./themes/*.css', { eager: true });
export const THEMES: readonly string[] = Object.keys(files).map((path) => path.replace(/^.*\/(.*)\.css$/, '$1')).sort();

const stored = local.read('theme');
const [theme, setThemeSignal] = createSignal(stored !== null && THEMES.includes(stored) ? stored : '');
export { theme };

const apply = (name: string): void => {
  if (name) document.documentElement.dataset['theme'] = name;
  else delete document.documentElement.dataset['theme'];
};
apply(theme());

export function setTheme(name: string): void {
  setThemeSignal(name);
  apply(name);
  if (name) local.set('theme', name);
  else local.remove('theme');
}
