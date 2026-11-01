import { describe, expect, it } from 'vitest';
import { highlightLines, parseBlocks, parseInline, type Block, type Run } from '../src/core/markdown';

/** Runs as a short string: marks in brackets, markers in braces, links in angle brackets. */
const show = (runs: Run[]) => runs.map((r) => (r.marker ? `{${r.text}}` : r.href ? `<${r.text}>` : r.marks.length ? `[${r.marks.join('+')}:${r.text}]` : r.text)).join('');
const joined = (runs: Run[]) => runs.map((r) => r.text).join('');
/** A text as the log reads it, markers left out: quotes and code blocks keep their lines. */
const plainText = (text: string) => {
  const block = (b: Block): string =>
    b.kind === 'code' ? b.text : b.kind === 'quote' ? b.blocks.map(block).join('\n') : b.lines.map((l) => l.filter((r) => !r.marker).map((r) => r.text).join('')).join('\n');
  return parseBlocks(text).map(block).join('\n');
};

describe('parseInline', () => {
  it('reads bold, italic, struck and code, markers kept as runs of their own', () => {
    expect(show(parseInline('a **b** c'))).toBe('a {**}[bold:b]{**} c');
    expect(show(parseInline('a __b__ c'))).toBe('a {__}[bold:b]{__} c');
    expect(show(parseInline('*a* and _b_'))).toBe('{*}[italic:a]{*} and {_}[italic:b]{_}');
    expect(show(parseInline('~~gone~~'))).toBe('{~~}[strike:gone]{~~}');
    expect(show(parseInline('run `pnpm **test**` now'))).toBe('run {`}[code:pnpm **test**]{`} now');
    expect(show(parseInline('``a ` b``'))).toBe('{``}[code:a ` b]{``}');
  });
  it('nests marks, and reads three stars as both', () => {
    expect(show(parseInline('**a *b* c**'))).toBe('{**}[bold:a ]{*}[bold+italic:b]{*}[bold: c]{**}');
    expect(show(parseInline('*a **b** c*'))).toBe('{*}[italic:a ]{**}[italic+bold:b]{**}[italic: c]{*}');
    expect(show(parseInline('***both***'))).toBe('{**}{*}[bold+italic:both]{*}{**}');
  });
  it('leaves what is not a mark as text', () => {
    expect(show(parseInline('2 * 3 * 4'))).toBe('2 * 3 * 4');
    expect(show(parseInline('** not bold **'))).toBe('** not bold **');
    expect(show(parseInline('snake_case_name'))).toBe('snake_case_name');
    expect(show(parseInline('**unclosed'))).toBe('**unclosed');
    expect(show(parseInline('`unclosed'))).toBe('`unclosed');
    expect(show(parseInline('****'))).toBe('****');
    expect(show(parseInline('# not a heading'))).toBe('# not a heading');
    expect(parseBlocks('>_< oops').map((b) => b.kind)).toEqual(['text']);
    expect(parseBlocks('>\n> a').map((b) => b.kind)).toEqual(['quote']);
    expect(parseBlocks('>>> import os').map((b) => b.kind)).toEqual(['text']);
    expect(parseBlocks('> > earlier\n> reply')).toEqual([{ kind: 'quote', blocks: [{ kind: 'quote', blocks: [{ kind: 'text', lines: [[{ text: 'earlier', marks: [] }]] }] }, { kind: 'text', lines: [[{ text: 'reply', marks: [] }]] }] }]);
    expect(parseBlocks('>\ta').map((b) => b.kind)).toEqual(['quote']);
  });
  it('leaves backslashes as they are: a path stays a path', () => {
    expect(show(parseInline('\\\\server\\share'))).toBe('\\\\server\\share');
    expect(show(parseInline('C:\\Users\\_tmp_'))).toBe('C:\\Users\\_tmp_');
    // A backslash before a marker keeps it a character, and shows.
    expect(show(parseInline('\\*not italic\\*'))).toBe('\\*not italic\\*');
    expect(show(parseInline('*C:\\dir\\*'))).toBe('{*}[italic:C:\\dir\\]{*}');
  });
  it('reads a fence and its closing on one line as code inside the line, not as a block', () => {
    expect(show(parseInline('```npm install```'))).toBe('{```}[code:npm install]{```}');
    expect(parseBlocks('```npm install```').map((b) => b.kind)).toEqual(['text']);
    expect(parseBlocks('~~~nope~~~ ok').map((b) => b.kind)).toEqual(['text']);
    expect(parseBlocks('```js\nx\n```').map((b) => b.kind)).toEqual(['code']);
    expect(parseBlocks('~~~c++\nx\n~~~\r\nafter').map((b) => b.kind)).toEqual(['code', 'text']);
  });
  it('does not end a mark inside a link or code', () => {
    expect(show(parseInline('*see https://x.org/a*b*'))).toBe('{*}[italic:see ]<https://x.org/a*b>{*}');
    expect(show(parseInline('_see https://x.org/file_.txt_'))).toBe('{_}[italic:see ]<https://x.org/file_.txt>{_}');
    expect(show(parseInline('*a `b*` c*'))).toBe('{*}[italic:a ]{`}[italic+code:b*]{`}[italic: c]{*}');
  });
  it('takes a line of openers that close nothing in time linear in its length', () => {
    // Four times the longest text: read again for every opener, these took seconds; read once, milliseconds.
    for (const s of ['_a '.repeat(2800), '_`a` '.repeat(1600), '**a '.repeat(2000), '`'.repeat(3) + ' `` '.repeat(1600)]) {
      const t = performance.now();
      expect(parseInline(s).map((r) => r.text).join('')).toBe(s);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
  it('finds links, without the punctuation or markers after them', () => {
    expect(show(parseInline('see https://x.org/a_b.'))).toBe('see <https://x.org/a_b>.');
    expect(show(parseInline('**https://x.org**'))).toBe('{**}<https://x.org>{**}');
    expect(show(parseInline('(https://x.org/wiki/A_(b))'))).toBe('(<https://x.org/wiki/A_(b)>)');
    expect(show(parseInline('`https://x.org`'))).toBe('{`}[code:https://x.org]{`}');
    expect(show(parseInline('xhttps://x.org'))).toBe('xhttps://x.org');
    expect(show(parseInline('https://'))).toBe('https://');
  });
  it('keeps every character: the runs joined are the line', () => {
    for (const s of ['a **b** c', '***x***', '\\*a\\*', '`a` `b`` c', '``', '``a ` b``', '*a **b** c*', '_a_ https://x.org/_b_ ~~c~~ `d`', '**a', '*']) {
      expect(joined(parseInline(s))).toBe(s);
    }
  });
});

describe('parseBlocks', () => {
  it('groups quote lines, a quote inside a quote, and the text around them', () => {
    const blocks = parseBlocks('> she said\n> > he said\nand I said');
    expect(blocks.map((b) => b.kind)).toEqual(['quote', 'text']);
    const quote = blocks[0]!;
    if (quote.kind !== 'quote') throw new Error('not a quote');
    expect(quote.blocks.map((b) => b.kind)).toEqual(['text', 'quote']);
    expect(plainText('> she said\n> > he said\nand I said')).toBe('she said\nhe said\nand I said');
  });
  it('reads fenced code as it is; a fence nothing closes is text, and hides nothing after it', () => {
    expect(parseBlocks('look:\n```js\nconst a = **b**;\n```\nok')).toEqual([
      { kind: 'text', lines: [[{ text: 'look:', marks: [] }]] },
      { kind: 'code', text: 'const a = **b**;' },
      { kind: 'text', lines: [[{ text: 'ok', marks: [] }]] },
    ]);
    expect(parseBlocks('```\na\n\nb').map((b) => b.kind)).toEqual(['text']);
    expect(parseBlocks('```js title="a"\ncode\n```\nafter')).toEqual([{ kind: 'code', text: 'code' }, { kind: 'text', lines: [[{ text: 'after', marks: [] }]] }]);
    expect(parseBlocks('```\r\nx\r\n```\r\nafter')).toEqual([{ kind: 'code', text: 'x' }, { kind: 'text', lines: [[{ text: 'after', marks: [] }]] }]);
  });
  it('keeps blank lines inside text', () => {
    expect(parseBlocks('a\n\nb')).toEqual([{ kind: 'text', lines: [[{ text: 'a', marks: [] }], [], [{ text: 'b', marks: [] }]] }]);
  });
  it('leaves a text without markdown as one block of its lines', () => {
    expect(plainText('just text, 2 * 3')).toBe('just text, 2 * 3');
  });
});

describe('highlightLines', () => {
  const back = (text: string) => highlightLines(text).map((l) => l.quote + joined(l.runs)).join('\n');
  it('keeps every character of the text, quotes and fences included', () => {
    for (const s of ['> a **b**\n> > c\nd', '```\ncode *x*\n```', '> ```\n> code\nafter', '', '\n\n', '>', '>> x', '\\> not a quote']) {
      expect(back(s)).toBe(s);
    }
  });
  it('says which lines are code and which quoted', () => {
    expect(highlightLines('> a\n```\n*x*\n```\nb').map((l) => [l.quote, l.kind])).toEqual([['> ', 'text'], ['', 'fence'], ['', 'code'], ['', 'fence'], ['', 'text']]);
    expect(highlightLines('> ```\n> *x*\n> ```\n*y*').map((l) => [l.quote, l.kind])).toEqual([['> ', 'fence'], ['> ', 'code'], ['> ', 'fence'], ['', 'text']]);
    // Not closed (yet, while it is being written): text, as the log would show it.
    expect(highlightLines('> ```\n> *x*\n```').map((l) => [l.quote, l.kind])).toEqual([['> ', 'text'], ['> ', 'text'], ['', 'text']]);
    expect(highlightLines('> > a').map((l) => l.quote)).toEqual(['> > ']);
  });
});
