import { createSignal, createMemo, For, Show } from 'solid-js';
import { EMOJI_CATEGORIES, searchEmoji, type EmojiEntry } from '../core/emoji';
import { isSingleEmoji } from '../core/protocol';
import { local } from './storage';
import { place } from './place';

// Emoji this browser picked last, newest first, shown as the first row of the picker (issue #3).
const RECENT_KEY = 'emojiRecent';
const RECENT_MAX = 24;
function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(local.get(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
const [recent, setRecent] = createSignal<string[]>(readRecent());
function rememberEmoji(char: string): void {
  const next = [char, ...recent().filter((c) => c !== char)].slice(0, RECENT_MAX);
  setRecent(next);
  local.set(RECENT_KEY, JSON.stringify(next));
}

/**
 * The emoji picker: a popover opened by any button with `popovertarget={id}`, placed over that button.
 * Search by name, or browse by category; a typed or pasted emoji in the search field is offered too, so
 * anything not in the curated list still gets through. The host decides what a pick means and whether
 * the picker stays open (several emoji into a message) or closes (one profile picture).
 */
export function EmojiPicker(props: { id: string; anchor: () => HTMLElement | undefined; onPick: (emoji: string) => void; closeOnPick?: boolean }) {
  let card: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  let scroller: HTMLDivElement | undefined;
  const [query, setQuery] = createSignal('');
  const results = createMemo(() => searchEmoji(query()));
  // What was typed, when it is itself a single emoji (pasted from elsewhere, or from the OS keyboard): offered as the first result.
  const typed = createMemo(() => { const q = query().trim(); return q && isSingleEmoji(q) && !results().some((e) => e.char === q) ? q : null; });
  const recentEntries = createMemo((): EmojiEntry[] => recent().map((char) => ({ char, name: '' })));
  const onToggle = (e: Event) => {
    if ((e as ToggleEvent).newState !== 'open' || !card) return;
    setQuery('');
    scroller?.scrollTo(0, 0);
    const anchor = props.anchor();
    if (anchor) place(card, anchor, 'above');
    // Only a pointer that is not a finger gets the search field focused: a phone would pop its keyboard over the grid.
    if (matchMedia('(pointer: fine)').matches) search?.focus();
  };
  const pick = (char: string) => {
    rememberEmoji(char);
    props.onPick(char);
    if (props.closeOnPick) card?.hidePopover();
  };
  const jumpTo = (label: string) => scroller?.querySelector<HTMLElement>(`[data-section="${label}"]`)?.scrollIntoView({ block: 'start' });
  const onKey = (e: KeyboardEvent) => {
    // Enter in the search field takes the first result, so "thumbs⏎" is two keystrokes shorter than a click.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = typed() ?? results()[0]?.char;
    if (first) pick(first);
  };
  const Grid = (p: { entries: EmojiEntry[] }) => (
    <div class="emoji-grid"><For each={p.entries}>{(e) => <button type="button" title={e.name || undefined} onClick={() => pick(e.char)}>{e.char}</button>}</For></div>
  );
  return (
    <div id={props.id} class="emoji-picker" popover="auto" ref={card} onToggle={onToggle}>
      <input ref={search} class="emoji-search" type="search" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={onKey} placeholder="Search emoji" aria-label="Search emoji" />
      <Show when={!query().trim()} fallback={
        <div class="emoji-scroll" ref={scroller}>
          <Show when={typed()}>{(t) => <Grid entries={[{ char: t(), name: 'as typed' }]} />}</Show>
          <Show when={results().length > 0} fallback={<Show when={!typed()}><p class="hint">Nothing by that name. You can paste an emoji here too.</p></Show>}>
            <Grid entries={results()} />
          </Show>
        </div>
      }>
        <div class="emoji-tabs" role="tablist">
          <Show when={recent().length > 0}><button type="button" title="Recent" onClick={() => jumpTo('Recent')}>🕒</button></Show>
          <For each={EMOJI_CATEGORIES}>{(c) => <button type="button" title={c.label} onClick={() => jumpTo(c.label)}>{c.icon}</button>}</For>
        </div>
        <div class="emoji-scroll" ref={scroller}>
          <Show when={recent().length > 0}>
            <h4 data-section="Recent">Recent</h4>
            <Grid entries={recentEntries()} />
          </Show>
          <For each={EMOJI_CATEGORIES}>{(c) => <><h4 data-section={c.label}>{c.label}</h4><Grid entries={c.entries} /></>}</For>
        </div>
      </Show>
    </div>
  );
}
