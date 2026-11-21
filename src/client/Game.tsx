// The room's game on screen (client/game.ts, ADR 0014): the button that starts one from the call, and its tile beside
// the shares, which a click puts me in. The game itself is loaded only then (client/bonk.ts): three.js is big, and most
// visits never play.
import { Show, onSettled, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import posthog from './posthog';
import type { GameHandle } from './game';
import type { Face } from './bonk';
import type { GameName } from '../core/game';

/** The games, as the call offers them. */
const TITLES: Record<GameName, { title: string; icon: string; blurb: string }> = {
  bonk: { title: 'Bonk', icon: '🧊', blurb: 'Bonk your friends off a shrinking ice floe. Last one on it wins.' },
};

/** In the call's controls: a game for everyone in the call, in one click; while one goes on, a way into it. */
export function GameButtons(props: { game: GameHandle }) {
  return (
    <Show when={!props.game.joined()}>
      <div class="row">
        <Show when={props.game.now()} fallback={
          <button class="play" title={TITLES.bonk.blurb} onClick={() => { props.game.start('bonk'); posthog.capture('game_started', { game: 'bonk' }); }}>{TITLES.bonk.icon} Play {TITLES.bonk.title}</button>
        }>{(g) => (
          <button class="play" title={TITLES[g().game].blurb} onClick={() => { props.game.join(); posthog.capture('game_joined', { game: g().game }); }}>{TITLES[g().game].icon} Join {TITLES[g().game].title}</button>
        )}</Show>
      </div>
    </Show>
  );
}

/**
 * The call's game, beside the shares: who plays it, and a click to play too; while I play, the game itself. `faces`
 * shows the players' faces under it, as a share's viewers are shown.
 */
export function GameTile(props: { game: GameHandle; inCall: boolean; faceOf: (key: string) => Face; faces: JSX.Element }) {
  const g = () => props.game.now();
  const t = () => TITLES[g()?.game ?? 'bonk'];
  const joined = () => props.game.joined();
  const count = () => props.game.members().length;
  return (
    <div class={['share', 'game', joined() ? 'share-live' : props.inCall ? 'share-closed' : 'share-locked']} onClick={() => { if (!joined() && props.inCall) { props.game.join(); posthog.capture('game_joined', { game: g()?.game ?? 'bonk' }); } }}>
      <div class="share-head">
        <span class="game-title">{t().icon} {t().title}</span>
        <Show when={joined()}><button class="stop" title="Leave the game; it goes on for the others" onClick={(e) => { e.stopPropagation(); props.game.leave(); }}>Leave game</button></Show>
      </div>
      <Show when={joined()} fallback={
        <div class="share-note">
          <span>{t().blurb}<br /><b>{count() === 1 ? '1 friend plays' : `${count()} friends play`}. {props.inCall ? 'Click to play' : 'Join the call to play'}</b></span>
        </div>
      }>
        <GameView game={props.game} faceOf={props.faceOf} />
      </Show>
      <Show when={count() > 0}>
        <div class="share-bar game-bar" onClick={(e) => e.stopPropagation()}>{props.faces}<span class="share-stats">playing</span></div>
      </Show>
    </div>
  );
}

/** The game, loaded and mounted while I play it. */
function GameView(props: { game: GameHandle; faceOf: (key: string) => Face }) {
  let host: HTMLDivElement | undefined;
  onSettled(() => {
    let gone = false;
    let stop: (() => void) | undefined;
    const el = host;
    if (!el) return;
    void import('./bonk').then(({ mountBonk }) => {
      if (gone) return;
      stop = mountBonk(el, { me: props.game.me, links: props.game.links, faceOf: (key) => untrack(() => props.faceOf(key)) });
    }, (e: unknown) => console.error('loading the game failed', e));
    return () => { gone = true; stop?.(); };
  });
  return <div ref={host} class="bonk" onClick={(e) => e.stopPropagation()} />;
}
