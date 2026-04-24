import { test, expect } from '../fixtures/test-base'
import { bootApp, navigateTo, isAllowedConsoleNoise } from '../fixtures/helpers'

/**
 * Round-trip smoke: click through every primary nav route in sequence and
 * assert nothing crashes. Catches cross-route state bugs that individual
 * per-route specs can miss.
 */
test.describe('Sidebar round-trip', () => {
  test('navigates through all primary routes without errors', async ({
    page,
    consoleErrors
  }) => {
    await bootApp(page)

    for (const label of ['Inbox', 'Journal', 'Calendar', 'Tasks', 'Inbox'] as const) {
      await navigateTo(page, label)
      await expect(page.locator('body')).not.toContainText('Something went wrong')
    }

    await page.waitForLoadState('networkidle')
    const real = consoleErrors.filter((m) => !isAllowedConsoleNoise(m))
    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})
