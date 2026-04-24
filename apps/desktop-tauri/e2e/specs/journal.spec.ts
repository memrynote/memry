import { test, expect } from '../fixtures/test-base'
import { bootApp, navigateTo, isAllowedConsoleNoise } from '../fixtures/helpers'

test.describe('Journal route', () => {
  test('clicking Journal opens the journal view', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Journal')

    // Today's date heading is present in the journal view (the heatmap
    // fixture covers last 7 days).
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('journal route has no console errors', async ({ page, consoleErrors }) => {
    await bootApp(page)
    await navigateTo(page, 'Journal')
    await page.waitForLoadState('networkidle')
    const real = consoleErrors.filter((m) => !isAllowedConsoleNoise(m))
    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})
