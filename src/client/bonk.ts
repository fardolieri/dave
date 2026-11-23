// Bonk on screen (core/bonk.ts): my ball, everyone else's as their apps say, the floe and the sea, in three.js; the keys,
// a stick on a touch screen, the mouse held followed, the sounds; the round and its items, run by its leader, who moves
// the mystery ball too. Loaded only once a friend plays (client/Game.tsx): three.js is most of a megabyte.
import * as THREE from 'three';
import {
  BALL_RADIUS, DROP_Y, FELT_HIT, FLOE_START, RESPAWN_MS, SUNK_Y, BONK_AGAIN_MS, advance, ahead, ask, ballAt, ballFrame, bonk, dash, dropDue, dropIn, dropTime, dropped, dropsLeft, effectsOf, fastFrom,
  firstRound, firstStage, floeRadius, gigaPower, gigaTier, gone, hitFrame, itemFrame, itemOf, knocked, leaderOf, movesOf, parseFrame, playClock, pushFrame, roll, roundOf, spawnAt, speedAt,
  stageFrame, stageOf, stageOfFrame, steer, toward, touched, whoOf, COUNT_MS, ITEMS, type Ball, type BallFrame, type Counted, type GameView, type Item, type Round, type Stage,
} from '../core/bonk';
import type { GameLinks } from './gamelinks';
import { exposeHooks } from './hooks';
import { colourOf, isSoftware, isTyping, nameTag, popWord, skin, splash, thump, type Face } from './gamekit';


/** How often my ball goes to the others, and the round from its leader. */
const SEND_MS = 50;
const ROUND_SEND_MS = 250;
/** A player not heard from for this long is out of the game, for the rounds: a hidden tab, a link gone. */
const HEARD_MS = 2500;
/** The longest step the simulation takes at once; a longer gap (a hidden tab) is cut to it. */
const MAX_STEP_S = 0.05;
/**
 * The most pixels drawn for each CSS pixel: a phone's screen has three, and filling them all, lit and shadowed, is most of
 * what a phone's GPU does for the game. Lite (`goLite`), one.
 */
const PIXEL_RATIO = 2;
const TOUCH_PIXEL_RATIO = 1.5;
/** A device whose middle frame of its first FRAMES_JUDGED is slower than this (ms, so 40 a second) goes lite. */
const LITE_FRAME_MS = 25;
const FRAMES_JUDGED = 90;

type Other = { frame: BallFrame; at: number; key: string };

/**
 * How a giga looks, by how mighty it is (core `gigaTier`): what the HUD calls it, the word its bonk pops, and its colour.
 * The power itself is never shown: a ball's glow says how bad it is.
 */
const GIGA_LOOKS = [
  { name: 'Giga', word: 'GIGA BONK!', colour: '#c3ccd4' },
  { name: 'Super giga', word: 'SUPER BONK!', colour: '#3ab0ff' },
  { name: 'Mega giga', word: 'MEGA BONK!!', colour: '#a259ff' },
  { name: 'Ultra giga', word: 'ULTRA BONK!!', colour: '#ff4fd8' },
  { name: 'Hyper giga', word: 'HYPER BONK!!!', colour: '#ff3b3b' },
  { name: 'LEGENDARY giga', word: 'LEGENDARY!!!', colour: '#ffd23f' },
] as const;
const lookOf = (power: number) => GIGA_LOOKS[Math.max(0, gigaTier(power))]!;

/** How an item is named, on the HUD, and what a ball that got it wears by its name. */
const ITEM_LOOKS: Record<Item, { name: string; word: string; mark: string; colour: string }> = {
  giga: { name: 'a giga', word: 'GIGA!', mark: '', colour: '#ff4fd8' },
  heavy: { name: 'Heavy', word: 'HEAVY!', mark: '🏋️', colour: '#8a95a5' },
  handling: { name: 'Handling+', word: 'HANDLING+!', mark: '🛼', colour: '#3ad6ff' },
  fast: { name: 'Double speed', word: 'DOUBLE SPEED!', mark: '⚡', colour: '#ffd23f' },
};
/** How long a mystery ball gone off the floe is shown sinking once its leader is no longer heard of it. */
const ITEM_SUNK_MS = 1000;


/**
 * Bonk, in `host`, for me (`me`, my key), over `links` to the other players. `faceOf` names and pictures a player. Returns
 * how to stop it.
 */
