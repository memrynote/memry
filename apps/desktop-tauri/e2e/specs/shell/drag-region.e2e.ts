// Window drag regions (inv09#6): the shell's init script, not `-webkit-app-region`, makes
// `.drag-region` act on the window.
import { test, expect } from '../../harness/test'
import { appReady } from '../../harness/app-ready'
import type { Page } from '../../harness/pw-compat/page'

const isMaximized = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized') as Promise<boolean>
  )

const dblclick = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((sel) => {
    const target = document.querySelector(sel)
    if (!target) return false
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    return true
  }, selector)

test('the shell publishes its globals to the main frame', async ({ page }) => {
  await appReady(page)
  expect(await page.evaluate(() => window.__MEMRY_SHELL__?.maximizable)).toBe(true)
})

test('a double click on a drag region toggles maximize, and one on a button does not', async ({
  page
}) => {
  await appReady(page)
  expect(await isMaximized(page)).toBe(false)

  expect(await dblclick(page, '.drag-region button')).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(await isMaximized(page)).toBe(false)

  expect(await dblclick(page, '.drag-region')).toBe(true)
  await expect.poll(() => isMaximized(page), { timeout: 10_000 }).toBe(true)

  await dblclick(page, '.drag-region')
  await expect.poll(() => isMaximized(page), { timeout: 10_000 }).toBe(false)
})
