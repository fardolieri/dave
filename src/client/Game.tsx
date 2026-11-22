// The room's games on screen (client/game.ts, ADR 0014): the buttons that start one from the call, and a tile for each
// game going on beside the shares, which a click puts me in. The game itself is loaded only then (client/bonk.ts, client/clink.ts): three.js
// is big, and most visits never play.
import { For, Show, createEffect, createSignal, onCleanup, onSettled, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import posthog from './posthog';
import type { GameHandle } from './game';
import type { Face } from './gamekit';
import { GAME_NAMES, type GameName } from '../core/game';
import type { GameLinks } from './gamelinks';
import { canFullscreen, exitFullscreenSafely, fullscreenElement, requestFullscreenSafely } from './fullscreen';

/** The games, as the call offers them. */
const TITLES: Record<GameName, { title: string; icon: string; blurb: string }> = {
  bonk: { title: 'Bonk', icon: '🧊', blurb: 'Bonk your friends off a shrinking ice floe. Last one on it wins.' },
  skid: { title: 'Skid', icon: '🏎️', blurb: 'A kart race, three laps. Drift round the bends to boost, grab items, beat your friends to the line.' },
  clink: { title: 'Clink', icon: '🪙', blurb: 'A tower of coins, everyone\'s chips on it. Grab before it falls. Most chips after ten climbs wins.' },
};

/** Each game, as loaded when someone plays it: a chunk of its own, three.js shared. */
type Mount = (host: HTMLElement, opts: { me: string; links: GameLinks; faceOf: (key: string) => Face }) => () => void;
const LOAD: Record<GameName, () => Promise<Mount>> = {
  bonk: () => import('./bonk').then((m) => m.mountBonk),
  skid: () => import('./skid').then((m) => m.mountSkid),
  clink: () => import('./clink').then((m) => m.mountClink),
};

/**
 * In the call's controls: a game for everyone in the call, in one click; for a kind going on already, a way into it.
 * Games of different kinds go on side by side. None while I play: I play one at a time.
 */
export function GameButtons(props: { game: GameHandle }) {
  return (
    <Show when={!props.game.playing()}>
      <div class="row">
        <For each={[...GAME_NAMES]}>{(name) => (
          <Show when={props.game.of(name)} fallback={
            <button class="play" title={TITLES[name].blurb} aria-label={`Play ${TITLES[name].title}`} onClick={() => { props.game.start(name); posthog.capture('game_started', { game: name }); }}>{TITLES[name].icon} {TITLES[name].title}</button>
          }>
            <button class="play" title={TITLES[name].blurb} onClick={() => { props.game.join(name); posthog.capture('game_joined', { game: name }); }}>{TITLES[name].icon} Join {TITLES[name].title}</button>
          </Show>
        )}</For>
      </div>
    </Show>
  );
}

/**
 * One of the call's games, beside the shares: who plays it, and a click to play too (out of mine, if I play another);
 * while I play it, the game itself. `faces` shows the players' faces under it, as a share's viewers are shown.
 */
export function GameTile(props: { name: GameName; game: GameHandle; inCall: boolean; faceOf: (key: string) => Face; faces: (keys: () => string[]) => JSX.Element }) {
  const name = untrack(() => props.name);
  const t = TITLES[name];
  const joined = () => props.game.playing() === name;
  const members = () => props.game.membersOf(name);
  const count = () => members().length;
  // Fullscreen: the tile, the game in it filling the screen, as a share's tile does (client/App.tsx); left with the game.
  let root: HTMLDivElement | undefined;
  const [fullscreen, setFullscreen] = createSignal(false);
  const onFsChange = () => {
    const on = root !== undefined && fullscreenElement() === root;
    setFullscreen(on);
    // The keys go to the game, not to the button that put it there.
    if (on) root?.querySelector<HTMLElement>('.bonk')?.focus({ preventScroll: true });
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  const holds = () => root !== undefined && fullscreenElement() === root;
  onCleanup(() => {
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    if (holds()) exitFullscreenSafely();
  });
  // Out of the game however it went (Leave game, another game, the call left, another tab): out of fullscreen with it.
  createEffect(joined, (on) => { if (!on && holds()) exitFullscreenSafely(); });
  return (
    <div ref={root} class={['share', 'game', joined() ? 'share-live' : props.inCall ? 'share-closed' : 'share-locked', { 'share-fs': fullscreen() }]} data-game={name} onClick={() => { if (!joined() && props.inCall) { props.game.join(name); posthog.capture('game_joined', { game: name }); } }}>
      <div class="share-head">
        <span class="game-title">{t.icon} {t.title}</span>
        <Show when={joined() && canFullscreen()}>
          <button class="stop fs" title={fullscreen() ? 'Leave fullscreen' : 'Fullscreen'} aria-label={fullscreen() ? 'Leave fullscreen' : 'Fullscreen'}
                  onClick={(e) => { e.stopPropagation(); if (fullscreen()) exitFullscreenSafely(); else if (root) requestFullscreenSafely(root); }}>{fullscreen() ? '⤡' : '⛶'}</button>
        </Show>
        <Show when={joined()}><button class="stop" title="Leave the game; it goes on for the others" onClick={(e) => { e.stopPropagation(); props.game.leave(); }}>Leave game</button></Show>
      </div>
      <Show when={joined()} fallback={
        <div class="share-note">
          <span>{t.blurb}<br /><b>{count() === 1 ? '1 friend plays' : `${count()} friends play`}. {props.inCall ? (props.game.playing() ? 'Click to play this instead' : 'Click to play') : 'Join the call to play'}</b></span>
        </div>
      }>
        {/* Made anew for another game of this kind: moved over to one started since (core/game.ts, `current`), I come in
            as a newcomer to it, never with the round of the one that ended */}
        <Show when={props.game.mine()?.id} keyed>{(_id) => <GameView name={name} game={props.game} faceOf={props.faceOf} />}</Show>
      </Show>
      <Show when={count() > 0}>
        <div class="share-bar game-bar" onClick={(e) => e.stopPropagation()}>{props.faces(members)}<span class="share-stats">playing</span></div>
      </Show>
    </div>
  );
}

/** The game, loaded and mounted while I play it. */
function GameView(props: { name: GameName; game: GameHandle; faceOf: (key: string) => Face }) {
  let host: HTMLDivElement | undefined;
  const name = untrack(() => props.name);
  onSettled(() => {
    let gone = false;
    let stop: (() => void) | undefined;
    const el = host;
    if (!el) return;
    void LOAD[name]().then((mount) => {
      if (gone) return;
      stop = mount(el, { me: props.game.me, links: props.game.links, faceOf: (key) => untrack(() => props.faceOf(key)) });
    }, (e: unknown) => console.error('loading the game failed', e));
    return () => { gone = true; stop?.(); };
  });
  return <div ref={host} class="bonk" onClick={(e) => e.stopPropagation()} />;
}
