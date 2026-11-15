// YouTube's embedded player, driven by the messages its iframe takes and sends when its address has `enablejsapi=1`: the
// protocol YouTube's own iframe API script speaks. That script is not loaded: it would run YouTube's code in this page,
// which holds the rooms' keys. The player tells its state and time by itself after a `listening`.

import { PLAYING, UNSTARTED, type PlayerReport } from '../core/partysync';

export const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com';

export type Player = {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  rate(rate: number): void;
  mute(): void;
  unMute(): void;
  /** Another video, from `seconds`: played, or held there. */
  load(video: string, seconds: number, playing: boolean): void;
  /** Where the video is now, as of the last report: further on by the time since, while it plays. */
  now(): number;
  report(): PlayerReport | null;
  dispose(): void;
};

/** The player's address for a video, its messages to this page's origin. */
export const playerSrc = (video: string): string =>
  `${YOUTUBE_ORIGIN}/embed/${video}?enablejsapi=1&playsinline=1&rel=0&origin=${encodeURIComponent(location.origin)}`;

/**
 * Opens `video` in `frame` (an iframe with no address yet) and talks to its player. `on.ready` once it answers,
 * `on.report` with each thing it says of its state, time or speed (the report before it, and whether this one told the
 * time, and the state: one that does not keeps the state told before), `on.error` with YouTube's code (101 and 150: the video may not be embedded, or YouTube refuses this browser).
 */
export function connectPlayer(frame: HTMLIFrameElement, video: string, on: {
  ready: () => void; report: (before: PlayerReport | null, now: PlayerReport, timed: boolean, stated: boolean) => void; error: (code: number) => void;
}): Player {
  let last: PlayerReport | null = null;
  let ready = false;
  let disposed = false;
  const post = (message: object) => frame.contentWindow?.postMessage(JSON.stringify({ ...message, id: 1, channel: 'widget' }), YOUTUBE_ORIGIN);
  const command = (func: string, args: unknown[] = []) => post({ event: 'command', func, args });
  const update = (info: Record<string, unknown>) => {
    const before = last;
    const now: PlayerReport = {
      state: typeof info['playerState'] === 'number' ? info['playerState'] : before?.state ?? UNSTARTED,
      time: typeof info['currentTime'] === 'number' ? info['currentTime'] : before ? extrapolate(before) : 0,
      rate: typeof info['playbackRate'] === 'number' ? info['playbackRate'] : before?.rate ?? 1,
      duration: typeof info['duration'] === 'number' ? info['duration'] : before?.duration ?? 0,
      muted: typeof info['muted'] === 'boolean' ? info['muted'] : before?.muted ?? false,
      at: performance.now(),
    };
    last = now;
    on.report(before, now, typeof info['currentTime'] === 'number', typeof info['playerState'] === 'number');
  };
  const extrapolate = (r: PlayerReport): number => (r.state === PLAYING ? r.time + ((performance.now() - r.at) / 1000) * r.rate : r.time);
  const onMessage = (e: MessageEvent) => {
    if (disposed || e.origin !== YOUTUBE_ORIGIN || e.source !== frame.contentWindow || typeof e.data !== 'string') return;
    let m: { event?: unknown; info?: unknown };
    try { m = JSON.parse(e.data) as typeof m; } catch { return; }
    if (m.event === 'onReady' || m.event === 'initialDelivery') {
      if (m.info && typeof m.info === 'object') update(m.info as Record<string, unknown>);
      // Its errors are told unasked only for the video it opened on: asked for, for every video it is given after.
      if (!ready) { ready = true; command('addEventListener', ['onError']); on.ready(); }
    } else if (m.event === 'infoDelivery' && m.info && typeof m.info === 'object') update(m.info as Record<string, unknown>);
    else if (m.event === 'onStateChange' && typeof m.info === 'number') update({ playerState: m.info });
    else if (m.event === 'onPlaybackRateChange' && typeof m.info === 'number') update({ playbackRate: m.info });
    else if (m.event === 'onError' && typeof m.info === 'number') on.error(m.info);
  };
  window.addEventListener('message', onMessage);
  // The player answers only once it has heard `listening`, which may go before it is ready to hear: said again until it
  // answers. Not before the frame has the player's page: a message to the blank page before it goes nowhere, with a warning.
  let hello: ReturnType<typeof setInterval> | undefined;
  frame.addEventListener('load', () => {
    if (disposed || hello !== undefined) return;
    post({ event: 'listening' });
    hello = setInterval(() => { if (ready || disposed) clearInterval(hello); else post({ event: 'listening' }); }, 250);
  });
  frame.src = playerSrc(video);
  return {
    play: () => command('playVideo'),
    pause: () => command('pauseVideo'),
    seek: (seconds) => command('seekTo', [seconds, true]),
    rate: (rate) => command('setPlaybackRate', [rate]),
    mute: () => command('mute'),
    unMute: () => command('unMute'),
    load: (video, seconds, playing) => command(playing ? 'loadVideoById' : 'cueVideoById', [{ videoId: video, startSeconds: seconds }]),
    now: () => (last ? extrapolate(last) : 0),
    report: () => last,
    dispose: () => { disposed = true; clearInterval(hello); window.removeEventListener('message', onMessage); },
  };
}
