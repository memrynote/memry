import { test, expect } from '../fixtures/test-base'
import { bootApp, navigateTo, isAllowedConsoleNoise } from '../fixtures/helpers'

test.describe('Tasks route', () => {
  test('clicking Tasks opens the tasks workspace', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Tasks')

    await expect(page.locator('body')).not.toContainText('Something went wrong')
    // Tasks page has project picker / view switcher.
    await expect(page.getByRole('button').first()).toBeVisible()
  })

  test('tasks route has no console errors', async ({ page, consoleErrors }) => {
    await bootApp(page)
    await navigateTo(page, 'Tasks')
    await page.waitForLoadState('networkidle')
    const real = consoleErrors.filter((m) => !isAllowedConsoleNoise(m))
    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})