export function mountBonk(host: HTMLElement, opts: { me: string; links: GameLinks; faceOf: (key: string) => Face }): () => void {
  const { me, links } = opts;
  const myWho = whoOf(me);
  const others = new Map<string, Other>();
  let ball: Ball = { ...ballAt(0, 0), ...spawnAt(0, 1) };
  /** The round I play; 0 while I watch one or none is on. */
  let playing = 0;
  let round: Round = firstRound(performance.now());
  /**
   * Whose round frames I take, and the newest of each: by its sender's clock (ms), so a leader who reloads, and counts
   * again, still counts on from where they were.
   */
  const roundSeq = new Map<string, number>();
  let sentRound = 0;
  let leader: string | null = me;
  let fellAt: number | null = null;
  let lastFloe = FLOE_START;
  /** How the keys steer, the stick if one is on, and how the game steers in the end: toward the spot held, if one is, else by the stick, else the keys. */
  let keyed = { x: 0, z: 0 };
  let sticked: { x: number; z: number } | null = null;
  let input = { x: 0, z: 0 };
  let dashAsked = false;
  let dashed = false;
  /** My last dash, which way it went, for the test hooks: the ball may be in the sea and back by the time they look. */
  let lastDash: { vx: number; vz: number } | null = null;
  let last = performance.now();
  let lastSent = 0;
  let lastRoundSent = 0;
  let shake = 0;
  /** When my ball last bonked each other player's, either app's working out: the same bonk is not taken twice. */
  const bonkedAt = new Map<string, number>();
  /** For a bonk, the giga it spent (0 for none), to say so. */
  const events: { x: number; z: number; hard: number; giga: number }[] = [];
  /** My ball's giga (core `gigaPower`, 0 for none), got from a mystery ball, spent by its next felt bonk. */
  let giga = 0;
  /** The felt bonks my ball had with others' in the game, which the leader counts toward the next mystery ball. */
  let felt = 0;
  /** A felt bonk my ball had with another's (core FELT_HIT): one more, and its giga spent by it. */
  const hadBonk = (spent: boolean) => { felt++; if (spent) giga = 0; };

  // The items. The stage as the leader has it (core `Stage`); the mystery ball, moved by the leader's app (mine when I
  // lead) and as its frames say otherwise, with when it was last heard of; what its next one holds, for the test hooks.
  let stage: Stage = firstStage(dropIn(Math.random()));
  let item: { id: number; ball: Ball; at: number } | null = null;
  let forced: Item | null = null;
  let forcedAt = { x: 0, z: 0, y: DROP_Y };
  /**
   * The felt bonks of each ball, mine (`felt`) and the others' from their frames, as last counted into the stage's
   * (core `Stage`, `bonks`), by the leader. Every app keeps up with them, so a new leader counts on from what is new.
   */
  let feltCounted = 0;
  const feltSeen = new Map<string, number>();
  /** Which gigas got from mystery balls I have taken, and which gots were said: by round and id. */
  const gigasTaken = new Set<string>();
  const gotSaid = new Set<string>();
  /** The stage of the round on now: what was got in the last round counts no more, nor once it is back to waiting. */
  const current = (): Stage => stageOf(stage, round.n);
  const lasting = (): Stage => (round.phase === 'wait' ? { ...current(), got: [] } : current());
  const fastNow = () => (round.phase === 'play' ? fastFrom(current()) : null);
  /** A mystery ball falls in the middle, from the sky: by the leader's app only. */
  const dropItem = (at = { x: 0, z: 0, y: DROP_Y }) => { stage = dropped(current(), dropIn(Math.random())); item = { id: stage.ball, ball: { ...ballAt(at.x, at.z), y: at.y }, at: performance.now() }; lastRoundSent = 0; };
  /** How a bonk sounds and shakes: a giga one as hard as they come, and the mightier, the more (`spent`, its power). */
  const feel = (hard: number, spent: number) => {
    if (!spent) { thump(hard); shake = Math.min(0.6, shake + hard * 0.04); return; }
    const tier = gigaTier(spent);
    thump(15);
    if (tier >= 2) thump(15, true);
    shake = Math.max(shake, calm.matches ? Math.min(0.6, 0.4 + tier * 0.15) : 0.4 + tier * 0.15);
  };

  // The round: who plays it, where they start, and what I do in it.
  const took = (next: Round, now: number) => {
    const was = round;
    round = next;
    if (next.n === was.n && next.phase === was.phase) return;
    if (next.phase === 'count') {
      const i = next.players.indexOf(myWho);
      if (i >= 0) { playing = next.n; ball = { ...ballAt(0, 0), ...spawnAt(i, next.players.length) }; fellAt = null; }
      else { playing = 0; ball = { ...ball, alive: false, y: SUNK_Y }; }
    } else if (next.phase === 'play' && playing !== next.n) {
      // Came in after the countdown: this round is watched.
      playing = 0;
      ball = { ...ball, alive: false, y: SUNK_Y };
    } else if (next.phase === 'wait') {
      playing = 0;
      if (!ball.alive) { ball = { ...ballAt(0, 0), ...spawnAt(0, 1) }; fellAt = null; }
    } else if (next.phase === 'over') {
      lastFloe = floeRadius('play', playClock(now - was.since, was.n === stage.n ? fastFrom(stage) : null), lastFloe);
      if (next.winner === myWho) thump(6, true);
    }
  };

  const heard = (now: number): Other[] => [...others.values()].filter((o) => now - o.at < HEARD_MS);

  const offFrames = links.listen((from, data) => {
    const f = parseFrame(data);
    if (!f) return;
    const now = performance.now();
    if (f.k === 'b') {
      others.set(from, { frame: f, at: now, key: from });
      const seen = feltSeen.get(from);
      if (f.c !== undefined) {
        if (leader === me && seen !== undefined && f.c > seen) stage = { ...stage, bonks: stage.bonks + f.c - seen };
        feltSeen.set(from, f.c);
      }
      return;
    }
    if (f.k === 'i') {
      // The mystery ball, from the leader's app: mine moves it when I lead.
      if (from !== leader || leader === me) return;
      item = { id: f.id, ball: { ...ballAt(f.x, f.z), vx: f.vx, vz: f.vz, y: f.y, vy: f.vy, alive: f.a }, at: now };
      return;
    }
    if (f.k === 'p') {
      // A bonk another app worked out between its ball and the mystery ball: given to the ball, which it touched last.
      if (leader !== me || !item || item.id !== f.id || stage.ball !== f.id) return;
      item.ball = knocked(item.ball, f);
      stage = touched(stage, f.id, whoOf(from));
      return;
    }
    if (f.k === 'd') {
      if (leader === me && f.n === round.n) { stage = ask(current(), round, whoOf(from), now); lastRoundSent = 0; }
      return;
    }
    if (f.k === 'h') {
      // A bonk the other app worked out, for my ball: taken unless mine worked out the same one a moment ago.
      if (f.to !== myWho || now - (bonkedAt.get(from) ?? -Infinity) < BONK_AGAIN_MS || !ball.alive) return;
      bonkedAt.set(from, now);
      ball = knocked(ball, f);
      // My giga is spent only if their app saw it, and used it: else it waits for the next bonk.
      if (f.hit >= FELT_HIT) hadBonk((f.u ?? 0) > 0);
      const spent = Math.max(f.g ?? 0, f.u ?? 0);
      events.push({ x: ball.x, z: ball.z, hard: f.hit, giga: spent });
      feel(f.hit, spent);
      return;
    }
    // A round frame: the leader's only, and no older than the last of theirs.
    if (from !== leader || f.q <= (roundSeq.get(from) ?? -1)) return;
    roundSeq.set(from, f.q);
    const next = roundOf(f, now);
    // The same phase as I have it: the time it began stays put, unless it is well off, so the floe does not judder.
    took(next.n === round.n && next.phase === round.phase && Math.abs(next.since - round.since) < 150 ? { ...next, since: round.since } : next, now);
    const st = stageOfFrame(f);
    if (st) stage = st;
  });

  function step(now: number): void {
    let dt = (now - last) / 1000;
    last = now;
    aimAt = held?.at ?? null;
    input = aimAt ? toward(ball, aimAt) : sticked ?? keyed;
    // A dash with a spot held, or by the mouse's right button, goes for that spot.
    const dashTo = aimAt ?? dashAim;
    const around = heard(now);
    leader = leaderOf([{ key: me, n: round.n }, ...around.map((o) => ({ key: o.key, n: o.frame.n }))]);
    if (leader === me) {
      const counted: Counted[] = [{ who: myWho, n: playing, known: round.n, alive: ball.alive }, ...around.map((o) => ({ who: whoOf(o.key), n: o.frame.r, known: o.frame.n, alive: o.frame.a }))];
      const next = advance(round, now, counted);
      if (next !== round) { took(next, now); lastRoundSent = 0; }
      stage = { ...current(), bonks: current().bonks + felt - feltCounted };
      feltCounted = felt;
      // A mystery ball the stage has that this app never heard where it is (it took over from a leader it did not hear
      // of it): gone, so another may fall.
      if (stage.ball !== 0 && item?.id !== stage.ball) stage = { ...stage, ball: 0, by: null };
      // The mystery balls: one asked for falls at the go, and one when the game's bonks come to the next draw; none
      // outlasts the play.
      if (round.phase === 'play') {
        if (!item && stage.ball === 0 && (stage.waiting || dropDue(stage) || forced)) dropItem(forced && !stage.waiting ? forcedAt : undefined);
      } else if (item || stage.ball !== 0) { item = null; stage = { ...stage, ball: 0, by: null }; }
      if (now - lastRoundSent >= ROUND_SEND_MS) { sentRound = Math.max(Date.now(), sentRound + 1); links.broadcast(JSON.stringify(stageFrame(round, stage, now, sentRound))); lastRoundSent = now; }
    } else {
      feltCounted = felt;
      // Kept while the stage has it, though its leader goes quiet a while (a hidden tab), so a new one goes on with it;
      // once off the floe, until it has sunk.
      if (item && (round.phase !== 'play' || (current().ball !== item.id && now - item.at > ITEM_SUNK_MS))) item = null;
    }
    const ms = now - round.since;
    const fast = fastNow();
    const speed = round.phase === 'play' ? speedAt(ms, fast) : 1;
    const floe = floeRadius(round.phase, playClock(ms, fast), lastFloe);
    const moves = movesOf(effectsOf(lasting(), myWho));
    const massOf = new Map(around.map((o) => [o.key, movesOf(effectsOf(lasting(), whoOf(o.key))).mass]));
    // A giga got from a mystery ball: mine, once.
    for (const g of current().got) {
      const id = `${current().n}:${g.id}`;
      if (g.who === myWho && g.item === 'giga' && !gigasTaken.has(id)) { gigasTaken.add(id); giga = Math.max(giga, g.power); }
    }
    const watching = playing === 0 && (round.phase === 'count' || round.phase === 'play');
    if (watching) { dashAsked = false; dashAim = null; }
    // The mystery ball, by the leader's app: rolled as a ball nobody steers, until it is off the floe, when what was in
    // it goes to who bonked it last; and on until it has sunk.
    if (leader === me && item) {
      let left = dt;
      while (left > 0) {
        const h = Math.min(left, MAX_STEP_S / 3);
        left -= h;
        const wasAlive = item.ball.alive;
        item.ball = roll(item.ball, { x: 0, z: 0 }, h * speed, floe);
        if (wasAlive && !item.ball.alive && stage.ball === item.id) {
          stage = gone(stage, playClock(ms, fast), forced ?? itemOf(Math.random()), gigaPower(Math.random()));
          forced = null;
          lastRoundSent = 0;
        }
      }
      item.at = now;
      if (item.ball.y <= SUNK_Y) item = null;
    }
    while (dt > 0 && !watching) {
      const h = Math.min(dt, MAX_STEP_S / 3);
      dt -= h;
      if (round.phase === 'count') break; // standing at the start, until the go
      if (dashAsked) { const d = dash(ball, dashTo ? { x: dashTo.x - ball.x, z: dashTo.z - ball.z } : input, now); if (d !== ball) { ball = d; dashed = true; lastDash = { vx: d.vx, vz: d.vz }; thump(2, true); } dashAsked = false; dashAim = null; }
      const wasAlive = ball.alive;
      ball = roll(ball, input, h * speed, floe, moves);
      if (wasAlive && !ball.alive) fellAt = now;
      for (const o of around) {
        const f = o.frame;
        // Between rounds everyone bonks everyone; in a round, only those playing it.
        if (!f.a || (round.phase === 'play' && f.r !== playing)) continue;
        const met = bonk(ball, ahead({ x: f.x, z: f.z, vx: f.vx, vz: f.vz, alive: true, y: f.y }, (now - o.at) * speed), giga, f.g ?? 0, moves.mass, massOf.get(o.key) ?? 1);
        if (met.hit === 0) { ball = met.ball; continue; }
        // Taken a moment ago, from either side: only kept apart.
        if (now - (bonkedAt.get(o.key) ?? -Infinity) < BONK_AGAIN_MS) { ball = { ...ball, x: met.ball.x, z: met.ball.z }; continue; }
        ball = met.ball;
        bonkedAt.set(o.key, now);
        links.sendTo(o.key, JSON.stringify(hitFrame(o.key, met.knock, met.hit, met.spent)));
        if (met.hit >= FELT_HIT) {
          hadBonk(met.spent.mine > 0);
          const spent = Math.max(met.spent.mine, met.spent.theirs);
          events.push({ x: (ball.x + f.x) / 2, z: (ball.z + f.z) / 2, hard: met.hit, giga: spent });
          feel(met.hit, spent);
        }
      }
      // The mystery ball: its knock goes to the leader's app, which moves it, and to mine at once, until it says.
      if (item && item.ball.alive && round.phase === 'play') {
        const seen = leader === me ? item.ball : ahead(item.ball, (now - item.at) * speed);
        const met = bonk(ball, seen, giga, 0, moves.mass, 1);
        if (met.hit === 0) ball = met.ball;
        else if (now - (bonkedAt.get('item') ?? -Infinity) < BONK_AGAIN_MS) ball = { ...ball, x: met.ball.x, z: met.ball.z };
        else {
          ball = met.ball;
          bonkedAt.set('item', now);
          item.ball = knocked(item.ball, met.knock);
          if (leader === me) stage = touched(stage, item.id, myWho);
          else if (leader) links.sendTo(leader, JSON.stringify(pushFrame(item.id, met.knock)));
          if (met.hit >= FELT_HIT) {
            if (met.spent.mine) giga = 0;
            events.push({ x: (ball.x + seen.x) / 2, z: (ball.z + seen.z) / 2, hard: met.hit, giga: met.spent.mine });
            feel(met.hit, met.spent.mine);
          }
        }
      }
    }
    // Fell off between rounds: back in a moment.
    if (!ball.alive && fellAt !== null && now - fellAt > RESPAWN_MS && round.phase === 'wait') {
      const a = Math.random() * Math.PI * 2;
      ball = ballAt(Math.cos(a) * FLOE_START * 0.5, Math.sin(a) * FLOE_START * 0.5);
      fellAt = null;
    }
    if (now - lastSent >= SEND_MS) {
      links.broadcast(JSON.stringify(ballFrame(watching ? { ...ball, alive: false, y: SUNK_Y } : ball, playing, round.n, dashed, giga, felt)));
      if (leader === me && item) links.broadcast(JSON.stringify(itemFrame(item.id, item.ball)));
      dashed = false;
      lastSent = now;
    }
  }

  // Keys while the game has the focus; a stick on a touch screen.
  const keys = new Set<string>();
  const fromKeys = () => {
    const x = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    const z = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0);
    keyed = steer(x, z);
  };
  const MOVE_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); fromKeys(); e.preventDefault(); }
    else if (e.code === 'Space') { dashAsked = true; e.preventDefault(); }
    else if (e.code === 'KeyE' && canDrop()) { drop(); e.preventDefault(); }
  };
  const onKeyUp = (e: KeyboardEvent) => { if (keys.delete(e.code)) fromKeys(); };
  // A let-go in another window may send nothing back: a hold ends with the focus.
  const onBlur = () => { keys.clear(); fromKeys(); held = null; };
  host.tabIndex = 0;
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  host.addEventListener('blur', onBlur);

  // The HUD: what is going on, the wins, how to play, and the dash button on a touch screen.
  const hud = document.createElement('div');
  hud.className = 'bonk-hud';
  const banner = document.createElement('div');
  banner.className = 'bonk-banner';
  const board = document.createElement('ol');
  board.className = 'bonk-board';
  board.setAttribute('aria-label', 'Rounds won');
  const gigaBadge = document.createElement('div');
  gigaBadge.className = 'bonk-giga';
  /** The whole game lit up by a giga bonk, the mightier the brighter and longer: unless motion is asked to be kept down. */
  const gigaFlash = document.createElement('div');
  gigaFlash.className = 'bonk-flash';
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const flashOf = (colour: string, opacity: number, ms: number) => {
    if (calm.matches || !gigaFlash.animate) return;
    gigaFlash.style.background = colour;
    gigaFlash.animate([{ opacity }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
  };
  const flash = (power: number) => { const tier = gigaTier(power); flashOf(lookOf(power).colour, 0.15 + tier * 0.1, 250 + tier * 150); };
  const say = (text: string, now: number) => { toast.textContent = text; toastUntil = now + 5000; };
  const help = document.createElement('div');
  help.className = 'bonk-help';
  help.textContent = 'Arrows, WASD or the mouse held to roll · Space or the right button to dash · bonk everyone into the sea';
  const dashButton = document.createElement('button');
  dashButton.type = 'button';
  dashButton.className = 'bonk-dash';
  dashButton.textContent = 'Dash';
  dashButton.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); dashAsked = true; });
  const stick = document.createElement('div');
  stick.className = 'bonk-stick';
  // The items: what I got that lasts the round, and double speed; a drop my wins earned, while a round counts down; and
  // who got what, for a moment.
  const effectsLine = document.createElement('div');
  effectsLine.className = 'bonk-effects';
  // Only a present on it, in a corner: what it does is for the players to find out (a mystery too). Hidden till then.
  const dropButton = document.createElement('button');
  dropButton.type = 'button';
  dropButton.className = 'bonk-drop';
  dropButton.hidden = true;
  dropButton.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (canDrop()) drop(); });
  dropButton.addEventListener('click', () => { if (canDrop()) drop(); });
  const toast = document.createElement('div');
  toast.className = 'bonk-toast';
  toast.setAttribute('role', 'status');
  let toastUntil = 0;
  hud.append(gigaFlash, banner, gigaBadge, effectsLine, board, help, dashButton, dropButton, toast, stick);
  host.append(hud);

  /** Whether I may drop a mystery ball now: at the start of a round I play (core `dropTime`), one my wins earned, none dropped yet. */
  let dropSent = 0;
  const canDrop = () => {
    const st = current();
    return dropTime(round, performance.now()) && playing === round.n && st.asked === null && st.ball === 0 && dropSent !== round.n && dropsLeft(round.wins[myWho] ?? 0, st.used[myWho] ?? 0) > 0;
  };
  const drop = () => {
    dropSent = round.n;
    if (leader === me) { stage = ask(current(), round, myWho, performance.now()); lastRoundSent = 0; }
    else if (leader) links.sendTo(leader, JSON.stringify({ k: 'd', n: round.n }));
  };

  // A mouse there (a desktop, or a tablet with one): the camera for it, below. A finger on one still gets the stick.
  const desk = matchMedia('(any-pointer: fine)').matches;
  // A stick where a finger goes down; the mouse's left button held, which the ball rolls toward, the spot under it on the
  // floe worked out when it goes down or moves (the camera holds still on a desktop, so the mouse stays over its spot);
  // and the spot of a dash by the right button.
  let touch: { id: number; x: number; y: number } | null = null;
  let held: { id: number; at: { x: number; z: number } | null } | null = null;
  let dashAim: { x: number; z: number } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    host.focus({ preventScroll: true });
    if (e.pointerType === 'mouse') {
      if (e.button === 2) { dashAsked = true; dashAim = aim(e.clientX, e.clientY); return; }
      if (e.button !== 0 || held) return;
      held = { id: e.pointerId, at: aim(e.clientX, e.clientY) };
      try { host.setPointerCapture(e.pointerId); } catch { /* gone already */ }
      return;
    }
    host.classList.add('bonk-touch');
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stick.style.left = `${e.clientX - host.getBoundingClientRect().left}px`;
    stick.style.top = `${e.clientY - host.getBoundingClientRect().top}px`;
    stick.classList.add('on');
    sticked = { x: 0, z: 0 };
  };
  const onPointerMove = (e: PointerEvent) => {
    // A mouse button pressed or let go while another is down comes as a move, not a press or a let-go; and a let-go
    // somewhere else (another window) may come as nothing at all: a mouse hold lasts only while the left button is down.
    if (e.pointerType === 'mouse' && held?.id === e.pointerId && !(e.buttons & 1)) held = null;
    if (e.pointerType === 'mouse' && e.target instanceof Node && host.contains(e.target)) {
      if (e.button === 2 && e.buttons & 2) { dashAsked = true; dashAim = aim(e.clientX, e.clientY); }
      if (e.button === 0 && e.buttons & 1 && !held) { held = { id: e.pointerId, at: null }; try { host.setPointerCapture(e.pointerId); } catch { /* gone already */ } }
    }
    if (held?.id === e.pointerId) held = { ...held, at: aim(e.clientX, e.clientY) };
    if (touch?.id === e.pointerId) sticked = steer((e.clientX - touch.x) / 45, (e.clientY - touch.y) / 45);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (held?.id === e.pointerId) held = null;
    if (touch?.id === e.pointerId) { touch = null; sticked = null; stick.classList.remove('on'); }
  };
  // Only the game's own capture of the mouse: a finger's, on what it went down on, ends no hold.
  const onLostCapture = (e: PointerEvent) => { if (e.target === host) onPointerUp(e); };
  // No menu for the right button on the game, nor over the page while the game holds the mouse.
  const onContextMenu = (e: Event) => { if (held || (e.target instanceof Node && host.contains(e.target))) e.preventDefault(); };
  host.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('lostpointercapture', onLostCapture);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // The scene, in WebGL 2, which three.js needs. A browser without it plays all the same, blind, and the HUD says so;
  // asked here first, so three.js does not fail at it out loud.
  let renderer: THREE.WebGLRenderer | null = null;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  try {
    renderer = context ? new THREE.WebGLRenderer({ canvas, context, antialias: true }) : null;
  } catch {
    renderer = null;
  }
  const scene = new THREE.Scene();
  const sky = new THREE.Color('#bfe6ff');
  scene.background = sky;
  const fog = new THREE.Fog(sky, 30, 70);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  scene.add(new THREE.HemisphereLight('#ffffff', '#2d5f80', 1.6));
  const sun = new THREE.DirectionalLight('#fff6e0', 2.2);
  sun.position.set(-8, 18, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
  scene.add(sun);

  // The sea's waves roll in its vertex shader: worked out here for every point, with its normals, they took a phone
  // longer than a frame has. Flat shaded, its faces are lit by where its points are, so normals are never needed. The
  // shadows land on the floe only: on the water, where only a ball going under casts one, every pixel paid for them.
  const seaGeometry = new THREE.PlaneGeometry(160, 160, 80, 80);
  seaGeometry.rotateX(-Math.PI / 2);
  const seaMaterial = new THREE.MeshStandardMaterial({ color: '#1f7fb8', roughness: 0.35, metalness: 0.05, flatShading: true });
  /** The waves' clock, in seconds since the game began: a float in the shader, so kept small. */
  const seaTime = { value: 0 };
  let seaClock = 0;
  seaMaterial.onBeforeCompile = (shader) => {
    shader.uniforms['seaTime'] = seaTime;
    shader.vertexShader = `uniform float seaTime;\n${shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed.y = sin(position.x * 0.35 + seaTime * 1.3) * 0.18 + cos(position.z * 0.3 + seaTime * 0.9) * 0.18;`)}`;
  };
  const sea = new THREE.Mesh(seaGeometry, seaMaterial);
  sea.position.y = -0.7;
  scene.add(sea);

  const floe = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.04, 0.6, 72), new THREE.MeshStandardMaterial({ color: '#f4fbff', roughness: 0.3 }));
  top.position.y = -0.3;
  top.receiveShadow = true;
  const under = new THREE.Mesh(new THREE.CylinderGeometry(1.04, 0.7, 1.8, 72), new THREE.MeshStandardMaterial({ color: '#9fd6f2', roughness: 0.15, transparent: true, opacity: 0.85 }));
  under.position.y = -1.5;
  floe.add(top, under);
  scene.add(floe);
  // Cracks of a darker blue round the edge, a ring that shows where the floe ends.
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 72), new THREE.MeshBasicMaterial({ color: '#6fb6dd' }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.005;
  floe.add(rim);

  const snowCount = 500;
  const snowGeometry = new THREE.BufferGeometry();
  const snowAt = new Float32Array(snowCount * 3);
  for (let i = 0; i < snowCount; i++) { snowAt[i * 3] = (Math.random() - 0.5) * 50; snowAt[i * 3 + 1] = Math.random() * 20; snowAt[i * 3 + 2] = (Math.random() - 0.5) * 50; }
  snowGeometry.setAttribute('position', new THREE.BufferAttribute(snowAt, 3));
  const snow = new THREE.Points(snowGeometry, new THREE.PointsMaterial({ color: '#ffffff', size: 0.12, transparent: true, opacity: 0.85 }));
  scene.add(snow);

  // Where the mouse is held, on the floe.
  let aimAt: { x: number; z: number } | null = null;
  const raycaster = new THREE.Raycaster();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const pointed = new THREE.Vector2();
  function aim(clientX: number, clientY: number): { x: number; z: number } | null {
    const r = host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    raycaster.setFromCamera(pointed.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
    return raycaster.ray.intersectPlane(floor, hit) ? { x: hit.x, z: hit.z } : null;
  }
  const aimRing = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 32), new THREE.MeshBasicMaterial({ color: '#ffc400', transparent: true, opacity: 0.7, depthTest: false }));
  aimRing.rotation.x = -Math.PI / 2;
  aimRing.renderOrder = 9;
  scene.add(aimRing);

  const marker = new THREE.Mesh(new THREE.RingGeometry(BALL_RADIUS * 1.15, BALL_RADIUS * 1.4, 40), new THREE.MeshBasicMaterial({ color: '#ffc400', transparent: true, opacity: 0.85 }));
  marker.rotation.x = -Math.PI / 2;
  scene.add(marker);

  /** A ball on screen; `glow` and `rings`, round it while it is giga (`giga`, its power as last seen). */
  type Shown = {
    group: THREE.Group; body: THREE.Mesh; tag: THREE.Sprite; glow: THREE.Mesh; rings: THREE.Mesh[];
    face: string; x: number; z: number; y: number; splashed: boolean; flash: number; giga: number;
    /** The name under the tag, with the marks of what its ball got (`ITEM_LOOKS`). */
    label: string;
  };
  const shown = new Map<string, Shown>();
  const sphere = new THREE.SphereGeometry(BALL_RADIUS, 40, 28);
  const show = (key: string): Shown => {
    const f = opts.faceOf(key);
    const id = `${f.name}\n${f.picture ?? ''}`;
    let s = shown.get(key);
    if (s && s.face === id) return s;
    if (s) { scene.remove(s.group); dispose(s.group); }
    const body = new THREE.Mesh(sphere, new THREE.MeshStandardMaterial({ map: skin(f, colourOf(key)), roughness: 0.4, metalness: 0.05 }));
    body.castShadow = true;
    const label = key === me ? 'You' : f.name;
    const tag = nameTag(label, key === me);
    tag.position.y = BALL_RADIUS + 0.85;
    const glow = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS * 1.3, 32, 20), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false }));
    glow.visible = false;
    const rings = [1.55, 1.75, 1.95].map((r) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(BALL_RADIUS * r, 0.07, 8, 56), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }));
      ring.visible = false;
      return ring;
    });
    const group = new THREE.Group();
    group.add(body, tag, glow, ...rings);
    scene.add(group);
    s = { group, body, tag, glow, rings, face: id, x: 0, z: 0, y: 0, splashed: false, flash: 0, giga: 0, label };
    shown.set(key, s);
    return s;
  };
  const pops: { sprite: THREE.Sprite; born: number; life: number }[] = [];
  /** A giga bonk's shockwave over the floe, `size` times as wide by its end. */
  const waves: { mesh: THREE.Mesh; born: number; life: number; size: number }[] = [];
  const drops: { points: THREE.Points; v: Float32Array; born: number }[] = [];

  // The mystery ball: question marks on bands of colour, glowing through the colours, turning as it rolls.
  const mysteryCanvas = document.createElement('canvas');
  mysteryCanvas.width = 256; mysteryCanvas.height = 128;
  {
    const g = mysteryCanvas.getContext('2d')!;
    ['#7c5cff', '#ff4fd8', '#ffd23f', '#3ad6ff'].forEach((c, i) => { g.fillStyle = c; g.fillRect(i * 64, 0, 64, 128); });
    g.font = '900 52px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 8;
    g.strokeStyle = '#0b2033';
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 4; i++) { g.strokeText('?', i * 64 + 32, 64); g.fillText('?', i * 64 + 32, 64); }
  }
  const mysteryMap = new THREE.CanvasTexture(mysteryCanvas);
  mysteryMap.colorSpace = THREE.SRGBColorSpace;
  const mystery = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 32, 22), new THREE.MeshStandardMaterial({ map: mysteryMap, roughness: 0.3, metalness: 0.2 }));
  mystery.castShadow = true;
  mystery.visible = false;
  scene.add(mystery);
  const shownItem = { id: 0, x: 0, z: 0, y: 0, splashed: false };

  function dispose(o: THREE.Object3D): void {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.geometry && m.geometry !== sphere) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { (mat as THREE.MeshStandardMaterial).map?.dispose(); mat.dispose(); }
    });
  }

  // A renderer without a GPU (a headless browser, an old machine) draws lite from the start: no shadows, a pixel for a
  // pixel. So does a device that turns out slow (`judge`, below).
  let lite = false;
  const goLite = () => {
    lite = true;
    sun.castShadow = false;
    if (renderer) { renderer.shadowMap.enabled = false; renderer.setPixelRatio(1); resize(); }
    scene.traverse((o) => { const m = (o as THREE.Mesh).material; for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true; });
  };
  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia('(pointer: coarse)').matches ? TOUCH_PIXEL_RATIO : PIXEL_RATIO));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.className = 'bonk-canvas';
    host.prepend(renderer.domElement);
  } else {
    help.textContent = 'This browser cannot draw the game (no WebGL), but you are in it.';
  }
  const resize = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer?.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const sizer = new ResizeObserver(resize);
  sizer.observe(host);
  resize();
  if (context && isSoftware(context)) goLite();

  const tmp = new THREE.Quaternion();
  const gigaColour = new THREE.Color();
  const gigaGlow = new THREE.Color();
  const white = new THREE.Color('#ffffff');
  const axis = new THREE.Vector3();
  function draw(now: number, dt: number): void {
    const ms = now - round.since;
    const r = floeRadius(round.phase, playClock(ms, fastNow()), lastFloe);
    // Double speed: the sea and the snow too.
    const pace = round.phase === 'play' ? speedAt(ms, fastNow()) : 1;
    seaClock += dt * pace;
    const bob = Math.sin(now / 900) * 0.04;
    floe.scale.set(Math.max(r, 0.001), 1, Math.max(r, 0.001));
    floe.position.y = bob;
    floe.visible = r > 0.01;

    const t = now / 1000;
    seaTime.value = seaClock;

    for (let i = 0; i < snowCount; i++) {
      let y = snowAt[i * 3 + 1]! - dt * pace * 1.2;
      if (y < -0.5) y = 20;
      snowAt[i * 3 + 1] = y;
      snowAt[i * 3] = snowAt[i * 3]! + Math.sin(t + i) * dt * 0.3;
    }
    snowGeometry.attributes['position']!.needsUpdate = true;

    // The balls: mine where it is, the others' eased toward where their apps last said, carried on.
    const keysShown = new Set<string>();
    const st = lasting();
    const place = (key: string, x: number, z: number, y: number, vx: number, vz: number, dashing: boolean, power: number) => {
      const s = show(key);
      // What it got that lasts the round, by its name: heavy, dark and a little bigger; handling, a cool shine.
      const fx = effectsOf(st, whoOf(key));
      const label = `${key === me ? 'You' : opts.faceOf(key).name}${fx.heavy ? ` ${ITEM_LOOKS.heavy.mark}` : ''}${fx.handling ? ` ${ITEM_LOOKS.handling.mark}` : ''}`;
      if (label !== s.label) {
        s.group.remove(s.tag);
        dispose(s.tag);
        s.tag = nameTag(label, key === me);
        s.tag.position.y = BALL_RADIUS + 0.85;
        s.group.add(s.tag);
        s.label = label;
      }
      const skinMaterial = s.body.material as THREE.MeshStandardMaterial;
      skinMaterial.color.setScalar(fx.heavy ? 0.55 : 1);
      skinMaterial.metalness = fx.heavy ? 0.6 : 0.05;
      keysShown.add(key);
      const ease = key === me ? 1 : 1 - Math.exp(-dt * 18);
      const ox = s.x, oz = s.z;
      s.x += (x - s.x) * ease; s.z += (z - s.z) * ease; s.y += (y - s.y) * ease;
      s.group.position.set(s.x, s.y + BALL_RADIUS + bob, s.z);
      s.group.visible = s.y > SUNK_Y + 0.5;
      // Rolled as far as it went.
      const mx = s.x - ox, mz = s.z - oz;
      const moved = Math.hypot(mx, mz);
      if (moved > 1e-5 && moved < 3) { axis.set(mz, 0, -mx).normalize(); tmp.setFromAxisAngle(axis, moved / BALL_RADIUS); s.body.quaternion.premultiply(tmp); }
      if (dashing) s.flash = 1;
      s.flash = Math.max(0, s.flash - dt * 3);
      const speed = Math.hypot(vx, vz);
      // Giga: the ball swells and glows in its giga's colour, rings wobbling round it; the mightier, the bigger, brighter
      // and faster, with more rings, and the legendary one shimmers gold and white.
      const tier = power > 0 ? gigaTier(power) : -1;
      if (tier >= 0 && s.giga === 0 && s.group.visible) pop(`${lookOf(power).name.toUpperCase()}!`, lookOf(power).colour, s.x, s.z, now, 0.8 + tier * 0.1);
      s.giga = power;
      const pulse = tier >= 0 ? 0.5 + 0.5 * Math.sin(now / (140 - tier * 16)) : 0;
      s.glow.visible = tier >= 0;
      s.rings.forEach((r, i) => { r.visible = tier >= 0 && i <= tier / 2; });
      s.body.scale.setScalar(1 + s.flash * 0.15 - Math.min(speed, 15) * 0.004 + (tier >= 0 ? 0.05 + tier * 0.02 + pulse * 0.05 : 0) + (fx.heavy ? 0.12 : 0));
      const emissive = skinMaterial.emissive.setRGB(s.flash * 0.6, s.flash * 0.5 + (fx.handling ? 0.12 : 0), s.flash * 0.1 + (fx.handling ? 0.18 : 0));
      if (tier >= 0) {
        gigaColour.set(lookOf(power).colour);
        if (tier === GIGA_LOOKS.length - 1) gigaColour.lerp(white, 0.2 + 0.2 * Math.sin(now / 70));
        emissive.add(gigaGlow.copy(gigaColour).multiplyScalar(0.25 + tier * 0.08 + pulse * 0.3));
        const glow = s.glow.material as THREE.MeshBasicMaterial;
        glow.color.copy(gigaColour);
        glow.opacity = 0.15 + tier * 0.05 + pulse * 0.2;
        s.glow.scale.setScalar(1 + tier * 0.06 + pulse * 0.05);
        const spin = t * (2 + tier * 0.6);
        s.rings.forEach((r, i) => {
          (r.material as THREE.MeshBasicMaterial).color.copy(gigaColour);
          const a = spin + (i * 2 * Math.PI) / 3;
          r.rotation.set(Math.PI / 2 + Math.sin(a) * 0.5, Math.cos(a) * 0.5, 0);
        });
      }
      // In the water: a splash, heard when it goes in, a while after it went off for one thrown far by a giga; mine only
      // when it fell, not when it was put under to watch a round.
      if (s.y < -0.4 && !s.splashed) { s.splashed = true; drops.push(burst(s.x, s.z, now)); if (key !== me || fellAt !== null) splash(); }
      if (s.y >= 0) s.splashed = false;
    };
    const watching = playing === 0 && (round.phase === 'count' || round.phase === 'play');
    if (!watching) place(me, ball.x, ball.z, ball.y, ball.vx, ball.vz, false, giga);
    for (const o of heard(now)) {
      const f = o.frame;
      const a = ahead({ x: f.x, z: f.z, vx: f.vx, vz: f.vz, alive: f.a, y: f.y }, now - o.at);
      place(o.key, a.x, a.z, f.y, f.vx, f.vz, f.d, f.g ?? 0);
    }
    for (const [key, s] of shown) if (!keysShown.has(key)) s.group.visible = false;

    // The mystery ball, where the leader's app has it, carried on; it falls in from the sky, and splashes when it goes in.
    if (item) {
      const at = leader === me ? item.ball : ahead(item.ball, (now - item.at) * (round.phase === 'play' ? speedAt(ms, fastNow()) : 1));
      const ease = shownItem.id === item.id ? 1 - Math.exp(-dt * 18) : 1;
      const ox = shownItem.x, oz = shownItem.z;
      shownItem.x += (at.x - shownItem.x) * ease; shownItem.z += (at.z - shownItem.z) * ease; shownItem.y += (item.ball.y - shownItem.y) * ease;
      if (shownItem.id !== item.id) shownItem.splashed = false;
      shownItem.id = item.id;
      mystery.position.set(shownItem.x, shownItem.y + BALL_RADIUS + bob, shownItem.z);
      const mx = shownItem.x - ox, mz = shownItem.z - oz;
      const moved = Math.hypot(mx, mz);
      if (moved > 1e-5 && moved < 3) { axis.set(mz, 0, -mx).normalize(); tmp.setFromAxisAngle(axis, moved / BALL_RADIUS); mystery.quaternion.premultiply(tmp); }
      mystery.rotation.y += dt * 1.5;
      (mystery.material as THREE.MeshStandardMaterial).emissive.setHSL((t * 0.5) % 1, 1, 0.1 + 0.08 * Math.sin(now / 120));
      mystery.visible = shownItem.y > SUNK_Y + 0.5;
      if (shownItem.y < -0.4 && !shownItem.splashed) { shownItem.splashed = true; drops.push(burst(shownItem.x, shownItem.z, now)); splash(); }
    } else mystery.visible = false;

    // Who got what of a mystery ball: said once, and a word over their ball (a giga says itself, as it glows).
    for (const g of st.got) {
      const id = `${st.n}:${g.id}`;
      if (gotSaid.has(id)) continue;
      gotSaid.add(id);
      const look = ITEM_LOOKS[g.item];
      const key = g.who === myWho ? me : [...others.keys()].find((k) => whoOf(k) === g.who);
      say(`${g.who === myWho ? 'You' : key ? opts.faceOf(key).name : 'Someone'} got ${look.name}${look.mark ? ` ${look.mark}` : ''}`, now);
      const s = key ? shown.get(key) : undefined;
      if (g.item !== 'giga' && s) pop(look.word, look.colour, s.x, s.z, now, 1.2, 1400);
      if (g.item === 'fast') flashOf(look.colour, 0.3, 500);
    }
    marker.visible = !watching && ball.alive;
    aimRing.visible = aimAt !== null && marker.visible;
    if (aimAt) aimRing.position.set(aimAt.x, 0.03 + bob, aimAt.z);
    marker.position.set(shown.get(me)?.x ?? ball.x, 0.02 + bob, shown.get(me)?.z ?? ball.z);
    (marker.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.sin(now / 200) * 0.3;

    for (const e of events.splice(0)) {
      if (!e.giga) { pop(e.hard > 9 ? 'BONK!!' : 'bonk!', e.hard > 9 ? '#ff5d73' : '#ffd23f', e.x, e.z, now); continue; }
      // A giga bonk: its word, a shockwave and sparks in its colour, and the game lit up, all as mighty as it was.
      const tier = gigaTier(e.giga), look = lookOf(e.giga);
      pop(look.word, look.colour, e.x, e.z, now, 1 + tier * 0.15, 900 + tier * 250);
      const wave = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), new THREE.MeshBasicMaterial({ color: look.colour, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      wave.rotation.x = -Math.PI / 2;
      wave.position.set(e.x, 0.06 + bob, e.z);
      scene.add(wave);
      waves.push({ mesh: wave, born: now, life: 500 + tier * 120, size: 3 + tier * 2 });
      drops.push(burst(e.x, e.z, now, look.colour, 40 + tier * 30, 0.8, 1 + tier * 0.3));
      flash(e.giga);
    }
    for (const w of [...waves]) {
      const age = (now - w.born) / w.life;
      w.mesh.scale.setScalar(1 + Math.sqrt(Math.min(1, age)) * w.size);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - age);
      if (age >= 1) { scene.remove(w.mesh); dispose(w.mesh); waves.splice(waves.indexOf(w), 1); }
    }
    for (const p of [...pops]) {
      const age = (now - p.born) / p.life;
      p.sprite.position.y += dt * 1.6;
      (p.sprite.material as THREE.SpriteMaterial).opacity = 1 - age;
      if (age >= 1) { scene.remove(p.sprite); dispose(p.sprite); pops.splice(pops.indexOf(p), 1); }
    }
    for (const d of [...drops]) {
      const age = (now - d.born) / 900;
      const a = d.points.geometry.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        d.v[i * 3 + 1] = d.v[i * 3 + 1]! - 14 * dt;
        a.setXYZ(i, a.getX(i) + d.v[i * 3]! * dt, a.getY(i) + d.v[i * 3 + 1]! * dt, a.getZ(i) + d.v[i * 3 + 2]! * dt);
      }
      a.needsUpdate = true;
      (d.points.material as THREE.PointsMaterial).opacity = 1 - age;
      if (age >= 1) { scene.remove(d.points); dispose(d.points); drops.splice(drops.indexOf(d), 1); }
    }

    // The camera: over the floe from the south, a little toward my ball, further back on a tall screen; shaken by a bonk.
    // Held still on a desktop, watching or not, and a little further back to keep the whole floe in sight, the fog as far
    // back with it: moved with the ball, the spot under the mouse held still would move on ahead of it, off the floe.
    const back = desk ? 1.15 : 1;
    const far = Math.max(1, 1.25 / camera.aspect) * back;
    fog.near = 30 * back;
    fog.far = 70 * back;
    const still = watching || desk;
    // Toward my ball no further than the floe's edge: one a giga threw far out to sea would take the floe out of sight.
    const toEdge = Math.min(1, FLOE_START / Math.max(1e-6, Math.hypot(ball.x, ball.z)));
    const fx = still ? 0 : ball.x * toEdge * 0.2, fz = still ? 0 : ball.z * toEdge * 0.2;
    shake = Math.max(0, shake - dt * 1.5);
    camera.position.set(fx + (Math.random() - 0.5) * shake, 15 * far + (Math.random() - 0.5) * shake, fz + 13 * far);
    camera.lookAt(fx, -0.5, fz + 0.5);
    renderer?.render(scene, camera);
  }

  /** A word popped up at a spot on the floe, `size` times as big as a bonk's, gone in `life` ms. */
  function pop(text: string, colour: string, x: number, z: number, now: number, size = 1, life = 700): void {
    const p = popWord(text, colour);
    p.scale.multiplyScalar(size);
    p.position.set(x, 1.6, z);
    scene.add(p);
    pops.push({ sprite: p, born: now, life });
  }

  /** Drops flying up from a spot: of water where a ball went in; `spread` times as wide for a giga bonk's sparks. */
  function burst(x: number, z: number, now: number, colour = '#d9f3ff', n = 60, y = -0.5, spread = 1): (typeof drops)[number] {
    const at = new Float32Array(n * 3);
    const v = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (1 + Math.random() * 3) * spread;
      at.set([x, y, z], i * 3);
      v.set([Math.cos(a) * s, 4 + Math.random() * 5, Math.sin(a) * s], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(at, 3));
    const points = new THREE.Points(g, new THREE.PointsMaterial({ color: colour, size: 0.22, transparent: true }));
    scene.add(points);
    return { points, v, born: now };
  }

  // The HUD, as the round goes.
  let hudKey = '';
  function updateHud(now: number): void {
    const ms = now - round.since;
    const alone = heard(now).length === 0;
    const watching = playing === 0 && (round.phase === 'count' || round.phase === 'play');
    const name = (who: string | null) => {
      if (who === null) return null;
      if (who === myWho) return 'You';
      const o = [...others.values()].find((x) => whoOf(x.key) === who);
      return o ? opts.faceOf(o.key).name : 'Someone';
    };
    let text: string;
    if (round.phase === 'wait') text = alone ? 'Waiting for a friend to join… roll around meanwhile' : 'Next round starts soon';
    else if (round.phase === 'count') text = watching ? 'You are in the next round' : String(Math.max(1, Math.ceil((COUNT_MS - ms) / 1000)));
    else if (round.phase === 'play') text = watching ? 'You are in the next round' : ms < 900 ? 'Bonk!' : !ball.alive ? 'Splash! You are out' : '';
    else { const w = name(round.winner); text = w === null ? 'Splash! Nobody is left' : w === 'You' ? '🏆 You win!' : `🏆 ${w} wins!`; }
    const wins = Object.entries(round.wins).sort((a, b) => b[1] - a[1]);
    const gigaText = giga > 0 && !watching ? `${lookOf(giga).name}: your next bonk` : '';
    const st = lasting(), fx = effectsOf(st, myWho);
    const kept = [...(fx.heavy ? ['heavy'] : []), ...(fx.handling ? ['handling'] : []), ...(fastNow() !== null && ms >= fastNow()! ? ['fast'] : [])] as Item[];
    const effectsText = kept.map((i) => `${ITEM_LOOKS[i].mark} ${ITEM_LOOKS[i].name}`).join(' · ');
    const left = dropsLeft(round.wins[myWho] ?? 0, st.used[myWho] ?? 0);
    const dropText = canDrop() ? `${left}` : '';
    const toastText = now < toastUntil ? toast.textContent ?? '' : '';
    const key = `${text}|${JSON.stringify(wins)}|${round.phase}|${gigaText}|${effectsText}|${dropText}|${toastText}`;
    if (key === hudKey) return;
    hudKey = key;
    effectsLine.textContent = effectsText;
    dropButton.hidden = !dropText;
    dropButton.dataset['left'] = left > 1 ? dropText : '';
    const label = `Drop a mystery ball${left > 1 ? ` (${left} left)` : ''}${desk ? ' · E' : ''}`;
    dropButton.setAttribute('aria-label', label);
    dropButton.title = label;
    if (!toastText) toast.textContent = '';
    banner.textContent = text;
    gigaBadge.textContent = gigaText;
    gigaBadge.dataset['tier'] = giga > 0 ? String(gigaTier(giga)) : '';
    gigaBadge.style.setProperty('--giga', giga > 0 ? lookOf(giga).colour : '');
    banner.dataset['phase'] = round.phase;
    banner.classList.toggle('big', round.phase === 'count' || (round.phase === 'play' && text === 'Bonk!') || round.phase === 'over');
    board.replaceChildren(...wins.map(([who, n]) => { const li = document.createElement('li'); li.textContent = `${name(who) ?? 'Someone'} ${'🏆'.repeat(Math.min(n, 5))}${n > 5 ? ` ${n}` : ''}`; return li; }));
  }

  let frame = 0;
  let lastDraw = performance.now();
  /** How long each of the first frames took, until the device is judged (`LITE_FRAME_MS`). */
  const frameTimes: number[] = [];
  const judge = (ms: number) => {
    if (lite || frameTimes.length >= FRAMES_JUDGED) return;
    frameTimes.push(ms);
    if (frameTimes.length === FRAMES_JUDGED && [...frameTimes].sort((a, b) => a - b)[FRAMES_JUDGED >> 1]! > LITE_FRAME_MS) goLite();
  };
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    step(now);
    judge(now - lastDraw);
    draw(now, Math.min(0.1, (now - lastDraw) / 1000));
    updateHud(now);
    lastDraw = now;
  };
  frame = requestAnimationFrame(loop);
  // A hidden tab draws nothing, but its ball still goes on and is still sent, so the round does not wait for it.
  const ticker = setInterval(() => { const now = performance.now(); if (now - last > 200) { step(now); updateHud(now); } }, 200);
  host.focus({ preventScroll: true });

  if (exposeHooks) {
    (window as unknown as { __daveGame?: () => GameView }).__daveGame = (): GameView => {
      const now = performance.now();
      return {
        phase: round.phase, round: round.n, leader, playing: playing !== 0, spectating: playing === 0 && (round.phase === 'count' || round.phase === 'play'), webgl: renderer !== null,
        me: { x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz, alive: ball.alive, lastDash, giga, ...effectsOf(lasting(), myWho), drops: dropsLeft(round.wins[myWho] ?? 0, current().used[myWho] ?? 0) }, aim: aimAt,
        item: item && { x: item.ball.x, z: item.ball.z, y: item.ball.y, vx: item.ball.vx, vz: item.ball.vz, alive: item.ball.alive },
        got: current().got.map((g) => ({ who: g.who, item: g.item })), fast: fastNow() !== null,
        others: heard(now).map((o) => ({ key: o.key, x: o.frame.x, z: o.frame.z, alive: o.frame.a, giga: o.frame.g ?? 0 })),
        wins: { ...round.wins }, connected: links.connected().length,
      };
    };
    // Giga now, for the suite: a mystery ball's would take it minutes.
    (window as unknown as { __daveGiga?: (power: number) => void }).__daveGiga = (power) => { giga = power; };
    // For the leader's app: a mystery ball now, holding `what`, dropped at a spot, from a height; wins for a player, for
    // their drops.
    (window as unknown as { __daveItem?: (what: Item, x?: number, z?: number, y?: number) => void }).__daveItem = (what, x = 0, z = 0, y = DROP_Y) => {
      if (ITEMS.includes(what)) { forced = what; forcedAt = { x, z, y }; }
    };
    (window as unknown as { __daveWins?: (who: string, wins: number) => void }).__daveWins = (who, wins) => { round = { ...round, wins: { ...round.wins, [who]: wins } }; lastRoundSent = 0; };
    // Where a spot on the floe is on the page, for the mouse.
    (window as unknown as { __daveScreen?: (x: number, z: number) => { x: number; y: number } }).__daveScreen = (x, z) => {
      const p = new THREE.Vector3(x, 0, z).project(camera), r = host.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    };
  }

  return () => {
    cancelAnimationFrame(frame);
    clearInterval(ticker);
    offFrames();
    sizer.disconnect();
    host.removeEventListener('keydown', onKeyDown);
    host.removeEventListener('keyup', onKeyUp);
    host.removeEventListener('blur', onBlur);
    host.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('contextmenu', onContextMenu);
    host.removeEventListener('lostpointercapture', onLostCapture);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    dispose(scene);
    sphere.dispose();
    // Given back now, not when it is collected: a browser keeps only so many at once, and each Leave and Join makes one.
    renderer?.forceContextLoss();
    renderer?.dispose();
    renderer?.domElement.remove();
    hud.remove();
    if (exposeHooks) for (const hook of ['__daveGame', '__daveGiga', '__daveItem', '__daveWins', '__daveScreen']) delete (window as unknown as Record<string, unknown>)[hook];
  };
}
