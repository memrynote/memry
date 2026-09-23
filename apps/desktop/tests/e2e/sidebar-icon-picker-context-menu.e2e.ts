// @ts-nocheck - E2E tests in development, follow canvas-folder-rename.e2e.ts convention
/**
 * Opening the icon picker from a ROW'S CONTEXT MENU, not from its icon button (#2204).
 *
 * Reported symptom: right-click a sidebar folder, choose "Set icon", the picker
 * appears and immediately closes again. Both existing icon-picker specs
 * (sidebar-icon-picker-scroll, sidebar-icon-picker-viewport) open the panel by
 * clicking the icon-button TRIGGER, so neither one exercises this entry point.
 *
 * The cause (#2340): the chosen menu stays mounted for its exit animation and
 * its items still answer the pointer, so any pointer event reaching it pulls
 * focus back into the menu and the popover closes as an outside interaction.
 * One zero-distance pointermove after the click is enough, which is likely why
 * Windows, with its trailing mouse move after a click, hit it on nearly every open. `page.click()` parks the mouse, so both
 * specs keep the pointer moving after choosing the item, as a user does.
 *
 * NOTE ON THE ASSERTIONS: a bare `expect(picker).toBeVisible()` resolves on the
 * first frame and would pass even if the panel closes one frame later, i.e. it
 * would pass on exactly the bug being hunted. Every check below therefore waits
 * past the menu's unmount + focus-restore tick first and then asserts again.
 *
 * @see components/sidebar/canvas-tree/canvas-folder-row (folder path)
 * @see components/notes-tree (note path)
 */
import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria

/** Long enough to cover the Radix exit animation AND the focus-restore tick. */
const FOCUS_RESTORE_SETTLE_MS = 800

/**
 * Click the item, then keep the pointer moving across the fading menu, as in
 * sidebar-folder-rename.e2e.ts. The first move is zero-distance, like the
 * trailing mouse move Windows delivers after a click.
 */
async function clickMenuItemAndMoveOn(page: Page, label: string): Promise<void> {
  const item = page.getByRole('menuitem', { name: label, exact: true })
  await expect(item).toBeVisible()
  const box = await item.boundingBox()
  await item.click()
  if (!box) return
  for (let dy = 0; dy <= 48; dy += 6) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy)
    await page.waitForTimeout(20)
  }
}

async function openVault(page: Page): Promise<void> {
  await page
    .locator('aside, [data-testid="sidebar"], [class*="sidebar"], nav')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
  await ready(page)
}

async function expandSection(page: Page, name: RegExp): Promise<void> {
  const header = page.getByRole('button', { name })
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

/**
 * Asserts the picker is open, and STILL open after the context menu has fully
 * gone away. The settle is the point of the spec: #2204 is a panel that exists
 * for a frame or two, so the second assertion is the only one that can fail the
 * way the reporter described. Interacting with a tab afterwards proves the
 * panel is genuinely usable and not just a leftover exit-animation ghost.
 */
async function expectPickerToStayOpen(page: Page): Promise<void> {
  const picker = page.getByRole('dialog', { name: PICKER })
  await expect(picker).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(FOCUS_RESTORE_SETTLE_MS)
  // Two animation frames on top, so nothing scheduled by the unmount is pending.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  )

  await expect(picker).toBeVisible()
  await expect(picker).toHaveCount(1)

  const iconsTab = picker.getByRole('button', { name: 'Icons' })
  await expect(iconsTab).toBeVisible()
  await iconsTab.click()
  await expect(picker.locator('button[title]').first()).toBeVisible({ timeout: 10_000 })
}

test.describe('Icon picker opened from a row context menu', () => {
  test.describe.configure({ timeout: 180_000 })

  test('stays open for a canvas folder row', async ({ page }) => {
    await openVault(page)
    await expandSection(page, /Canvases section/)

    // A folder created from the header drops straight into rename mode.
    const header = page.getByRole('button', { name: /Canvases section/ })
    await header.hover()
    await page.getByRole('button', { name: 'New canvas folder', exact: true }).click()

    const newRow = page.locator(
      '[data-testid="canvas-tree-row"][data-row-key="folder:Untitled Folder"]'
    )
    await expect(newRow).toBeVisible({ timeout: 30_000 })
    const field = newRow.getByLabel('Folder name')
    await expect(field).toBeVisible()
    await field.fill('Icons')
    await field.press('Enter')

    const row = page.locator('[data-testid="canvas-tree-row"][data-row-key="folder:Icons"]')
    await expect(row).toBeVisible({ timeout: 30_000 })

    // The entry point under test: the MENU ITEM, never the icon button trigger.
    await row.click({ button: 'right' })
    const menu = page.locator('[data-testid="canvas-tree-menu"]')
    await expect(menu).toBeVisible()
    await clickMenuItemAndMoveOn(page, 'Set icon')

    await expectPickerToStayOpen(page)
  })

  test('stays open for a note row', async ({ page }) => {
    await openVault(page)
    await page.evaluate(async () => {
      await (window as unknown as { api: Record<string, any> }).api.notes.create({
        title: 'Context Menu Icon Note',
        content: 'seed'
      })
    })
    await page.reload()
    await openVault(page)
    await expandSection(page, /Collections section/)

    const row = page
      // Note rows carry the note id verbatim in data-tree-node-id (notes-tree → TreeNode).
      .locator('[data-tree-node-id]')
      .filter({ hasText: 'Context Menu Icon Note' })
      .first()
    await expect(row).toBeVisible({ timeout: 30_000 })

    await row.click({ button: 'right' })
    await clickMenuItemAndMoveOn(page, 'Set Icon')

    await expectPickerToStayOpen(page)
  })
})
