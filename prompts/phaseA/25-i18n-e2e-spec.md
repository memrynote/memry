# Task 25: Add Playwright E2E spec for i18n

> **Plan:** Task 25 (Add `i18n.spec.ts` Playwright E2E)
> **Depends on:** Tasks 23 (picker built), 24 (errors translatable)
> **Dependents:** Task 28 (final verification runs this)

## Pre-flight check

```bash
pwd                                                                     # ../memry-i18n-phase-a
git status                                                              # clean
ls apps/desktop/tests/e2e/                                              # see e2e structure
cat apps/desktop/tests/e2e/utils/electron-helpers.ts | head -50         # see helper functions
```

**Critical:** Memry's E2E tests run against the **built bundle** at `out/main/index.js`, not source. You must rebuild before running. (See Memry's MEMORY.md for context.)

## Your job

Three test scenarios:

1. **Switch language live** — pick Türkçe in settings, assert UI text flips, assert success toast in Turkish
2. **RTL applied for Arabic** — pick Arabic, assert `<html dir="rtl">` and `<html lang="ar">`
3. **Native menu rebuilds in new language** — pick Türkçe, assert "Dosya" appears in `Menu.getApplicationMenu().items`

Use bounding-box assertions (not pixel snapshots) for layout checks — they're stable across runs and don't generate flaky failures.

## Steps

1. **Build the desktop app**:

```bash
pnpm --filter @memry/desktop build
ls -la apps/desktop/out/main/index.js   # must exist
```

2. **Create `apps/desktop/tests/e2e/i18n.spec.ts`**:

```ts
import { test, expect } from '@playwright/test'
// Import from Memry's actual electron-helpers exports — adjust names if different
import { launchApp, openSettings } from './utils/electron-helpers'

test.describe('i18n', () => {
  test('switches language live', async () => {
    const { app, page } = await launchApp()
    await openSettings(page)

    // Open the language select. Use the actual selector from the picker
    // implementation in Task 23 — likely `#language-select` per the plan,
    // or shadcn's data-attribute selectors.
    await page.locator('#language-select').click()
    await page.locator('[role="option"][data-value="tr"]').click()

    // The "Language" label flips to Turkish "Dil"
    await expect(page.getByText('Dil')).toBeVisible()

    // Toast confirms in Turkish
    await expect(page.getByText(/Dil .* olarak değiştirildi/)).toBeVisible()

    await app.close()
  })

  test('applies dir="rtl" for Arabic', async () => {
    const { app, page } = await launchApp()
    await openSettings(page)

    await page.locator('#language-select').click()
    await page.locator('[role="option"][data-value="ar"]').click()

    const dir = await page.locator('html').getAttribute('dir')
    expect(dir).toBe('rtl')

    const lang = await page.locator('html').getAttribute('lang')
    expect(lang).toBe('ar')

    await app.close()
  })

  test('rebuilds native menu in new language', async () => {
    const { app, page } = await launchApp()
    await openSettings(page)

    await page.locator('#language-select').click()
    await page.locator('[role="option"][data-value="tr"]').click()
    await page.waitForTimeout(200) // give the menu rebuild a tick

    const menuLabels = await app.evaluate(({ Menu }) => {
      return Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []
    })

    expect(menuLabels).toContain('Dosya')

    await app.close()
  })
})
```

**Adjust selectors and helper imports** to match Memry's actual conventions. The grep on `electron-helpers.ts` shows you what's exported. Likely names:

- `launchApp` — boots Electron + returns `{ app, page }`
- `openSettings` — navigates to Settings page

If the picker doesn't render `#language-select` as the trigger ID, find the actual selector. shadcn's `<SelectTrigger>` accepts `id` props, so the Task 23 implementation should set it.

3. **Run the new spec**:

```bash
pnpm --filter @memry/desktop test:e2e i18n
```

Expected: 3 tests pass.

4. **If tests fail**: common causes per Memry's MEMORY.md:

- **Stale `out/`**: rebuild via `pnpm --filter @memry/desktop build`
- **Native module mismatch**: `bash apps/desktop/scripts/ensure-native.sh electron`
- **Selector mismatch**: the picker renders different attributes than expected. Inspect via `pnpm dev` + DevTools to find correct selectors

5. **Commit**:

```bash
git add apps/desktop/tests/e2e/i18n.spec.ts
git commit -m "test(i18n): e2e — live switch, RTL, native menu rebuild"
```

## Exit criteria

- [ ] `apps/desktop/tests/e2e/i18n.spec.ts` exists with 3 tests
- [ ] All 3 tests pass against built bundle
- [ ] Tests are deterministic (no `waitForTimeout` exceeding 500ms, no pixel snapshots)
- [ ] One commit

## Skills to use

- **`superpowers:test-driven-development`** — partial: the implementation already exists from prior tasks, but the tests are written _fresh_ for the spec
- **`superpowers:verification-before-completion`** — all 3 tests must actually pass

## Report back

```
✅ Task 25 complete.
Commit SHA: <abbrev>
E2E tests: 3 pass
- live switch
- RTL applied
- native menu rebuild
Next: Task 26 (adding-locale doc)
```
