import { test, expect } from '../fixtures/test-base'
import { bootApp, isAllowedConsoleNoise } from '../fixtures/helpers'

test.describe('Settings modal', () => {
  test('Cmd+, opens the settings modal', async ({ page, browserName }) => {
    await bootApp(page)

    const modifier = browserName === 'webkit' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+Comma`)

    // The settings modal uses a role="dialog" container.
    const dialog = page.getByRole('dialog').first()
    await expect(dialog).toBeVisible({ timeout: 5000 })
  })

  test('opening and closing settings does not throw', async ({
    page,
    browserName,
    consoleErrors
  }) => {
    await bootApp(page)
    const modifier = browserName === 'webkit' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+Comma`)
    await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog').first()).not.toBeVisible({ timeout: 3000 })

    const real = consoleErrors.filter((m) => !isAllowedConsoleNoise(m))
    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})
