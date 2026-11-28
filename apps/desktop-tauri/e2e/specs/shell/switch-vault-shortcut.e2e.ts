// ⌘⇧O (⌃⇧O off macOS) opens the sidebar's vault switcher from anywhere, so a vault switch no
// longer starts with reopening the sidebar. Escape closes it again without touching the active
// vault. Ported from Electron's `switch-vault-shortcut.e2e.ts` (#3547 30h).
import { waitForAppReady } from '../../harness/app-helpers'
import { appReady } from '../../harness/app-ready'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { test as base, expect } from '../../harness/test'

/** Each case starts on a ready app, as Electron's `beforeEach` did. */
const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await appReady(page)
    await waitForAppReady(page)
    await use(page)
  }
})

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SWITCH_VAULT = `${MOD}+Shift+O`

function picker(page: Page): Locator {
  return page.locator('[data-slot="picker-content"]')
}

test.describe('Switch vault shortcut', () => {
  test('opens the vault switcher and closes it on Escape', async ({ page }) => {
    await expect(picker(page)).toHaveCount(0)

    await page.keyboard.press(SWITCH_VAULT)

    const content = picker(page).first()
    await expect(content).toBeVisible()
    await expect(content).toContainText(/vault/i)

    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
  })

  test('walks the vault list with the arrow keys', async ({ page }) => {
    await page.keyboard.press(SWITCH_VAULT)

    const content = picker(page).first()
    await expect(content).toBeVisible()

    // Opens on the active vault, so the first row a keyboard user sees is the one they are in.
    await expect(content.locator('[data-active-vault="true"]')).toBeFocused()

    const rows = content.locator('[data-slot="picker-list"] button:not([disabled])')
    const rowCount = await rows.count()

    await page.keyboard.press('ArrowDown')
    // One vault plus "Open vault" is the floor, so there is always a next row; with a single
    // row the wrap lands back on it.
    // WebKit matches `:focus` only while the window itself is focused, which a WebDriver-driven
    // window need not be, so the focused row is read from `document.activeElement`.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const list = document.querySelector('[data-slot="picker-content"]')
          const active = document.activeElement
          return list !== null && active !== null && active !== list && list.contains(active)
        })
      )
      .toBe(true)
    if (rowCount > 1) {
      await expect(content.locator('[data-active-vault="true"]')).not.toBeFocused()
    }

    await page.keyboard.press('ArrowUp')
    await expect(content.locator('[data-active-vault="true"]')).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
  })

  test('opens from inside the note editor, which has no ⌘⇧O of its own', async ({ page }) => {
    await page.keyboard.press(`${MOD}+n`)
    const editor = page.locator('[aria-label="Rich text editor"] [contenteditable="true"]').first()
    await editor.click()
    await expect(editor).toBeFocused()

    await page.keyboard.press(SWITCH_VAULT)

    await expect(picker(page).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
  })
})
