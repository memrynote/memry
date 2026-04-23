import { test, expect } from '@playwright/test'

test('test-8-slash-menu: slash opens menu, filters, inserts heading', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  await page.keyboard.press('/')
  await page.waitForTimeout(300)

  const menu = page
    .locator(
      '[role="listbox"], [class*="slashMenu"], [class*="Suggestion"], [class*="bn-suggestion"]'
    )
    .first()
  await expect(menu).toBeVisible({ timeout: 3000 })

  await page.keyboard.type('heading')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)

  await page.keyboard.type('Slash Test')
  await page.waitForTimeout(300)

  const headingCount = await page
    .locator('.bn-editor h1, .bn-editor [data-content-type="heading"]')
    .count()
  expect(headingCount).toBeGreaterThanOrEqual(1)
})
