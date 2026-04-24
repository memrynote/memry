import { test, expect } from '../fixtures/test-base'
import { bootApp } from '../fixtures/helpers'

test.describe('Theme', () => {
  test('initial theme class is applied to <html>', async ({ page }) => {
    await bootApp(page)

    // next-themes applies "light" | "dark" | "white" to the <html> classList
    // from the startup localStorage value (default "system" → resolves to
    // "light" in headless WebKit).
    const htmlClass = await page.locator('html').getAttribute('class')
    expect(htmlClass, `html element missing theme class`).toMatch(/light|dark|white/)
  })

  test('clicking inside the page does not unset theme class', async ({ page }) => {
    await bootApp(page)
    const before = await page.locator('html').getAttribute('class')
    await page.locator('body').click({ position: { x: 200, y: 200 } })
    const after = await page.locator('html').getAttribute('class')
    expect(after).toBe(before)
  })
})
