# 15 · Problem reports: triage fields, test-account filter, reporter identity

Requested 2026-09-10 after asking PostHog's AI what the `bug_report` events lack. Its four points and one suggestion:

1. Reporters are not identified (every `user_email` blank).
2. Automated driver reports leak into the data ("automated test report from the driver, please ignore").
3. The snapshot is a wall of JSON; key fields should be top-level properties.
4. No severity or category.
5. Use PostHog Surveys instead of a custom event.

## Built
- `src/core/report.ts`: the event's shape, runtime-neutral and unit-tested (`test/report.test.ts`). `CATEGORIES` (connection, audio, share, text, other), `SEVERITIES` (annoying, blocking), `reportProperties` (flat, primitive event properties next to the `report` JSON: reporter fingerprint, online/visible/viewport, server status and counts, in_call/muted/sharing/share_viewers/turn_configured, peers by connection state, watching_count, shares_live, black_tiles, warnings/errors), `formatReport` (clipboard text now names category and severity).
- Dialog: a "What is broken?" select and a two-step "How bad is it?" radio above the textarea. Defaults `other` / `annoying`, so a friend who ignores them still sends a valid report.
- Identity: `posthog.identify` now sets the person property `fingerprint`, the same code the profile card shows, so a report's person can be matched to a friend by eye. There are no emails or accounts in this app, and names never reach PostHog; the fingerprint is the identifier this app has.
- Test accounts: the driver seeds `dave.test = true`. `posthog.ts` reads it, registers `is_test_account: true` on every event, and `identify` sets `$internal_or_test_user: true` on the person. That is the property the project's existing "Internal / Test users" cohort keys on, and that cohort is already the project's test-account filter, so the "filter out internal and test users" toggle on any insight now drops driver runs. Nothing to configure in PostHog.
- Driver `REPORT_CHECK` picks the share category and the blocking severity before typing, so the tagging path is exercised too.

## Decided against
- Surveys. Ticket 12 already weighed them: the value of a report here is the WebRTC and element snapshot, which a survey cannot attach, and a survey on top of the dialog would be a second form. The structured fields the survey would have collected now live on the event itself, filterable like any property. Surveys is also not enabled on the project.
- A free-text contact field. Friends know each other; the fingerprint identifies the reporter without sending a name or address to PostHog.

## Verify
- `pnpm test` (report.test.ts), `pnpm typecheck`, `pnpm build`.
- `UA_OVERRIDE=1 REPORT_CHECK=1 node scripts/drive.mjs <url> <secret> a b --join --share` files a tagged report; in PostHog the event should show `category=share severity=blocking is_test_account=true`, and toggling "filter out internal and test users" should hide it.
