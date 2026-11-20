import { createSignal, Switch, Match, createMemo, For, Show, untrack, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { telemetryOn } from './posthog';
import { formatAgo } from '../core/names';
import { FREE_PLAN, RELAY_SAVE_FROM, SIDE_SHARES, elapsedOf, fillOf, formatBytes, formatCount, formatPercent, monthSoFar, sideOf, type Fill, type FreePlanToday, type RelayUsage, type Side } from '../core/relayusage';
import { refreshRelayUsage, relaySaving, relayUsage } from './relay';
import { parseHistoryUsage, type HistoryToday, type HistoryUsage } from '../core/kept';
import { formatReport, formatWish, sendReport, sendWish, type Report } from './diagnostics';
import { CATEGORIES, SEVERITIES, isCategory, isSeverity, isWish, type Category, type Severity } from '../core/report';
import { build, commitUrl, REPO_URL, shortCommit } from './version';

/**
 * "Report a problem" (ticket 12): a category, a severity and a description plus a technical snapshot
 * go to the room's error log (PostHog), next to this tab's masked session replay. Copy is the fallback
 * for browsers that block it. A wish goes alone, as its words: no severity, no snapshot.
 */
export function ReportDialog(props: { collect: () => Promise<Report> }) {
  let dialog: HTMLDialogElement | undefined;
  const [text, setText] = createSignal('');
  const [category, setCategory] = createSignal<Category>('other');
  const [severity, setSeverity] = createSignal<Severity>('annoying');
  const [phase, setPhase] = createSignal<'idle' | 'sending' | 'sent' | 'copied' | 'copy_failed'>('idle');
  const form = () => ({ text: text(), category: category(), severity: severity() });
  const wish = () => isWish(category());
  const open = () => { setPhase('idle'); dialog?.showModal(); };
  const send = async () => {
    setPhase('sending');
    if (wish()) sendWish(text());
    else sendReport(form(), await props.collect());
    setPhase('sent');
  };
  const copy = async () => {
    const body = wish() ? formatWish(text()) : formatReport(form(), await props.collect());
    try { await navigator.clipboard.writeText(body); setPhase('copied'); } catch { setPhase('copy_failed'); }
  };
  return (
    <>
      <button class="link" onClick={open}>Report a problem or a wish</button>
      <dialog class="report" ref={dialog}>
        <h3>{wish() ? 'Make a wish' : 'Report a problem'}</h3>
        <label class="field">{wish() ? 'What is it about?' : 'What is broken?'}
          <select value={category()} onChange={(e) => { const v = e.currentTarget.value; if (isCategory(v)) setCategory(v); }}>
            <For each={Object.entries(CATEGORIES)}>{([key, label]) => <option value={key}>{label}</option>}</For>
          </select>
        </label>
        <Show when={!wish()}>
          <fieldset class="field severity">
            <legend>How bad is it?</legend>
            <For each={Object.entries(SEVERITIES)}>{([key, label]) => (
              <label><input type="radio" name="severity" value={key} checked={severity() === key} onChange={() => { if (isSeverity(key)) setSeverity(key); }} /> {label}</label>
            )}</For>
          </fieldset>
        </Show>
        <textarea value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder={wish() ? 'What would you like dave to do? What would you use it for?' : 'What went wrong, and what did you expect? When did it happen?'} rows={4} />
        <p class="hint">
          {wish()
            ? "Your wish is sent to PostHog, the room's error log, where the person running this room reads it, without a snapshot of your connection."
            : "Your description is sent to PostHog, the room's error log, together with a technical snapshot of your connection: states and counters, never message texts or names."}
          {telemetryOn() ? ' The last minutes of this tab are already kept as a masked session replay.' : ' Only this report goes, nothing before or after it.'}
        </p>
        <Switch>
          <Match when={phase() === 'sent'}><p class="ok">Sent, thank you. Brave and strict tracking protection can block this silently: if in doubt, also use Copy and paste it to the person running this room.</p></Match>
          <Match when={phase() === 'copied'}><p class="ok">Copied. Paste it to the person running this room.</p></Match>
          <Match when={phase() === 'copy_failed'}><p class="warn">Could not access the clipboard. Try Send instead.</p></Match>
        </Switch>
        <div class="row">
          <button class="on" onClick={() => void send()} disabled={phase() === 'sending' || !text().trim()}>{phase() === 'sending' ? 'Sending…' : 'Send'}</button>
          <button onClick={() => void copy()} disabled={!text().trim()}>Copy</button>
          <button onClick={() => dialog?.close()}>Close</button>
        </div>
      </dialog>
    </>
  );
}

/** Date and 24-hour clock time, always with the day: a version's age is the point. */
const stamp = (iso: string): string => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const RELAY_TITLE = "What Cloudflare's TURN relay sent this month, for calls and files between friends who cannot reach each other directly. Cloudflare relays 1 TB a month for free and charges past it. Counted since the 1st (UTC) for the whole account, the live site and every preview together; it lags behind by a few minutes.";

/**
 * The free plan's daily figures as the About dialog shows them: what each is, in a friend's words, and in the hover title
 * what it counts. Every one is the whole account's: the live site's, and every preview's.
 */
const FREE_PLAN_ROWS: Array<{ key: keyof typeof FREE_PLAN; name: string; title: string; shown: (n: number) => string }> = [
  { key: 'objectRequests', name: 'Room requests', shown: formatCount, title: "Requests to the rooms on the server, as Cloudflare bills them: every socket a browser opens, every call to the server's history, every alarm, and one for every 20 frames a room is woken for. Past the limit, no room answers until midnight UTC." },
  { key: 'workerRequests', name: 'Worker requests', shown: formatCount, title: "Requests to the Worker: every socket's upgrade, and this dialog's own asks. The app's files are free and not counted. Past the limit, nobody can connect until midnight UTC." },
  { key: 'rowsWritten', name: 'Rows written', shown: formatCount, title: "Rows the rooms and the server's history wrote: a room's key, a kept text, an old one dropped from the window. Past the limit, every room's storage fails until midnight UTC; the history stops keeping before that, at its own share." },
  { key: 'rowsRead', name: 'Rows read', shown: formatCount, title: "Rows the rooms and the server's history read: every challenge, every sync, every piece of a kept file. Past the limit, every room's storage fails until midnight UTC." },
  { key: 'compute', name: 'Room time', shown: (n) => `${formatCount(n)} GB-s`, title: 'How long the rooms were awake, in GB-seconds (128 MB a second). A room sleeps between frames, which costs nothing. Past the limit, no room answers until midnight UTC.' },
  { key: 'stored', name: 'Stored', shown: formatBytes, title: "What every room and the server's history keep, the previews' included: a total, not a day's. Past it, nothing more is kept." },
];

/** How long until the free plan's day starts again, 00:00 UTC: "6 h 42 min". */
function untilReset(now: number): string {
  const left = Math.max(0, Date.parse(`${monthSoFar(now + 24 * 3600_000).to}T00:00:00Z`) - now);
  const h = Math.floor(left / 3600_000);
  const m = Math.floor((left % 3600_000) / 60_000);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/**
 * One figure against its limit (stat tile and meter, as the dataviz rules have them): its name, its share, a thin bar
 * filled in the theme's accent, its warning colour past half and its danger colour past 80 %, on a track of the same
 * colour, and the figures under it. Past half the share also says so in words (⚠): never by colour alone.
 *
 * A limit that resets has a pace (core/relayusage.ts, elapsedOf): how far through its day or month it is. A line across
 * the bar marks it, where the bar would stand had the limit been used at an even pace since the reset; a bar past it
 * runs out before the reset if it goes on so, and says that in words too.
 */
function UsageMeter(props: { id: string; name: string; title: string; value: number; limit: number; shown: string; pace?: number; fill?: Fill; children?: JSX.Element }) {
  const fill = () => props.fill ?? fillOf(props.value, props.limit);
  const pct = () => formatPercent(props.value, props.limit);
  const width = () => (props.value > 0 ? `max(3px, ${Math.min(100, (props.value / props.limit) * 100)}%)` : '0');
  const ahead = () => props.pace !== undefined && props.value / props.limit > props.pace;
  const paceText = () => (props.pace === undefined ? '' : ahead() ? ', ahead of an even pace' : ', within an even pace');
  return (
    <li class="meter" data-meter={props.id} data-fill={fill()} data-ahead={props.pace === undefined ? undefined : String(ahead())} title={props.title}>
      <span class="meter-name">{props.name}</span>
      <span class="meter-pct">{fill() !== 'ok' ? <span aria-hidden="true">⚠ </span> : null}{pct()}%</span>
      <div class="meter-bar" role="meter" aria-label={props.name} aria-valuemin={0} aria-valuemax={props.limit} aria-valuenow={Math.round(props.value)} aria-valuetext={`${props.shown} (${pct()}%)${paceText()}`}>
        <i style={{ width: width() }} />
        <Show when={props.pace !== undefined}><b class="meter-pace" style={{ left: `${(props.pace ?? 0) * 100}%` }} /></Show>
      </div>
      <span class="meter-fig">{props.shown}<Show when={ahead()}> · <span class="meter-ahead">ahead of an even pace</span></Show></span>
      {props.children}
    </li>
  );
}

/** What the pace line means, once under the meters that have it. */
const PACE_NOTE = 'The line on a bar is where an even pace would have it by now. Past it, the limit runs out before it resets, if use goes on like this.';

/** What the line under the free plan's figures says of the shares: the live site and the previews each stop at theirs. */
const SHARES_NOTE = `The live site gets ${Math.round(SIDE_SHARES.live * 100)} % of every daily limit, the previews ${Math.round(SIDE_SHARES.preview * 100)} %. Past its share of one, a side lets no one into a room until midnight UTC, and the other goes on.`;
const SIDE_NAMES = { live: 'live site', preview: 'previews' } as const;
/** The side this copy of the app spends from, whose share its warnings follow: a preview's, or the live site's. */
const OWN_SIDE: Side = build.target === 'preview' ? 'preview' : 'live';
/** Said after a daily figure's own title: neither side gets as far as the limit. */
const SHARES_TITLE = `Before that, the live site stops at its ${Math.round(SIDE_SHARES.live * 100)} % share of it, the previews at theirs, ${Math.round(SIDE_SHARES.preview * 100)} %.`;

/** Each side's part of a daily figure as `shown` prints it, against its share; null where the parts are not known. */
function sidesOf(today: FreePlanToday, key: keyof typeof FREE_PLAN): Array<{ side: Side; value: number; share: number }> | null {
  if (key === 'stored') return null;
  const parts = (['live', 'preview'] as const).map((side) => ({ side, figures: sideOf(today, side) }));
  if (parts.some((p) => !p.figures)) return null;
  return parts.map(({ side, figures }) => ({ side, value: figures![key], share: FREE_PLAN[key] * SIDE_SHARES[side] }));
}

/** How full a daily figure is for this copy of the app: its whole limit's, or its own side's share's, whichever is further on. */
function nearness(today: FreePlanToday, key: keyof typeof FREE_PLAN): number {
  return Math.max(today[key] / FREE_PLAN[key], ...(sidesOf(today, key) ?? []).filter((s) => s.side === OWN_SIDE).map((s) => s.value / s.share));
}

/**
 * The free plan's figures for today, the one nearest its limit first: what to keep an eye on. Under each daily one, the
 * live site's part and the previews', when the Worker said (core/relayusage.ts, `sideOf`): each may use its share. A
 * meter warns as this copy's own side nears its share, as for its whole limit: the previews' use stops no friend's room.
 */
function FreePlanToday(props: { today: FreePlanToday; now: number }) {
  const near = (key: keyof typeof FREE_PLAN) => nearness(props.today, key);
  const rows = () => FREE_PLAN_ROWS.map((r) => ({ ...r, value: props.today[r.key], limit: FREE_PLAN[r.key] })).sort((a, b) => near(b.key) - near(a.key));
  const split = (key: keyof typeof FREE_PLAN, shown: (n: number) => string) => {
    const sides = sidesOf(props.today, key);
    if (!sides) return null;
    // Past half its share a side says so in words too (⚠), as a meter does.
    return sides.map((s, i) => `${fillOf(s.value, s.share) === 'ok' ? '' : '⚠ '}${i ? SIDE_NAMES[s.side] : 'Live site'} ${shown(s.value)} (${formatPercent(s.value, s.share)}%${i ? '' : ' of its share'})`).join(' · ');
  };
  return (
    <section class="usage" aria-label="Cloudflare free plan today">
      <h4>Free plan today <small>resets in {untilReset(props.now)} (00:00 UTC)</small></h4>
      <ul>
        {/* Stored is a total, not a day's: it has no pace, and no share. */}
        <For each={rows()}>{(r) => (
          <UsageMeter id={r.key} name={r.name} title={sidesOf(props.today, r.key) ? `${r.title} ${SHARES_TITLE}` : r.title} value={r.value} limit={r.limit} shown={`${r.shown(r.value)} of ${r.shown(r.limit)}`} pace={r.key === 'stored' ? undefined : elapsedOf('day', props.now)} fill={fillOf(near(r.key), 1)}>
            <Show when={split(r.key, r.shown)}>{(text) => <small class="meter-note meter-split">{text()}</small>}</Show>
          </UsageMeter>
        )}</For>
      </ul>
      <Show when={sidesOf(props.today, 'objectRequests')}><p class="shares-note">{SHARES_NOTE}</p></Show>
    </section>
  );
}

/** The history's own daily shares (core/kept.ts), carved from the free plan's figures above so the rooms keep theirs. */
const HISTORY_ROWS: Array<{ key: keyof Omit<HistoryToday, 'day'>; name: string; title: string }> = [
  { key: 'syncs', name: 'Syncs today', title: "Times a browser asked the server's history for what it missed: one on every socket's welcome, a room's or a friend's. Past this share of the room requests, until midnight UTC, browsers get no history from the server; live texts still come." },
  { key: 'written', name: 'Rows written today', title: "Rows the server's history wrote: kept texts and pieces of files, old ones dropped from the window, and its own counts. Past this share of the rows written, until midnight UTC, texts and files are sent but not kept." },
  { key: 'read', name: 'Rows read today', title: "Rows the server's history read for syncs and for pieces of kept files. Past this share of the rows read, until midnight UTC, browsers get no history and no kept files from the server." },
];

const HISTORY_TITLE = "What the server keeps of every room's texts and files up to 16 MB, sealed so that only friends can read them, for friends who were away. Four weeks at most, in one window for every room of this site: past 4 GB the oldest go sooner, whichever room they are of. Counted with what their storage costs on top, so a little more than the texts themselves.";

/** The server's history (ADR 0009) as the Worker last told it, 'unknown' when asking failed; null before the first answer. */
async function askHistoryUsage(): Promise<HistoryUsage | 'unknown'> {
  try {
    const res = await fetch('/history-usage', { cache: 'no-store' });
    return (res.ok && parseHistoryUsage(await res.json())) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Which version of dave this is: the commit it was built from, its message, when it was deployed, and where the code lives. */
export function VersionDialog() {
  let dialog: HTMLDialogElement | undefined;
  const deployed = build.target === 'local' ? 'Built' : 'Deployed';
  // The relay's usage this month (client/relay.ts), asked again on every open: the Worker keeps its answer for minutes.
  // Left out where the Worker has no token to ask Cloudflare with (local builds, a Worker without the secret).
  const relay = relayUsage;
  // The clock the free plan's day is read by: it ticks while the dialog is open, so the countdown counts down and a day
  // that ended leaves the dialog.
  const [now, setNow] = createSignal(Date.now());
  let tick: ReturnType<typeof setInterval> | undefined;
  const stopTick = () => { clearInterval(tick); tick = undefined; };
  onCleanup(stopTick);
  // How full the server's history is, asked on every open: the Worker keeps its answer a minute.
  // Of several asks under way, the latest one's answer is taken; a failed one keeps what was known.
  const [history, setHistory] = createSignal<HistoryUsage | 'unknown' | null>(null);
  let historyAsks = 0;
  // The figure nearest its limit of those shown below, for the fold's summary; none while a section is not known, which
  // could hold a nearer one. The same object while it says the same, so the summary is not drawn again on every tick.
  const nearest = createMemo(() => {
    const r = relay();
    const h = history();
    if (r === 'unknown' || h === 'unknown') return null;
    const { to } = monthSoFar(now());
    const shown: Array<{ name: string; value: number; limit: number }> = [];
    if (typeof r === 'object' && r !== null) {
      shown.push({ name: 'Relay', value: r.bytes, limit: r.limit });
      if (r.today?.day === to) {
        for (const row of FREE_PLAN_ROWS) {
          shown.push({ name: row.name, value: r.today[row.key], limit: FREE_PLAN[row.key] });
          for (const s of sidesOf(r.today, row.key) ?? []) if (s.side === OWN_SIDE) shown.push({ name: `${row.name} (${SIDE_NAMES[s.side]})`, value: s.value, limit: s.share });
        }
      }
    }
    if (typeof h === 'object' && h !== null) {
      shown.push({ name: 'Kept on the server', value: h.bytes, limit: h.budget });
      if (h.today?.day === to && h.shares) for (const row of HISTORY_ROWS) shown.push({ name: row.name, value: h.today[row.key], limit: h.shares[row.key] });
    }
    const top = shown.sort((a, b) => b.value / b.limit - a.value / a.limit)[0];
    return top ? { name: top.name, pct: formatPercent(top.value, top.limit), fill: fillOf(top.value, top.limit) } : null;
  }, { equals: (a, b) => a === b || (!!a && !!b && a.name === b.name && a.pct === b.pct && a.fill === b.fill) });
  // Whether any meter shown has a pace line, as the sections below decide: a figure of this day or month.
  const paced = () => {
    const r = relay();
    const h = history();
    const { from, to } = monthSoFar(now());
    return (typeof r === 'object' && r !== null && (r.since === from || r.today?.day === to)) || (typeof h === 'object' && h !== null && h.today?.day === to && !!h.shares);
  };
  const open = () => {
    setNow(Date.now());
    stopTick();
    tick = setInterval(() => {
      const day = monthSoFar(untrack(now)).to;
      setNow(Date.now());
      // A new day while it is open: its figures, at once (the Worker asks Cloudflare anew on a new day).
      if (monthSoFar(Date.now()).to !== day) void refreshRelayUsage();
    }, 30_000);
    dialog?.showModal();
    void refreshRelayUsage();
    const n = ++historyAsks;
    void askHistoryUsage().then((u) => { if (n === historyAsks && (u !== 'unknown' || typeof untrack(history) !== 'object' || untrack(history) === null)) setHistory(u); });
  };
  return (
    <div class="about-link">
      <button class="link" title={`Version ${shortCommit(build.commit)}${build.dirty ? '+' : ''}, ${deployed.toLowerCase()} ${formatAgo(Date.parse(build.builtAt))}`} onClick={open}>About</button>
      {/* A click on the backdrop reaches the dialog itself, outside its box; its padding is the dialog too, so the box decides. */}
      <dialog class="about" ref={dialog} onClose={stopTick} onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.target === e.currentTarget && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) e.currentTarget.close();
      }}>
        <h3>About dave</h3>
        <dl>
          <dt>Version</dt>
          <dd><a href={commitUrl(build.commit)} target="_blank" rel="noopener"><code>{shortCommit(build.commit)}</code></a>{build.dirty ? ' plus uncommitted changes' : ''}</dd>
          <dt>Latest change</dt>
          {/* The commit message: its title, and the description behind it for whoever wants the detail. */}
          <dd>
            <Show when={build.body} fallback={<span class="change">{build.subject || 'No commit message'}</span>}>
              <details class="change"><summary>{build.subject || 'No commit message'}</summary><p>{build.body}</p></details>
            </Show>
          </dd>
          <dt>Committed</dt>
          <dd>{stamp(build.committedAt)}</dd>
          <dt>{deployed}</dt>
          <dd>{stamp(build.builtAt)} ({formatAgo(Date.parse(build.builtAt))}){build.target === 'local' ? ', on a developer\'s machine' : `, to ${build.target === 'live' ? 'the live site' : build.target}`}</dd>
          <dt>Source</dt>
          <dd><a href={REPO_URL} target="_blank" rel="noopener">{REPO_URL.replace(/^https:\/\//, '')}</a></dd>
        </dl>
        {/* The figures, folded away until asked for; the summary names the one nearest its limit, so a fold hides no warning. */}
        <Show when={relay() !== null || history() !== null}>
        <details class="usage-all">
          <summary>Usage and limits<Show when={nearest()}>{(n) => <small data-fill={n().fill}>{n().fill !== 'ok' ? <span aria-hidden="true">⚠ </span> : null}nearest: {n().name}, {n().pct}%</small>}</Show></summary>
        {/* What the free plan allows and what is used of it, where the Worker can ask Cloudflare (a token: not local builds). */}
        <Show when={relay()}>{(r) => (
          <Show when={typeof r() === 'object' ? (r() as RelayUsage) : null} fallback={<p class="usage-unknown">Cloudflare's figures: not known right now.</p>}>{(u) => (
            <>
              <Show when={u().today?.day === monthSoFar(now()).to ? u().today : null}>{(today) => <FreePlanToday today={today()} now={now()} />}</Show>
              <section class="usage" aria-label="Relay this month">
                <h4>Relay this month <small>since {new Date(`${u().since}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })}</small></h4>
                <ul>
                  <UsageMeter id="relay" name="Relay (TURN)" title={RELAY_TITLE} value={u().bytes} limit={u().limit} shown={`${formatBytes(u().bytes)} of ${formatBytes(u().limit)}`} pace={u().since === monthSoFar(now()).from ? elapsedOf('month', now()) : undefined}>
                    <small class="meter-note">Calls and files between friends who cannot reach each other directly go through Cloudflare's relay, free up to 1 TB a month.
                      {relaySaving() ? ` This month is past ${RELAY_SAVE_FROM * 100}%: screen shares and files keep off it until the 1st, voice still goes through.` : ` Past ${RELAY_SAVE_FROM * 100}%, screen shares and files keep off it for the rest of the month.`}</small>
                  </UsageMeter>
                </ul>
              </section>
            </>
          )}</Show>
        )}</Show>
        <Show when={history()}>{(h) => (
          <section class="usage" aria-label="Kept on the server">
            <Show when={typeof h() === 'object' ? (h() as HistoryUsage) : null} fallback={<><h4>Kept on the server</h4><p class="usage-unknown">Not known right now.</p></>}>{(u) => (
              <>
                <h4>Kept on the server <small>{u().oldest === null ? 'nothing yet' : `back to ${new Date(u().oldest!).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`}</small></h4>
                <ul>
                  <UsageMeter id="kept" name="Texts and files" title={HISTORY_TITLE} value={u().bytes} limit={u().budget} shown={`${formatBytes(u().bytes)} of ${formatBytes(u().budget)}`}>
                    <small class="meter-note">Texts, and files up to 16 MB, are kept on the server, sealed so only friends can read them, so a friend who was away gets them later. They go after four weeks, here and in every browser, or sooner once all rooms' 4 GB are full: the oldest first.</small>
                  </UsageMeter>
                  {/* Its daily shares, today's only: the nearest its share first, as the free plan's. */}
                  <Show when={u().today?.day === monthSoFar(now()).to && u().shares ? { today: u().today!, shares: u().shares! } : null}>{(d) => (
                    <For each={HISTORY_ROWS.map((r) => ({ ...r, value: d().today[r.key], limit: d().shares[r.key] })).sort((a, b) => b.value / b.limit - a.value / a.limit)}>{(r) => (
                      <UsageMeter id={`kept-${r.key}`} name={r.name} title={r.title} value={r.value} limit={r.limit} shown={`${formatCount(r.value)} of ${formatCount(r.limit)}`} pace={elapsedOf('day', now())} />
                    )}</For>
                  )}</Show>
                </ul>
              </>
            )}</Show>
          </section>
        )}</Show>
        <Show when={paced()}><p class="usage-note">{PACE_NOTE}</p></Show>
        </details>
        </Show>
        <div class="row"><button onClick={() => dialog?.close()}>Close</button></div>
      </dialog>
    </div>
  );
}
