// The sidebar icon picker survives a sidebar scroll (#1986), ported from Electron's
// `sidebar-icon-picker-scroll.e2e.ts` (Step 13q-4, #3530).
//
// Past 100 tree items the sidebar swaps to the virtualized tree, which mounts only the visible
// rows plus an overscan. The picker is a Radix Popover rendered inside its row, so a scroll that
// pushed the row out of the virtual window unmounted the panel with it. The row whose picker is
// open is now pinned into the virtual range, and Radix re-anchors the panel.
//
// Electron scrolled with the mouse wheel. Through WebView2's WebDriver a wheel reaches the page
// as an event but scrolls nothing, not even a plain overflow box (checked on the Windows VM), so
// the spec moves the sidebar's scroll offset as the wheel would. The virtualizer follows the same
// scroll event either way.
import type { Locator } from '../../harness/pw-compat/locator'
import { expandCollections, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria
// The virtualized tree takes over at 100 items (VIRTUALIZATION_THRESHOLD).
const SEEDED_NOTES = 130

/** Creates the notes one after another through `notes_create`, as the renderer does. */
async function seedNotes(page: Page, count: number): Promise<void> {
  await page.evaluate(async (total: number) => {
    for (let i = 0; i < total; i++) {
      await window.__TAURI__.core.invoke('notes_create', {
        input: { title: `Picker Scroll ${String(i).padStart(3, '0')}`, content: 'seed' }
      })
    }
  }, count)
}

/** Scrolls the nearest scrolling ancestor of `trigger` by `top`; false when there is none. */
function scrollSidebar(trigger: Locator, top: number): Promise<boolean> {
  return trigger.evaluate((start: Element, by: number) => {
    for (let element = start.parentElement; element; element = element.parentElement) {
      const { overflowY } = getComputedStyle(element)
      const scrolls = overflowY === 'auto' || overflowY === 'scroll'
      if (scrolls && element.scrollHeight > element.clientHeight) {
        element.scrollBy({ top: by, behavior: 'instant' })
        return true
      }
    }
    return false
  }, top)
}

const mountedRows = (page: Page): Promise<string[]> =>
  page
    .locator('[data-tree-node-id]')
    .evaluateAll((rows: Element[]) =>
      rows.map((row) => row.getAttribute('data-tree-node-id') ?? '')
    )

test('the sidebar icon picker stays open when the virtualized tree scrolls under it', async ({
  page
}) => {
  await vaultOpen(page)
  await seedNotes(page, SEEDED_NOTES)
  await expandCollections(page)
  // The virtualized tree nests a row's treeitem under its positioned wrapper; the plain tree puts
  // both on one element. The swap remounts every row, an open picker with it.
  await expect(page.locator('[data-tree-node-id="folder-notes"] > [role="treeitem"]')).toBeVisible({
    timeout: 30_000
  })

  const triggers = page.getByRole('button', { name: 'Set Icon' })
  await triggers.first().waitFor({ state: 'visible', timeout: 30_000 })
  const trigger = triggers.nth(5)
  await trigger.click()

  const picker = page.getByRole('dialog', { name: PICKER })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  const before = await mountedRows(page)

  expect(await scrollSidebar(trigger, 800)).toBe(true)
  // The virtualizer has moved its window once rows it had mounted are gone.
  await expect
    .poll(async () => {
      const now = await mountedRows(page)
      return before.some((id) => !now.includes(id))
    })
    .toBe(true)

  // The regression: the row left the virtual window and took the panel with it.
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Icons' })).toBeVisible()
})
