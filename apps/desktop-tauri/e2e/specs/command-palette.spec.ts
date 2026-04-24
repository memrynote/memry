import { test, expect } from '../fixtures/test-base'
import { bootApp } from '../fixtures/helpers'

test.describe('Command palette', () => {
  test('Cmd+K opens the command palette', async ({ page, browserName }) => {
    await bootApp(page)

    // Platform-appropriate chord: Meta on webkit (Safari/Tauri on macOS).
    const modifier = browserName === 'webkit' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+KeyK`)

    // cmdk dialog toggles data-state="open" — more reliable than visibility
    // checks because the dialog uses position: fixed + CSS transitions that
    // Playwright sometimes reports as hidden during the fade-in.
    const dialog = page.locator('[cmdk-dialog][data-state="open"]').first()
    await expect(dialog).toHaveCount(1, { timeout: 5000 })
  })

  test('Escape closes the command palette', async ({ page, browserName }) => {
    await bootApp(page)
    const modifier = browserName === 'webkit' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+KeyK`)
    await expect(page.locator('[cmdk-dialog][data-state="open"]').first()).toHaveCount(1, {
      timeout: 5000
    })

    await page.keyboard.press('Escape')
    await expect(page.locator('[cmdk-dialog][data-state="open"]')).toHaveCount(0, {
      timeout: 5000
    })
  })
})
