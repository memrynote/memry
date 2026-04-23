import { test, expect } from '@playwright/test'

const TURKISH_TEXT = 'İğüşçö çalışıyor mu?'

test('test-2-turkish-typing: types Turkish with diacritics', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })

  await editor.click()
  await page.keyboard.type(TURKISH_TEXT, { delay: 30 })

  const bodyText = await editor.innerText()
  expect(bodyText).toContain(TURKISH_TEXT)

  for (const ch of ['İ', 'ğ', 'ü', 'ş', 'ç', 'ö', 'ı']) {
    expect(bodyText).toContain(ch)
  }
})
