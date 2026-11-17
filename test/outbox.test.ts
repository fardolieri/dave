import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Outbox, OUTBOX_EVERY_MS, OUTBOX_MAX } from '../src/core/outbox';

describe('outbox (the app’s PostHog events, sent together)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const outbox = () => {
    const sent: string[][] = [];
    return { box: new Outbox<string>((items) => sent.push(items)), sent };
  };

  it('sends the events of 30 s in one go, 30 s after the first of them', () => {
    const { box, sent } = outbox();
    box.add('voice_send');
    vi.advanceTimersByTime(12_000);
    box.add('voice_quality');
    vi.advanceTimersByTime(OUTBOX_EVERY_MS - 12_000 - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([['voice_send', 'voice_quality']]);
  });

  it('starts the next wait with the next event, and sends nothing while there is none', () => {
    const { box, sent } = outbox();
    box.add('a');
    vi.advanceTimersByTime(OUTBOX_EVERY_MS);
    vi.advanceTimersByTime(5 * OUTBOX_EVERY_MS);
    expect(sent).toEqual([['a']]);
    box.add('b');
    vi.advanceTimersByTime(OUTBOX_EVERY_MS - 1);
    expect(sent).toEqual([['a']]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([['a'], ['b']]);
  });

  it('sends what it holds at once when the page goes away, and the wait does not send it again', () => {
    const { box, sent } = outbox();
    box.add('a');
    box.flush();
    expect(sent).toEqual([['a']]);
    box.flush(); // nothing held: nothing sent
    vi.advanceTimersByTime(OUTBOX_EVERY_MS);
    expect(sent).toEqual([['a']]);
  });

  it('forgets what it holds after a no', () => {
    const { box, sent } = outbox();
    box.add('a');
    box.drop();
    vi.advanceTimersByTime(OUTBOX_EVERY_MS);
    box.flush();
    expect(sent).toEqual([]);
  });

  it('sends a full batch at once, and waits anew for the next', () => {
    const { box, sent } = outbox();
    for (let i = 0; i < OUTBOX_MAX; i++) box.add(String(i));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(OUTBOX_MAX);
    box.add('next');
    vi.advanceTimersByTime(OUTBOX_EVERY_MS - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual(['next']);
  });
});
