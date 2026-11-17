# 87 · Flake: a theme picked in the themes card did not show as picked, in Firefox

Status: open; cause not looked for
Type: flake

Seen 2026-11-17, the preview run of #157 at 7e97f8a (run 44167146579, Firefox shard 5), passed on its retry:
`themes.spec.ts:403` "the invite panel stands clear of the rows below it, in every theme". #157 makes a YouTube card's
title a link (App.tsx, styles.css): nothing on themes, the ⋯ menu or the invite panel. First sighting in the ledger.

```
Locator:  locator('.themes:popover-open').locator('.theme-choice[data-theme-name="imp-freibad"]')
Expected: "true"
Received: "false"
  43 × locator resolved to <button type="button" class="theme-choice" aria-pressed="false" data-theme-name="imp-freibad">…</button>
> 819 |   await expect(card.locator(`.theme-choice[data-theme-name="${value}"]`)).toHaveAttribute('aria-pressed', 'true');
```

`pickTheme` (e2e/fixtures.ts) clicked the theme's button and waited 20 s for it to read as pressed; it never did. The
test picks every theme in turn with the invite panel open, so this was one click of many.

## Next
The run's trace (artifacts of shard 5): did the click land on the button, or on something over it (the invite panel,
the card closing), and did the theme apply but `aria-pressed` not follow, or not apply at all.
