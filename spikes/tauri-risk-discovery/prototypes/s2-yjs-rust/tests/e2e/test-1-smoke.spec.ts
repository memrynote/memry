import { test, expect } from '@playwright/test'

// S2 Test 1 — Prototype B typing smoke.
//
// Runs against Vite HMR server only (no Tauri runtime). invoke() silent-fails
// here, so Rust-side state is NOT verified. Goal: renderer + shadow Y.Doc +
// event listener setup does not crash, and typing flows text into the
// editor as expected. Rust interop correctness is tested in the cargo
// integration tests + Node vitest suites.

test.describe('S2 Prototype B — renderer smoke', () => {
  test('types into BlockNote with shadow Y.Doc + listener wired', async ({ page }) => {
    await page.goto('/')
    const editor = page.locator('.bn-editor')
    await editor.waitFor({ timeout: 10000 })
    await editor.click()

    await page.keyboard.type('hello from proto B', { delay: 10 })

    await expect(editor).toContainText('hello from proto B')

    // Status bar counters are visible (sanity — confirms App.tsx rendered fully)
    await expect(page.locator('[data-testid="updates-sent"]')).toBeVisible()
    await expect(page.locator('[data-testid="echo-skipped"]')).toBeVisible()
    await expect(page.locator('[data-testid="last-sv-bytes"]')).toBeVisible()
  })
})
