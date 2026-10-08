# 08 · Canary gate: prod waits for nightly's real-world numbers

Status: later (needs traffic on nightly)
Type: research

## Idea
Some friends (and the owner) use nightly every day, a canary ring. The release gate also compares nightly's rates of
`$exception`, `invariant_violation`, `bug_report` and failed connections per active hour against prod's over the last days,
through the PostHog API, and holds the release when nightly is clearly worse.

## Open questions
- Nightly is another origin: identities and rooms do not carry over. Is a "use nightly" link with an invite enough?
- With a handful of users the numbers are noise. What minimum exposure makes a comparison meaningful?
