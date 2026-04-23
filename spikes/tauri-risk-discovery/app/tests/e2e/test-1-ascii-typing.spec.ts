import { test, expect } from '@playwright/test'

test('test-1-ascii-typing: types "Hello World" into BlockNote, verifies DOM', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })

  await editor.click()
  await page.keyboard.type('Hello World', { delay: 20 })

  const bodyText = await editor.innerText()
  expect(bodyText).toContain('Hello World')
})
