# 01 · Which themes friends keep, and which to drop

Status: measuring since the release of the theme analytics (2026-10-15); read the numbers on or after 2026-11-05
Type: research

## Why
PR #63 shipped 20 themes from a bake-off of four design skills (fd- frontend-design, imp- Impeccable, tf- theme-factory,
ds- designer-skills). Twenty is too many to keep up as the app changes: every new screen needs checking in each. The
owner wants to drop the ones nobody uses, judged on use rather than on first looks. Trying a theme for a minute and
moving on must not count as using it.

## What is recorded (src/client/theme.ts, only for friends who said yes to "Help find bugs")
- `theme` on every event, a super property: the theme on screen, `default` for the app's own look.
- `theme_picked` on each pick in the menu: `theme`, `previous`, and `previous_ms`, how long the previous one was on in
  this page (null when it came from an earlier visit, i.e. it was kept across a reload). It also sets `theme` on the
  person, so the person profile says what each friend has now.

"Using" a theme = a session that **starts** with it: the friend came back to it on a later visit. Trying happens inside
a session and does not count there; it shows in `theme_picked`.

Caveats: only the opted-in friends (20 people sent live events in the two weeks before 2026-10-15). The owner's own
browsers count like anyone's; set `$internal_or_test_user` on them, or name their person ids in the queries. Test
browsers are already out (`is_test_account`).

## The queries (HogQL, recipe in the auto memory `posthog-bug-reports.md`; all checked to run on 2026-10-15)
Common filter `F`: `timestamp > toDateTime('2026-10-15 00:00:00') AND coalesce(properties.build_target, 'live') = 'live' AND properties.is_test_account IS NULL`

1. Used: sessions, people and person-days that started with each theme.
   ```sql
   SELECT theme, count() AS sessions, count(DISTINCT person) AS people, count(DISTINCT tuple(person, day)) AS person_days
   FROM (SELECT $session_id AS session, argMin(properties.theme, timestamp) AS theme, any(person_id) AS person,
                toDate(min(timestamp)) AS day
         FROM events WHERE F AND properties.theme IS NOT NULL GROUP BY session)
   GROUP BY theme ORDER BY sessions DESC
   ```
2. Tried and left: how often each theme was left, how often within ten minutes, and the median time on it.
   ```sql
   SELECT properties.previous AS theme, count() AS left_it, countIf(toFloat(properties.previous_ms) < 600000) AS within_10_min,
          round(median(toFloat(properties.previous_ms)) / 60000, 1) AS median_minutes
   FROM events WHERE event = 'theme_picked' AND F GROUP BY theme ORDER BY left_it DESC
   ```
3. On now: friends per theme they have at the moment.
   ```sql
   SELECT properties.theme AS theme, count() AS people FROM persons
   WHERE properties.theme IS NOT NULL AND properties.$internal_or_test_user IS NULL GROUP BY theme ORDER BY people DESC
   ```

## Proposed rule (the owner decides)
After three weeks: keep a theme that at least two friends (not the owner) kept for sessions on two or more days; drop
one nobody kept. Also note which skill's themes survive: that was the point of the bake-off.

Dropping a theme is deleting its file in `src/client/themes/` (and its fonts no other theme uses; `pnpm test` runs
scripts/check-theme-fonts.mjs). Friends who had it picked fall back to the default look, which `e2e/themes.spec.ts`
checks. Removing the analytics afterwards: the `posthog.register` and `theme_picked` lines in theme.ts.
