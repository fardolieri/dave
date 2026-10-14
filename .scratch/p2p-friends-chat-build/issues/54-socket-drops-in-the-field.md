# 54 · Why a let-in socket ends with 1006 and is back a second later

Status: partly diagnosed 2026-10-14; no app change. Where single sockets are cut is still not proven (see "Review"). Making
the drops harmless belongs to `.scratch/quality/issues/10-reliable-delivery.md`, see "For ticket 10" below.
Asked by: ticket 51 ("where it happens is not known") and ticket 53; PostHog shows about 58 `server_reconnected` a week
on prod.

## Answer
There are two kinds of drop:
1. **Desktop, back in about 1 s:** one connection at a time is cut somewhere between the browser and the Room, with no
   close frame (1006), at about **one drop per hour of socket life** (Linux Chrome about 0.9, Brave about 0.7 per
   socket-hour; see "Review" for how that was counted). Candidates, not ranked by proof:
   - Cloudflare restarting edge servers, which it documents ("When Cloudflare releases new code to its global network, we
     may restart servers, which terminates WebSockets connections", developers.cloudflare.com/network/websockets);
   - the browser or the local network (Brave drops about twice as often as Chrome in a small sample, which an edge
     restart would not explain; every desktop in the data is in Augsburg);
   - our own deploys: **seven** desktop drops fell within 10 s of a prod deploy finishing (10-02 16:52, 10-04 13:58 and
     14:01), so some "single socket" drops are Room restarts with no opted-in friend there to pair with.
   Five times both friends' sockets in a room went down within 12 ms: the Room's Durable Object restarting (one of them
   the 10-04 14:01 deploy).
2. **Android, back after minutes:** a phone in the background loses its network, and the app keeps trying until the
   phone wakes up. This is expected, and it is most of the `server_socket_closed` events.

Ticket 51's drops in e2e look like kind 1: one socket alone, 1006, back on the first retry, and roughly the same rate
(about one drop in 400 tests of a few sockets each, that is a few socket-hours).

## Evidence (PostHog, prod `live`, 2026-09-30 to 2026-10-14, read-only HogQL)
Nightly and previews have no `server_socket_closed` events at all (e2e browsers never opt in), so the field data is prod
only. It comes from six opted-in people.
- `server_socket_closed`: 300 in total. Code 1006: 298. Code 4003 (the Room's silence sweep): 2, both on Android.
  `ever_connected` was true for all 300.
- By platform: Android Chrome 193 (2 people), Linux Brave 56 (1), Linux Chrome 49 (2), Samsung Internet 2.
- `server_reconnected` by `down_ms`:
  - Linux: 102 of 106 back within 3 s, median 1.1 s, which is the first backoff step of 0.5 to 1 s plus the handshake.
  - Android: 39 of 67 down for 30 s or more, median 45 s, p99 4.9 h.
  - In the last 7 days: Linux 37, Android 23. That is the "58 a week".
- **Time since the tab's last `room_entered` or `server_reconnected`** at a desktop drop (not the socket's own age, which
  no event carries): median about 25 min.
  The ages spread from seconds to hours, with no pile-up near 90 to 120 s. An idle timeout would make such a pile-up.
- **Drop rate per socket-hour:** about 0.9 for Linux Chrome (about 45 socket-hours) and 0.7 for Brave, counting rooms
  per page load. A first count multiplied every `room_entered` by the tab's lifetime and got 0.27 and 0.62: but
  `room_entered` fires on every mount of the room view (each reload, each time the tab takes the room back), not once
  per room per tab. Android Chrome: about 15, from reconnect loops while asleep.
- **One connection at a time, not the whole network:** each room in a tab has its own socket, and a desktop page load held
  up to 4.
  When a socket of such a tab dropped, the tab's other sockets nearly always stayed up:
  - Linux Chrome: 45 drops alone, 2 drops where two sockets went together.
  - Linux Brave: of the 22 drops whose tab is known, all in a tab holding one room, so they say nothing either way.
  - Android tabs, by contrast, dropped all their sockets together (clusters of 2, 3, 4, 6 and 10), as a phone losing its
    network would.
- **Not the Room for the room, mostly:** in 7 desktop drops the other friend kept their socket (both sent
  `voice_quality` that minute; the events carry no room id, so "same call" is inferred). 12 more such cases were
  Android, in clusters.
- **Triggered by another friend connecting? Too few to tell.** Ticket 51 saw drops within a second or two of another
  socket connecting, ticket 53 one 110 ms after Bob was let in. In the field 2 of 105 desktop drops came within 5 s
  after another opted-in person's socket opened (4 within 30 s): 2 to 5 times chance, on numbers far too small. A Room-side
  cause on joins (the Room waking from hibernation, say) is not ruled out. An e2e loop of joins counting 1006 drops on
  the other socket would settle it.
- **Not idle or throttled tabs:** 51 of the 105 desktop drops happened in a call, where the page plays audio and its
  timers are not throttled. The gap since the tab's previous event was a median of 26 s (Brave) and 11 s (Chrome).

Analysis scripts (throwaway, not in the repo): sequences per `$window_id` built from `room_entered`,
`server_reconnected`, `server_socket_closed`, `voice_quality`, `voice_send` and `peer_connection_state`.

## Hypotheses checked
- **Durable Object hibernation, eviction or restart.** The Room uses the hibernation API (`ctx.acceptWebSocket`, with
  pings auto-answered by `setWebSocketAutoResponse`). Cloudflare: "during hibernation, WebSocket clients remain
  connected", so hibernation itself drops nothing. A restart drops every socket of the room. That explains the 5 pairs
  only (one of them a deploy), not the drops of a single socket.
- **Idle timeout against the ping cadence.** The client pings every 30 s (`PING_INTERVAL_MS`). In a hidden desktop tab,
  Chrome's intensive throttling aligns timers to 1 min, which is still under Cloudflare's roughly 100 s. The Room's own
  sweep closes after 90 s of silence with 4003, and the client would report 4003, not 1006: only 2 such closes, both on
  Android. Against: the drops come at any age, half of them during calls.
- **The Room closing sockets itself.** Every close the Room makes carries its own code: 4001 auth, 4003 silent, 4004
  superseded, 4005 errored. A browser that gets a close frame reports that code. 1006 means no close frame came. The
  10 s challenge timeout (and the client's 4008 handshake give-up) only applies before the welcome, and these sockets had
  been let in minutes to hours before. Against.
- **The client closing healthy sockets** (room.ts, read only). The client closes a socket itself only in these cases:
  - the handshake gives up, reported as 4008, before the welcome only;
  - the server refuses it, with code 1000;
  - cleanup, with 1000, and it reports nothing while stopped;
  - `dropSocket`, a dev aid.
  The Room echoes the client's code or 1000, and refused and cleanup stop the client before it reports; a close the client
  starts reports 1006 only if the closing handshake never finishes, and only `dropSocket` could report one. Against.
- **Cloudflare cutting single connections.** For it:
  - one socket at a time;
  - any age;
  - other rooms in the same tab, and the other friend in the same room, unaffected;
  - back on the first try;
  - two places far apart (GitHub's US runners in e2e, Augsburg in the field) at similar rates;
  - documented by Cloudflare.
  Not proven: no server-side record says whether, and when, the Room's `webSocketClose` ran for such a socket. Ticket 51
  saw the Room supersede the old socket about 1 s later. A cut between the browser and the edge, rather than between
  the edge and the Room, would fit that.

Cloudflare logs: `observability.enabled` is on in wrangler.jsonc, but reading them needs the account's API token (CI
secret only). `wrangler tail` was not run.

## Recommended fix
The drops cannot be prevented from the app. The app should treat them as routine:
1. **Make a drop lose nothing (ticket 10).** The writer's side is done for texts (1b828cb). The reader's side is not: what
   the Room sends into the dead socket in the second before the supersede is gone (tickets 51 and 53, "Left as it is").
   See "For ticket 10".
2. **Instrument both ends, so the next question is answered from data, not inference:**
   - Client (room.ts, so ticket 10): add these to `server_socket_closed`:
     - `age_ms`, the time since this socket's welcome;
     - `since_frame_ms`, the time since its last frame came in;
     - `visible`, from `document.visibilityState`;
     - `online`, from `navigator.onLine`;
     - `rooms`, how many sockets this tab holds.
     These separate kind 1 from kind 2 directly. Today it takes guessing from neighbouring events.
   - Room (src/worker/room.ts, outside the two files; a small follow-up, not done here): one `console.log` line in
     `webSocketClose` and `webSocketError` with the code, whether the socket was attached, and `now - attachedAt`. Workers
     observability keeps it, and the owner can read it in the dashboard. This tells whether the Room ever sees the
     edge's cut, and how late.
3. **Await pongs (ticket 10):** a socket that goes silent without closing cannot appear in this data at all, because
   `server_socket_closed` only fires on a close and the client never waits for a pong. The `down_ms` of a reconnect
   starts at `onclose`, so "the client notices at once" is not measured either. A heartbeat that closes a socket whose
   pong is overdue makes silent drops visible and bounded.

## For ticket 10 (src/client/room.ts and the Room)
**An owner decision comes first:** reader catch-up below means the Room keeps texts for a short time. The spec says the
Room keeps none, and that rule is part of why the app exists. Without it, the honest alternative is a visible "you were
away; texts may be missing" line after a drop.

- **Reader catch-up:** the Room numbers each text it relays per room (`seq`) and keeps the last few for a short time
  (for example 50 texts or 2 min, in memory or in storage with that limit). The client remembers the highest `seq` it
  showed and sends it as `since` on each socket after the first, either in the auth or right after the welcome. The Room
  then replays the texts after it to that socket only. The ids from ticket 51 already drop duplicates.
  This changes spec §4 ("the Room keeps none"): the owner decides how long a text may stay on the server, because
  privacy is the point of that rule. If no copy is wanted at all, the gap stays, and the app should say so: "you were
  away for 1 s; texts may be missing".
- **Presence and signals** sent into the dead socket are already repaired by the presence snapshot on the new socket, and
  for the call by `reconcile`. Ticket 52 is the case where that did not happen.
- **The composer during the 1 s reconnect** (ticket 53, PR #1): with the outbox, the composer can take a text while
  reconnecting and queue it.
- **The instrumentation** in "Recommended fix" point 2, on the client.

## Not verified
- Which hop cuts the connection: the browser to the edge, or the edge to the Room. This is inferred, without server-side
  close records.
- That the 4 paired drops without a deploy were Room restarts rather than a blip on a network the two desktops share.
  Both are in Augsburg, but the other sockets of their tabs stayed up.
- Friends who did not opt in to PostHog are invisible here.

## Review (2026-10-14)
A correctness review and a Grumpy Friend pass read the first draft, which said "Cloudflare, not the app". Corrected above:
the drop rate (counted from `room_entered`, which fires per mount, not per room), "a tab held up to 12", the Brave and
"19 drops" counts, the deploy-aligned drops, "about what chance gives", the meaning of the age figure, and "the client
notices at once". What the Grumpy Friend added for the catch-up design, if the owner wants it:
- **A Room restart empties an in-memory buffer and resets `seq`**, exactly when catch-up matters (deploys, the 5 pairs).
  `seq` must survive in storage (or carry a per-restart epoch), and the Room must answer "gap" when `since` is older than
  what it kept.
- **Send `since` in the auth**, so the replay goes out with the welcome; after the welcome, live texts race the replay and
  a second drop mid-replay skips texts for good.
- **A reload loses the client's `since` and its seen ids** (history has no text ids), so either both persist (a new key in
  `src/core/storedstate.ts`) or the replay shows texts twice.
- **Android gaps are long** (median 45 s, p99 4.9 h): a 2 min or 50-text window mostly helps desktops. The "texts may be
  missing" line is needed whenever the gap is older than the window, server copy or not.
- **The tests' `wire.cut()` closes the Room's side at once**, unlike the field, where the Room writes into the dead socket
  for about a second. A test of the field case needs a cut that only drops the browser's side.
