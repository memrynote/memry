import { test, expect } from '@playwright/test'

test('test-11-code-block: insert code block, type code, verify renders', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  await page.keyboard.press('/')
  await page.waitForTimeout(300)
  await page.keyboard.type('code')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  const codeCount = await page
    .locator('.bn-editor pre, .bn-editor code, .bn-editor [data-content-type="codeBlock"]')
    .count()
  expect(codeCount).toBeGreaterThanOrEqual(1)

  await page.keyboard.type('const x = 42;')
  await page.waitForTimeout(300)

  const afterText = await editor.innerText()
  expect(afterText).toContain('const x = 42;')
})
