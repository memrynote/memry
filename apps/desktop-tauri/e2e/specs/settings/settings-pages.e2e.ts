// The Settings pages render with the not-ported shim underneath the ported `window.api.settings`:
// a name the port lacks must reject, never throw, or the tab error boundary replaces the page.
import { test, expect } from '../../harness/test'

test('Settings Shortcuts opens without the tab error boundary', async ({ page }) => {
  await expect
    .poll(() => page.evaluate(() => typeof window.api?.settings), { timeout: 30_000 })
    .toBe('object')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
  await expect(page.getByText('Something went wrong')).toHaveCount(0)
})
