# 12 · Problem reports and black-tile diagnostics

Requested 2026-09-08: friends sometimes see only black when watching a share although kbps show frames arriving; before fixing that, a "help, I have problems" button so friends can file reports, ideally with recordings or screenshots.

## What PostHog already gives us
- Session replay is on for every tab (text masked). A `bug_report` event lands in the same session, so the recording of the minutes before the report is one click away. Video content is not part of a replay (only the element's box), so a screenshot would not show more than "it is black".
- PostHog Surveys could provide a canned feedback widget, but our own dialog can attach what actually matters here: WebRTC and element state.

## Built
- `src/client/log.ts`: ring buffer of the last 40 console warnings and errors.
- `src/client/diagnostics.ts`: `collectReport` (page, server, call, video elements, log), `sendReport` (one event, snapshot as JSON string, a few top-level fields for filtering), `formatReport` (clipboard text).
- `call.diagnostics()`: per peer states plus `getStats` counters (inbound/outbound video, selected pair). `call.reportBlackShare(key, element)`: files `share_black` with the peer snapshot, then re-subscribes (off, on) so the sharer's encoding restarts with a key frame.
- ShareTile black check: 4 s after going live, `videoWidth`, `getVideoPlaybackQuality().totalVideoFrames` and `paused` decide; on black it re-attaches `srcObject`, calls `play()`, reports, and lets the call re-subscribe. Two rounds max per subscription.
- Dialog in the sidebar ("Report a problem"): textarea, Send, Copy, Close, with a note about Brave.

## Findings while verifying
- posthog-js drops all events from a `HeadlessChrome` user agent client-side, so no headless run has ever reached PostHog. The driver gained `UA_OVERRIDE=1` for runs that must.
- The black-tile hypotheses the snapshot will discriminate: (a) frames received but none decoded and no key frame → key-frame problem at the sharer (re-subscribe fixes); (b) frames decoded but element shows none → element/autoplay problem (re-attach and play fixes); (c) no frames received at all while bytes count → wrong track slot or audio-only bytes.

## Open
- Brave and strict-tracking-protection friends cannot deliver reports or `share_black` events; Copy is the fallback. A PostHog reverse proxy through the Worker would make them arrive; that is a server-side addition the owner has to decide on.
