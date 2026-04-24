import { test, expect } from '../fixtures/test-base'
import { bootApp, navigateTo, isAllowedConsoleNoise } from '../fixtures/helpers'

test.describe('Calendar route', () => {
  test('clicking Calendar opens the calendar view', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Calendar')

    await expect(page.locator('body')).not.toContainText('Something went wrong')
    // Calendar page surfaces day/week/month/year view switcher.
    await expect(
      page.getByRole('button', { name: /day|week|month|year/i }).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('calendar route has no console errors', async ({ page, consoleErrors }) => {
    await bootApp(page)
    await navigateTo(page, 'Calendar')
    await page.waitForLoadState('networkidle')
    const real = consoleErrors.filter((m) => !isAllowedConsoleNoise(m))
    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})
