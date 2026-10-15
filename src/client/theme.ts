import { createSignal } from 'solid-js';

// Design trials: each file in themes/ is one look, every rule scoped under :root[data-theme="<file name>"], so the
// app's own look stays the default and a theme only applies while picked. The pick lives in the address (?theme=),
// not in storage: it survives a reload and travels with a shared link, and nothing outlives the trial.
const files = import.meta.glob('./themes/*.css', { eager: true });
export const THEMES: readonly string[] = Object.keys(files).map((path) => path.replace(/^.*\/(.*)\.css$/, '$1')).sort();

const fromAddress = new URLSearchParams(location.search).get('theme');
const [theme, setThemeSignal] = createSignal(fromAddress !== null && THEMES.includes(fromAddress) ? fromAddress : '');
export { theme };

const apply = (name: string): void => {
  if (name) document.documentElement.dataset['theme'] = name;
  else delete document.documentElement.dataset['theme'];
};
apply(theme());

export function setTheme(name: string): void {
  setThemeSignal(name);
  apply(name);
  const url = new URL(location.href);
  if (name) url.searchParams.set('theme', name);
  else url.searchParams.delete('theme');
  history.replaceState(history.state, '', url);
}
