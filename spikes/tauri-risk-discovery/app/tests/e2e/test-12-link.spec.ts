import { test, expect } from '@playwright/test'

test('test-12-link: insert link via Cmd+K, verify href set', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  await page.keyboard.type('example site', { delay: 30 })
  await page.keyboard.press('Meta+a')
  await page.waitForTimeout(200)
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(500)

  await page.keyboard.type('https://example.com')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  const linkCount = await page.locator('.bn-editor a[href*="example.com"]').count()
  expect(linkCount).toBeGreaterThanOrEqual(1)
})
