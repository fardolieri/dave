import { createMemo, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { highlightLines, parseBlocks, type Block, type Run } from '../core/markdown';

const link = (href: string, children: JSX.Element) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

/** A run as the log shows it, in the elements of its marks; a marker is not shown. */
function shown(run: Run): JSX.Element {
  let out: JSX.Element = run.href ? link(run.href, run.text) : run.text;
  for (const mark of [...run.marks].reverse()) {
    out = mark === 'bold' ? <strong>{out}</strong> : mark === 'italic' ? <em>{out}</em> : mark === 'strike' ? <s>{out}</s> : <code>{out}</code>;
  }
  return out;
}

function block(b: Block): JSX.Element {
  if (b.kind === 'code') return <pre><code>{b.text}</code></pre>;
  if (b.kind === 'quote') return <blockquote><For each={b.blocks}>{block}</For></blockquote>;
  // The lines of a text block keep their breaks as text: the message is `white-space: pre-wrap`, and a copy keeps them.
  return <div class="md-text"><For each={b.lines}>{(line, i) => <>{i() > 0 ? '\n' : ''}<For each={line.filter((r) => !r.marker)}>{shown}</For></>}</For></div>;
}

/** A text in the log, its markdown read (core/markdown.ts). */
export function Markdown(props: { text: string }) {
  const blocks = createMemo(() => parseBlocks(props.text));
  return <For each={blocks()}>{block}</For>;
}

/**
 * The composer's text again, every character in place, each wearing what it will look like: laid over the text field,
 * whose own text is not painted (styles.css), so the caret and the selection are the field's. Nothing here may change
 * the width of a character, or the caret would drift from the text: bold is drawn thicker, not set in a bold face, and
 * italic and code are tinted instead of slanted or set in a fixed width. With no text, it shows the field's placeholder
 * on its one line, cut short: the field's own is not painted either, as a browser may wrap it (Firefox does, whatever the
 * styles say) and the field stays one line tall.
 */
export function MarkdownMirror(props: { text: string; placeholder: string }) {
  const lines = createMemo(() => highlightLines(props.text));
  const cls = (r: Run) => [...r.marks.map((m) => `md-${m}`), ...(r.marker ? ['md-marker'] : []), ...(r.href ? ['md-link'] : [])].join(' ');
  return (
    <Show when={props.text} fallback={<span class="md-placeholder">{props.placeholder}</span>}>
      <For each={lines()}>{(line, i) => (
        <>
          {i() > 0 ? '\n' : ''}
          <span class={[`md-line md-line-${line.kind}`, { 'md-quoted': !!line.quote }]}>
            <Show when={line.quote}><span class="md-marker md-quote-marker">{line.quote}</span></Show>
            <For each={line.runs}>{(r) => <span class={cls(r)}>{r.text}</span>}</For>
          </span>
        </>
      )}</For>
      {/* A text ending in a line break shows an empty last line in the field; one character keeps it here too */}
      {'\u200b'}
    </Show>
  );
}
