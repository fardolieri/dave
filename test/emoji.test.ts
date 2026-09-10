import { describe, expect, it } from 'vitest';
import { ALL_EMOJI, EMOJI_CATEGORIES, MAX_EMOJI_LENGTH, isSingleEmoji, searchEmoji } from '../src/core/emoji';

describe('the curated list', () => {
  it('holds only single, fully qualified emoji, so every entry passes the profile-picture check', () => {
    const bad = ALL_EMOJI.filter((e) => !isSingleEmoji(e.char)).map((e) => `${e.char} ${e.name}`);
    expect(bad).toEqual([]);
  });
  it('has a name for every entry and lists each emoji once', () => {
    expect(ALL_EMOJI.filter((e) => !e.name).map((e) => e.char)).toEqual([]);
    const seen = new Set<string>();
    const dupes = ALL_EMOJI.filter((e) => (seen.has(e.char) ? true : (seen.add(e.char), false))).map((e) => e.char);
    expect(dupes).toEqual([]);
  });
  it('stays within the length cap the server enforces', () => {
    expect(ALL_EMOJI.filter((e) => e.char.length > MAX_EMOJI_LENGTH)).toEqual([]);
  });
  it('has an icon from its own entries for every category', () => {
    for (const c of EMOJI_CATEGORIES) expect(c.entries.some((e) => e.char === c.icon), c.label).toBe(true);
  });
});

describe('isSingleEmoji', () => {
  it('accepts one emoji, including flags, skin tones and joined families', () => {
    for (const s of ['😀', '❤️', '🇩🇪', '👍🏽', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🧑‍💻']) expect(isSingleEmoji(s), s).toBe(true);
  });
  it('rejects text, several emoji, digits, and unqualified symbols', () => {
    for (const s of ['', 'a', '😀😀', '😀 ', '1', '#', '☠', ' ❤️', 'x😀']) expect(isSingleEmoji(s), JSON.stringify(s)).toBe(false);
  });
});

describe('searchEmoji', () => {
  it('matches names case-insensitively, every word of the query', () => {
    expect(searchEmoji('HEART eyes').map((e) => e.char)).toContain('😍');
    expect(searchEmoji('red heart').map((e) => e.char)).toEqual(['❤️']);
  });
  it('finds nothing for an empty query, so the browse view stays', () => {
    expect(searchEmoji('   ')).toEqual([]);
  });
});
