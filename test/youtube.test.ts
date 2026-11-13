import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_CHANNEL, MAX_VIDEO_TITLE, aboutVideo, parseVideoCard, videoOf, videosIn } from '../src/core/youtube';
import { MAX_FILE_BODY_BYTES, MAX_PREVIEW_LENGTH, parseFileMeta, type FileMeta } from '../src/core/attachment';

const ID = 'rFZHOHl-L8A';

describe('YouTube links', () => {
  it('finds the video a link names, in every form YouTube writes it', () => {
    for (const link of [
      `https://www.youtube.com/watch?v=${ID}`, `https://youtube.com/watch?v=${ID}&t=90s`, `https://m.youtube.com/watch?list=x&v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}`, `https://youtu.be/${ID}?si=abc&t=12`, `http://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}?feature=share`, `https://www.youtube-nocookie.com/embed/${ID}`, `https://WWW.YouTube.com/watch?v=${ID}`,
    ]) expect(videoOf(link), link).toBe(ID);
    for (const link of [
      'https://www.youtube.com/', 'https://www.youtube.com/@LofiGirl', `https://www.youtube.com/watch?v=${ID}x`, 'https://www.youtube.com/watch?v=short',
      `https://notyoutube.com/watch?v=${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`, `https://example.com/?v=${ID}`, `ftp://youtu.be/${ID}`,
      `https://www.youtube.com/playlist?list=${ID}`, 'https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', 'not a link',
    ]) expect(videoOf(link), link).toBeNull();
  });

  it('finds the videos a pasted text links to, each once, as the log links them: none in code', () => {
    expect(videosIn(`https://www.youtube.com/watch?v=${ID}`)).toEqual([ID]);
    expect(videosIn(`look (https://youtu.be/${ID}), and https://youtu.be/dQw4w9WgXcQ. Again: https://www.youtube.com/watch?v=${ID}`)).toEqual([ID, 'dQw4w9WgXcQ']);
    expect(videosIn(`> quoted https://youtu.be/${ID}`)).toEqual([ID]);
    expect(videosIn(`\`https://youtu.be/${ID}\``)).toEqual([]);
    expect(videosIn(`\`\`\`\nhttps://youtu.be/${ID}\n\`\`\``)).toEqual([]);
    expect(videosIn('no links here, https://example.com either')).toEqual([]);
  });

  it("takes the title and channel from YouTube's oEmbed answer, cut to what a card carries", () => {
    expect(aboutVideo({ title: 'lofi hip hop radio 📚 beats to relax/study to', author_name: 'Lofi Girl', html: '<iframe>' }))
      .toEqual({ title: 'lofi hip hop radio 📚 beats to relax/study to', channel: 'Lofi Girl' });
    expect(aboutVideo(null)).toEqual({});
    expect(aboutVideo({ title: '  ', author_name: 7 })).toEqual({});
    const long = aboutVideo({ title: `${'x'.repeat(MAX_VIDEO_TITLE - 1)}📚`, author_name: 'y'.repeat(500) });
    expect(long.title).toBe('x'.repeat(MAX_VIDEO_TITLE - 1)); // never half an emoji
    expect(long.channel).toHaveLength(MAX_VIDEO_CHANNEL);
    expect(parseVideoCard({ id: ID, ...long })).toEqual({ id: ID, ...long });
  });

  it('takes a card as a friend wrote it, and nothing off', () => {
    expect(parseVideoCard({ id: ID })).toEqual({ id: ID });
    expect(parseVideoCard({ id: ID, title: 'a', channel: 'b', extra: 1 })).toEqual({ id: ID, title: 'a', channel: 'b' });
    for (const off of [null, 'x', { id: 'short' }, { id: ID, title: '' }, { id: ID, title: 'x'.repeat(MAX_VIDEO_TITLE + 1) }, { id: ID, channel: 3 }]) {
      expect(parseVideoCard(off), JSON.stringify(off)).toBeNull();
    }
  });

  it("goes in a picture's announcement; one this app cannot read leaves the picture", () => {
    const thumbnail: FileMeta = { name: `youtube-${ID}.jpg`, type: 'image/jpeg', size: 65_324, hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', width: 1280, height: 720 };
    const card = { ...thumbnail, youtube: { id: ID, title: 'lofi', channel: 'Lofi Girl' } };
    expect(parseFileMeta(card)).toEqual(card);
    expect(parseFileMeta({ ...thumbnail, youtube: { id: 'nope' } })).toEqual(thumbnail);
    expect(parseFileMeta({ ...thumbnail, youtube: { id: ID, title: 'x'.repeat(MAX_VIDEO_TITLE + 1) } })).toEqual(thumbnail);
    // An app from before this takes the picture and leaves the card: its parser keeps only the fields it knows.
    const { youtube: _, ...known } = parseFileMeta(card)!;
    expect(known).toEqual(thumbnail);
  });

  it('fits the longest card a sender writes into an announcement, the preview at its longest too', () => {
    // Every character of the title and channel escaped at its longest in JSON, six bytes ("\u0001").
    const file: FileMeta = {
      name: `youtube-${ID}.jpg`, type: 'image/jpeg', size: 16 * 1024 * 1024, hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', width: 100_000, height: 100_000,
      preview: `data:image/webp;base64,${'A'.repeat(MAX_PREVIEW_LENGTH - 'data:image/webp;base64,'.length)}`,
      youtube: { id: ID, title: '\u0001'.repeat(MAX_VIDEO_TITLE), channel: '\u0001'.repeat(MAX_VIDEO_CHANNEL) },
    };
    expect(parseFileMeta(file)).toEqual(file);
    expect(new TextEncoder().encode(JSON.stringify(file)).length).toBeLessThanOrEqual(MAX_FILE_BODY_BYTES);
  });
});
