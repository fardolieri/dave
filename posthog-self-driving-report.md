# PostHog Self-driving setup report

## Summary

PostHog Self-driving has been configured for Friends Chat, a browser-based shared room for text chat, peer-to-peer calls, and screen sharing. Session Replay, Error Tracking, and Support are enabled; health, error, and support responders are enabled; and the scout troop plus two Replay Vision monitors are ready.

Fresh configuration is picked up within about 30 minutes. Findings will appear in the [Self-driving inbox](https://eu.posthog.com/project/267836/inbox).

## AI data processing

Approved by the wizard prerequisite.

## GitHub

The PostHog GitHub App was already connected before this setup. GitHub Issues was not selected as an inbox responder in this run.

## Products enabled

| Product | Result | Integration check |
| --- | --- | --- |
| Session Replay | enabled | Web app initialization is clean: `posthog-js` uses no replay-disabling override. No recordings existed at setup time. |
| Error Tracking | enabled | Web app initialization is clean: no exception-capture override is present. |
| Support | enabled | An inbound email, inbox, or Slack channel is still required before tickets can arrive. |

## Signal sources

| Signal source | Action | Details |
| --- | --- | --- |
| `signals_scout` / `cross_source_issue` | enabled by default | No opt-out row was created; scout findings can reach the inbox. |
| `health_checks` / `health_issue` | enabled | Source config `01a078b3-0d26-70cf-a8d8-6207ec09ce15`. |
| `error_tracking` / `issue_created` | enabled | Source config `01a078b3-0d36-76a6-9cd0-5299a13698ea`. |
| `error_tracking` / `issue_reopened` | enabled | Source config `01a078b3-0d45-75a5-be14-1342f077e9e2`. |
| `error_tracking` / `issue_spiking` | enabled | Source config `01a078b3-0de7-768c-9d86-df349d230d21`. |
| `conversations` / `ticket` | enabled | Source config `01a078b3-0d49-7979-9b13-1fe4448ce2e8`; remains idle until an inbound channel is connected. |
| `session_replay` / `session_analysis_cluster` | skipped | Retired source type; Replay Vision monitors provide Replay coverage instead. |
| `replay_vision` | skipped | Scanners self-authorize through `emits_signals: true`; no source-config row is needed. |

## Connected tools

No external connected-tool responders were selected. GitHub Issues, Linear, Jira, Sentry, and Zendesk are not used as Self-driving sources in this configuration.

## Scout troop

Four scouts are enabled, all on the default daily cadence and emitting to the inbox:

| Scout | Why enabled |
| --- | --- |
| `signals-scout-general` | Cross-product correlations and otherwise uncovered surfaces. |
| `signals-scout-product-analytics` | Generic behavioral coverage for the room, call, sharing, and chat events captured by this web app. |
| `signals-scout-health-checks` | Actionable PostHog configuration and instrumentation health issues. |
| `signals-scout-call-reliability` | Custom coverage for call-join reliability; details below. |

The other 24 built-in scouts are disabled because no evidence showed their specialist surfaces are actively used: AI observability, anomaly detection, APM, conversations, CSP violations, customer analytics, data pipelines, warehouse, experiments, feature flags, insight alerts, logs, MCP calls, Replay Vision trends, revenue analytics, surveys, tasks, web analytics, and web vitals. `signals-scout-error-tracking` is intentionally disabled because error tracking is covered by the native responder; `signals-scout-session-replay` is intentionally disabled because Replay Vision monitors cover recordings. These can be enabled later if the corresponding product surface is adopted.

| Budget | Verified value |
| --- | --- |
| Maximum runs per day | 100 |
| Runs used today | 0 |
| Runs remaining today | 100 |
| Announcement | Scouts are in early access. Each project gets up to 100 scout runs a day. Contact team-self-driving@posthog.com if more is needed. |

## Custom scouts

### Created

| Scout | Surface and discriminator | Why it is distinct |
| --- | --- | --- |
| `signals-scout-call-reliability` | Watches `room_entered`, `call_joined`, and controlled `join_error` telemetry. It reports only when call-join conversion falls while room entry holds, or a failure reason rises across multiple people. | The general product-analytics scout watches saved behavioral flows; this scout is dedicated to real-time call setup reliability and filters one-person permission issues and partial windows. |

The scout was approved during setup and is enabled with the server defaults. It avoids user-entered content and only investigates controlled failure reasons. If it becomes noisy, set `emit: false` on its scout configuration in PostHog to keep it running in dry-run mode.

Surfaces considered but not made into custom scouts: screen-sharing engagement was not proposed because it lacks a clear success/failure pair; chat activity and general room activity remain covered by the enabled general and product-analytics scouts.

## Replay Vision scanners

A scanner is an LLM that watches individual session recordings on a schedule and pushes qualifying visual findings to the inbox. It is the only part of this setup that spends Replay Vision quota; each finding arrives at half weight and needs independent corroboration before it is promoted into a report.

| Monitor | Status | Scope and purpose | Sampling | Estimate |
| --- | --- | --- | --- | --- |
| Room and call breakage | created | URL-scoped to the app’s single-page room and call flow. It watches invite entry, identity/name setup, call joining, reconnection, and screen-sharing breakage. The root URL is the product’s only completion-flow location. | 0.5 | 0 observations / 0 credits per month from the recent seven-day estimate; 5 credits per observation once recordings arrive. |
| Room and call frustration | created | `$rageclick` only, with no URL filter. It watches visible struggle while joining calls, configuring audio or sharing, opening shares, and reconnecting. | 1.0 | 0 observations / 0 credits per month from the recent seven-day estimate; 5 credits per observation once recordings arrive. |

The organization has 2,500 Replay Vision credits remaining in the current period and is not exhausted. No recordings existed at setup time, so both monitors are armed and will begin work when recordings arrive.

## Follow-ups

- [ ] Connect an inbound Support channel (email, inbox, or Slack) in PostHog to begin collecting support tickets.
- [ ] Generate real browser sessions in Friends Chat so Session Replay, the visual monitors, and the call-reliability scout can establish a baseline.
- [ ] Re-enable specialist scouts only when their surfaces become active; likely candidates include web analytics for acquisition monitoring or Replay Vision trend analysis after observations accumulate.

## What happens next

The scout coordinator picks up fresh configurations within roughly 30 minutes and runs draw from the verified daily budget. Replay Vision monitors inspect qualifying new recordings as they arrive. Findings are clustered into reports in the [Self-driving inbox](https://eu.posthog.com/project/267836/inbox), where immediately actionable reports can begin coding tasks.

## Files modified or created

- Created `posthog-self-driving-report.md`.
- Installed local setup guides under `.claude/skills/` for Replay Vision setup, scanner mechanics, broken experiences, and user frustration.
- No application source files were modified.
