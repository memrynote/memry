import { test, expect } from '@playwright/test'

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit volup'

test('test-4-paste-plain-text: pastes 500-char plain text via clipboard', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  await page.evaluate((text) => navigator.clipboard.writeText(text), LOREM)

  const isMac = process.platform === 'darwin'
  await page.keyboard.press(isMac ? 'Meta+v' : 'Control+v')
  await page.waitForTimeout(500)

  const bodyText = await editor.innerText()
  expect(bodyText.length).toBeGreaterThanOrEqual(LOREM.length - 5)
  expect(bodyText).toContain(LOREM.slice(0, 50))
  expect(bodyText).toContain(LOREM.slice(-50))
})
