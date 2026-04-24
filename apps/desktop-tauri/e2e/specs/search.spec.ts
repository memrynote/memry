import { test, expect } from '../fixtures/test-base'
import { bootApp } from '../fixtures/helpers'

test.describe('Search / Command palette', () => {
  test('global search shortcut opens a searchable dialog', async ({ page, browserName }) => {
    await bootApp(page)

    const modifier = browserName === 'webkit' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+KeyK`)

    // cmdk renders a [cmdk-input] element inside its open dialog.
    await expect(page.locator('[cmdk-dialog][data-state="open"]')).toHaveCount(1, {
      timeout: 5000
    })
    const input = page.locator('[cmdk-input]').first()
    await expect(input).toBeVisible()
  })
})
