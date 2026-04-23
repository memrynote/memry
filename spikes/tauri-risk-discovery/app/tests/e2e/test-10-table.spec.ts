import { test, expect } from '@playwright/test'

test('test-10-table: insert table via slash menu, type into cell', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  await page.keyboard.press('/')
  await page.waitForTimeout(300)
  await page.keyboard.type('table')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  const tableCount = await page.locator('.bn-editor table').count()
  expect(tableCount).toBeGreaterThanOrEqual(1)

  await page.keyboard.type('cell-1')
  await page.waitForTimeout(300)

  const afterText = await editor.innerText()
  expect(afterText).toContain('cell-1')
})
