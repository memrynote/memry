import { test, expect } from '../fixtures/test-base'

test.describe('Landing', () => {
  test('app shell renders with non-empty body text', async ({ page }) => {
    // #given the app loads with mock-backed IPC
    await page.goto('/')

    // #when React mounts
    await page.waitForFunction(
      () => (document.body.textContent ?? '').trim().length > 0,
      null,
      { timeout: 10_000 }
    )

    // #then the app shell has mounted — no blank white screen, no error boundary
    await expect(page.locator('body')).not.toContainText('Something went wrong')
    const rootText = await page.locator('#root').innerText()
    expect(rootText.length).toBeGreaterThan(10)
  })

  test('sidebar exposes the primary navigation items', async ({ page }) => {
    await page.goto('/')

    // Dismiss the first-run onboarding if it appears (mock config has
    // onboardingCompleted=false for the main settings channel).
    const getStarted = page.getByRole('button', { name: /get started/i })
    if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) {
      await getStarted.click()
    }

    for (const label of ['Inbox', 'Journal', 'Calendar', 'Tasks']) {
      await expect(page.getByRole('button', { name: new RegExp(label, 'i') }).first()).toBeVisible()
    }
  })

  test('no unhandled rejections or console errors during initial mount', async ({
    page,
    consoleErrors
  }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Known noise to allow: Notification permission prompt (Tauri-specific),
    // electron-log main-process init (inert in browser), "Query data cannot
    // be undefined" (pre-existing bug in session-restore/day-panel queries,
    // M2 cleanup — doesn't crash the renderer).
    const allowNoise = (msg: string): boolean =>
      msg.includes('Notification prompting') ||
      msg.includes("electron-log: logger isn't initialized") ||
      msg.includes('Query data cannot be undefined') ||
      msg.includes('setState() call inside') // React strictmode dev warning
    const real = consoleErrors.filter((m) => !allowNoise(m))

    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})
