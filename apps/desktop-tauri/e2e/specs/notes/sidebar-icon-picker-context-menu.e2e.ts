// The icon picker opened from a sidebar row's context menu, not from its icon button (#2204),
// ported from Electron's `sidebar-icon-picker-context-menu.e2e.ts` (Step 13q-4, #3530).
//
// Reported symptom: right-click a row, choose "Set icon", and the picker appears and closes
// again. The chosen menu stays mounted for its exit animation and its items still answer the
// pointer, so a pointer event reaching it pulls focus back into the menu and the popover closes
// as an outside interaction (#2340). Windows sends a zero-distance pointer move after a click,
// so the spec keeps the pointer moving after choosing the item, as a hand does.
//
// A bare visibility check passes on the first frame, on exactly the bug hunted here, so the
// picker is checked again after the menu has unmounted and handed focus back.
//
// Electron's canvas folder case waits for canvases, which Step 30 (#3547) ports.
import { expandCollections, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria

/** Covers the Radix exit animation and the focus-restore tick that follows it. */
const FOCUS_RESTORE_SETTLE_MS = 800

/** Clicks the item, then moves the pointer over the fading menu, the first move zero-distance. */
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

/**
 * The picker is open, and still open once the menu is gone. Clicking a tab proves the panel is
 * usable and not an exit-animation leftover.
 */
async function expectPickerToStayOpen(page: Page): Promise<void> {
  const picker = page.getByRole('dialog', { name: PICKER })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(0)

  await page.waitForTimeout(FOCUS_RESTORE_SETTLE_MS)
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

test('the icon picker opened from a note row menu stays open', async ({ page }) => {
  await vaultOpen(page)
  const note = await invoke<{ id: string }>(page, 'notes_create', {
    input: { title: 'Context Menu Icon Note', content: 'seed' }
  })
  await expandCollections(page)

  const row = page.locator(`[data-tree-node-id="${note.id}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })

  // The entry point under test: the menu item, never the icon button.
  await row.click({ button: 'right' })
  await clickMenuItemAndMoveOn(page, 'Set Icon')

  await expectPickerToStayOpen(page)
})
