// The little markdown a text may carry: **bold**, *italic* (or _italic_), ~~struck~~, `code`, ``` fenced code ```, and
// "> " quotes, nested too; links are found as before, by their https:// or http://. Nothing else (no headings, lists,
// tables, images or HTML): a chat line that happens to start with "#" or "-" stays as it was written.
//
// Two readings of the same text. The log shows a text without its markers (`parseBlocks`); the composer shows every
// character the friend typed, markers dimmed, in place, so the caret stays where the text is (`highlightLines`). Both
// read inline marks a line at a time: a mark does not reach over a line break.

export type Mark = 'bold' | 'italic' | 'strike' | 'code';
/** A piece of one line: its characters, the marks it wears, and whether it is a marker (`**`, a backtick, a fence). */
export type Run = { text: string; marks: Mark[]; marker?: true; href?: string };
/** What the log shows: lines of text, a quote (of blocks, so a quote can hold a quote or code), or a block of code. */
export type Block =
  | { kind: 'text'; lines: Run[][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; text: string };
/** What the composer shows of one line: its quote prefix ("> ", "> > "), then its runs. A fence line is all marker. */
export type HighlightLine = { quote: string; kind: 'text' | 'fence' | 'code'; runs: Run[] };

const URL_RE = /^https?:\/\/[^\s<>"'`]+/;
// A quote's ">" takes a space after it or ends the line, at every level ("> > "): ">_<", ">.>" and ">>> " (a Python
// prompt) are text.
const QUOTE_RE = /^ {0,3}>(?:\s|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const DELIMITERS: ReadonlyArray<[string, Mark]> = [['**', 'bold'], ['__', 'bold'], ['~~', 'strike'], ['*', 'italic'], ['_', 'italic']];
const WORDY = /[\p{L}\p{N}]/u;
const wordy = (c: string | undefined) => c !== undefined && WORDY.test(c);
const blank = (c: string | undefined) => c === undefined || /\s/.test(c);

/**
 * The link starting at `i`, if one does. Punctuation after it is the sentence's, and markers after it are the text's
 * ("see **https://x.org**."); a closing parenthesis stays when the link opened one (a Wikipedia link).
 */
function linkAt(s: string, i: number): string | null {
  let url = URL_RE.exec(s.slice(i))?.[0];
  if (!url) return null;
  for (;;) {
    const last = url.at(-1)!;
    const unbalanced = last === ')' && url.split('(').length < url.split(')').length;
    if (!'.,;:!?*_~'.includes(last) && !unbalanced) break;
    url = url.slice(0, -1);
  }
  return /^https?:\/\/./.test(url) ? url : null;
}

/** A code span or a link, by where it starts: read before the marks around it, so nothing inside one opens or closes a mark. */
type Atom = { end: number; code?: number; href?: string };

/**
 * The code spans and links of a line, in one pass from the left. A run of backticks pairs with the next run of as many;
 * one that pairs with none is text.
 */
function atomsOf(s: string): Map<number, Atom> {
  const runs: { at: number; n: number }[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] !== '`') { i++; continue; }
    let n = 0;
    while (s[i + n] === '`') n++;
    runs.push({ at: i, n });
    i += n;
  }
  // Each run by where it starts, with the next run of the same length.
  const run = new Map<number, { n: number; next?: number }>();
  const lastOf = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    const { at, n } = runs[r]!;
    run.set(at, { n, next: lastOf.get(n) });
    lastOf.set(n, at);
  }
  const atoms = new Map<number, Atom>();
  for (let i = 0; i < s.length; ) {
    const r = run.get(i);
    if (r) {
      if (r.next !== undefined) { atoms.set(i, { end: r.next + r.n, code: r.n }); i = r.next + r.n; } else i += r.n;
      continue;
    }
    if (s[i] === 'h' && !wordy(s[i - 1])) {
      const url = linkAt(s, i);
      if (url) { atoms.set(i, { end: i + url.length, href: url }); i += url.length; continue; }
    }
    i++;
  }
  return atoms;
}

