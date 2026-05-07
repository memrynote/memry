# Task 14: Extend Phase A's `i18n.spec.ts` with visible-flip assertion

> **Plan:** Task 14 (Extend Phase A's `i18n.spec.ts` E2E with Visible-Flip Assertion)
> **Depends on:** At least Tasks 05 and 06 merged (so a Cancel button reads "İptal" after switching)
> **Dependents:** Task 15

## Pre-flight check

```bash
pwd                                                              # ../memry-i18n-phase-b
git status                                                       # clean
cat apps/desktop/tests/e2e/i18n.spec.ts                          # read existing 3 scenarios
ls apps/desktop/tests/e2e/utils/electron-helpers.ts              # confirm helpers exist
```

## Your job

Append a 4th scenario to the existing `test.describe('i18n', ...)` block in `i18n.spec.ts`. The scenario asserts that a _real_ renderer-process button (Cancel in a delete dialog or settings modal) flips to "İptal" after switching to Turkish — proving the user-facing migration works in production-builds, not just the settings picker label that Phase A seeded.

Per Memry's MEMORY.md, e2e runs against the **built bundle** (`out/main/index.js`). Always rebuild after source edits: `pnpm --filter @memry/desktop build`.

## Steps

1. Append a new test inside the existing `test.describe('i18n', () => { ... })` block in `apps/desktop/tests/e2e/i18n.spec.ts`:

```ts
test('migrated common-namespace strings flip in renderer UI', async () => {
  const { app, page } = await launchApp()

  // 1. Switch to Turkish via the language picker.
  await openSettings(page)
  await page.locator('#language-select').click()
  await page.locator('[role="option"][data-value="tr"]').click()
  await page.waitForTimeout(200)

  // 2. Assert document language flipped (proxy for runtime change).
  const lang = await page.locator('html').getAttribute('lang')
  expect(lang).toBe('tr')

  // 3. Assert at least one migrated common.* string is visible.
  // After Phase B, opening any of the migrated dialogs (unsaved-changes,
  // bulk-delete, note-tree-delete, task-delete, calendar-delete) shows
  // an "İptal" Cancel button. The settings modal itself may also have
  // a Cancel/Close button reading the new label depending on layout.
  //
  // Pragmatic assertion: query all buttons with text "İptal" and expect
  // at least one in the document.
  const cancelButtons = page.locator('button', { hasText: 'İptal' })
  await expect(cancelButtons.first()).toBeVisible({ timeout: 5000 })

  await app.close()
})
```

If Memry's settings modal doesn't reliably surface a Cancel button at idle, reach a known-migrated dialog explicitly:

- Open a note (any note) → tweak it → attempt to close the tab → unsaved-changes dialog opens → Cancel reads "İptal".

Adjust the test to match what's reliably reachable in the Playwright environment.

2. Build the desktop bundle:

```bash
pnpm --filter @memry/desktop build
```

Expected: build succeeds, `out/main/index.js` exists.

3. Run the e2e:

```bash
pnpm --filter @memry/desktop test:e2e i18n
```

Expected: 4 tests pass (3 from Phase A + 1 new). If the new test fails because the Cancel button isn't reachable, refactor the test to navigate to a guaranteed-reachable post-migration dialog.

4. Commit:

```bash
git add apps/desktop/tests/e2e/i18n.spec.ts
git commit -m "test(i18n): assert migrated common buttons flip in Turkish e2e"
```

## Exit criteria

- [ ] New scenario appended to existing `i18n.spec.ts` (no other changes to existing tests)
- [ ] Built bundle exists in `out/`
- [ ] `pnpm test:e2e i18n` passes (4 scenarios)
- [ ] One commit created

## Skills to use

`superpowers:e2e-testing-patterns` if the test is flaky or selectors don't resolve.

## Report back

```
✅ Task 14 complete.
Commit SHA: <abbrev>
E2E scenarios: 4/4 passing (3 from Phase A + 1 from Phase B)
Visible-flip assertion: ✅ "İptal" button found after switching to tr
Next: Task 15 (final verification + PR)
```
