import { test, expect } from '../fixtures/test-base'
import { bootApp, navigateTo, isAllowedConsoleNoise } from '../fixtures/helpers'

test.describe('Inbox route', () => {
  test('clicking Inbox opens the inbox view', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Inbox')

    // #then main area shows the Inbox page — either header text or one of
    // the mock inbox items.
    await expect(page.getByText(/inbox/i).first()).toBeVisible()
  })

  test('inbox route has no console errors', async ({ page, consoleErrors }) => {
    await bootApp(page)
    await navigateTo(page, 'Inbox')
    await page.waitForLoadState('networkidle')
    const real = consoleErrors.filter((m) => !isAllowedConsoleNoise(m))
    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})