/** One line's runs, markers included: joined, their text is the line. */
export function parseInline(s: string): Run[] {
  const atoms = atomsOf(s);
  // A closer looked for in vain from some place up to some end is not there from any later place either: remembered by
  // delimiter and end, so a line of openers that close nothing is read once, not once per opener.
  const failed = new Map<string, number>();
  /** Where the mark opened by `d` closes, from `from` on, before `to`, or -1: the same delimiter after a character that is not a space. */
  const closer = (from: number, to: number, d: string): number => {
    const at = (k: number) => (k >= from && k < to ? s[k] : undefined); // what the range has there: nothing outside it
    const key = `${d}:${to}`;
    if (from >= (failed.get(key) ?? Infinity)) return -1;
    for (let k = from; k + d.length <= to; k++) {
      const atom = atoms.get(k);
      if (atom) { k = atom.end - 1; continue; }
      if (!s.startsWith(d, k) || blank(at(k - 1))) continue;
      if (d[0] === '_' && wordy(at(k + d.length))) continue;
      if (d.length === 1 && (at(k + 1) === d || at(k - 1) === d)) continue;
      // "***both***": the pair closes on the last two stars, the single one inside it on the first.
      if (d.length === 2 && at(k + 2) === d[0]) return k + 1;
      return k;
    }
    failed.set(key, Math.min(from, failed.get(key) ?? Infinity));
    return -1;
  };
  /** Whether the delimiter `d` at `i` can open a mark: followed by a character that is not a space, and `_` not inside a word. */
  const opens = (i: number, to: number, d: string): boolean => {
    const after = i + d.length < to ? s[i + d.length] : undefined;
    if (blank(after) || s[i - 1] === '\\') return false; // "\*" is a star, written so on purpose; it may still close a mark
    if (d[0] === '_' && wordy(s[i - 1])) return false;
    // A single star or underscore that is half of a pair is the pair's.
    if (d.length === 1 && after === d) return false;
    return true;
  };
  const read = (from: number, to: number, marks: Mark[], out: Run[]): void => {
    let plain = '';
    const flush = () => { if (plain) out.push({ text: plain, marks }); plain = ''; };
    const marker = (text: string) => { flush(); out.push({ text, marks, marker: true }); };
    for (let i = from; i < to; ) {
      const atom = atoms.get(i);
      if (atom?.code) {
        const n = atom.code;
        marker(s.slice(i, i + n));
        out.push({ text: s.slice(i + n, atom.end - n), marks: [...marks, 'code'] });
        marker(s.slice(atom.end - n, atom.end));
        i = atom.end;
        continue;
      }
      if (atom?.href) {
        flush();
        out.push({ text: atom.href, marks, href: atom.href });
        i = atom.end;
        continue;
      }
      // A run of backticks that pairs with none is text, whole.
      if (s[i] === '`') { while (s[i] === '`' && i < to) plain += s[i++]; continue; }
      const opened = DELIMITERS.find(([d]) => s.startsWith(d, i) && i + d.length <= to && opens(i, to, d));
      if (opened) {
        const [d, mark] = opened;
        const end = closer(i + d.length, to, d);
        if (end > i + d.length) {
          marker(d);
          read(i + d.length, end, marks.includes(mark) ? marks : [...marks, mark], out);
          marker(d);
          i = end + d.length;
          continue;
        }
        // Nothing closes it: the delimiter is text. A pair is passed over whole, or its second half would open alone.
        plain += d;
        i += d.length;
        continue;
      }
      plain += s[i++];
    }
    flush();
  };
  const out: Run[] = [];
  read(0, s.length, [], out);
  return out;
}

/** The quote prefixes a line starts with, one per level ("> ", ">"). */
function levelsOf(line: string): string[] {
  const levels: string[] = [];
  for (let m, at = 0; (m = QUOTE_RE.exec(line.slice(at))); at += m[0].length) levels.push(m[0]);
  return levels;
}
/** A line's quote prefix, all its levels: what a line break in the composer carries on to the next line. */
export const quotePrefix = (line: string): string => levelsOf(line).join('');

/** The fence a line may open code with ("```", "~~~~", maybe a language after it), or null. A backtick after "```" makes it code inside the line. */
const fenceOf = (line: string) => {
  const m = FENCE_RE.exec(line);
  return m && !(m[1]![0] === '`' && m[2]!.includes('`')) ? m[1]! : null;
};
/** Whether `line` closes code opened by `fence`: the same character, at least as many, nothing after. */
const closes = (line: string, fence: string) => {
  const f = FENCE_RE.exec(line);
  return !!f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !f[2]!.trim();
};

/**
 * A text as the log shows it. A fence opens code only where another closes it further down: one that nothing closes
 * ("~~~nope", a typo) is text, and hides none of the lines after it.
 */
export function parseBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  /** The line that closes code opened at line i, or -1 when line i opens none. */
  const codeEnd = (i: number): number => {
    const fence = fenceOf(lines[i]!);
    if (fence) for (let j = i + 1; j < lines.length; j++) if (closes(lines[j]!, fence)) return j;
    return -1;
  };
  const out: Block[] = [];
  for (let i = 0; i < lines.length; ) {
    const end = codeEnd(i);
    if (end >= 0) {
      out.push({ kind: 'code', text: lines.slice(i + 1, end).join('\n') });
      i = end + 1;
      continue;
    }
    if (QUOTE_RE.test(lines[i]!)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE_RE.test(lines[i]!); i++) inner.push(lines[i]!.replace(QUOTE_RE, ''));
      out.push({ kind: 'quote', blocks: parseBlocks(inner.join('\n')) });
      continue;
    }
    const runs: Run[][] = [];
    for (; i < lines.length && codeEnd(i) < 0 && !QUOTE_RE.test(lines[i]!); i++) runs.push(parseInline(lines[i]!));
    out.push({ kind: 'text', lines: runs });
  }
  return out;
}

/**
 * A text as the composer shows it, a line at a time, every character kept: joined with line breaks, the quote prefixes
 * and runs of the lines are the text. Code reads as the log reads it: inside a quote it goes on behind the quote's
 * prefix, and a fence opens it only where another, as deep in quotes, closes it.
 */
export function highlightLines(text: string): HighlightLine[] {
  const lines = text.split('\n');
  const levels = lines.map(levelsOf);
  const fenceLine = (quote: string, rest: string): HighlightLine => ({ quote, kind: 'fence', runs: [{ text: rest, marks: [], marker: true }] });
  const out: HighlightLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const depth = levels[i]!.length;
    const quote = levels[i]!.join('');
    const rest = lines[i]!.slice(quote.length);
    // A later line's own prefix to the code's depth, and what follows it.
    const inside = (j: number) => { const q = levels[j]!.slice(0, depth).join(''); return [q, lines[j]!.slice(q.length)] as const; };
    const fence = fenceOf(rest);
    let end = -1;
    if (fence) for (let j = i + 1; j < lines.length && levels[j]!.length >= depth; j++) if (closes(inside(j)[1], fence)) { end = j; break; }
    if (end < 0) { out.push({ quote, kind: 'text', runs: parseInline(rest) }); continue; }
    out.push(fenceLine(quote, rest));
    for (let j = i + 1; j < end; j++) {
      const [q, code] = inside(j);
      out.push({ quote: q, kind: 'code', runs: code ? [{ text: code, marks: ['code'] }] : [] });
    }
    out.push(fenceLine(...inside(end)));
    i = end;
  }
  return out;
}
