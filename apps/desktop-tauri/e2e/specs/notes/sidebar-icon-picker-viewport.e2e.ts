// The sidebar icon picker stays inside a short window (#1984, reopened from #801), ported from
// Electron's `sidebar-icon-picker-viewport.e2e.ts` (Step 13q-4, #3530).
//
// Radix runs `shift` before `flip`, so a bottom-placed panel taller than the room under a low
// row was flipped above its trigger with no second clamp, and its tab bar, the only route to the
// Icons and Custom tabs, ended above the viewport. The picker now opens to the side and is capped
// to the height Radix measured, so the emoji grid scrolls instead.
import { expandCollections, vaultOpen } from '../../harness/notes'
import { invokeTest } from '../../harness/invoke-test'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria
// Too short for the picker (~420px) under the lowest row, tall enough that the collections list
// is on screen at all (#2443, #2449).
const SHORT_WINDOW = { x: 0, y: 0, width: 1100, height: 560 }

test('the sidebar icon picker stays on screen in a short window, its tabs reachable', async ({
  app,
  page
}) => {
  await vaultOpen(page)
  const notes: Array<{ id: string }> = []
  for (let i = 0; i < 6; i++) {
    notes.push(
      await invoke<{ id: string }>(page, 'notes_create', {
        input: { title: `Picker Viewport ${i}`, content: 'seed' }
      })
    )
  }
  await invokeTest(app, 'e2e_set_window_rect', { label: 'main', ...SHORT_WINDOW })
  await expect
    .poll(async () => (await page.evaluate(() => window.innerHeight)) <= SHORT_WINDOW.height)
    .toBe(true)
  await expandCollections(page)

  // The lowest row is the worst case: least room below, most upward shift.
  for (const note of notes) {
    await expect(page.locator(`[data-tree-node-id="${note.id}"]`)).toBeVisible({ timeout: 30_000 })
  }
  const trigger = page.getByRole('button', { name: 'Set Icon' }).last()
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()

  const picker = page.getByRole('dialog', { name: PICKER })
  await expect(picker).toBeVisible({ timeout: 10_000 })

  // On the first open Radix places the popover while the lazy picker is still loading, so the
  // full panel shows up once at the unshifted spot (top at its row, bottom ~250px past the window)
  // and Radix moves it a ResizeObserver tick later. The rect is read until it settles; a panel
  // that stays out of the window still fails. The regression: a shifted panel's negative top.
  await expect
    .poll(async () => {
      const box = await picker.boundingBox()
      const viewportHeight = await page.evaluate(() => window.innerHeight)
      if (!box) return 'no box'
      return {
        aboveTop: Math.max(0, -box.y),
        belowBottom: Math.max(0, box.y + box.height - (viewportHeight + 1))
      }
    })
    .toEqual({ aboveTop: 0, belowBottom: 0 })

  // The tabs are what the reporter could not reach; they must click.
  const iconsTab = picker.getByRole('button', { name: 'Icons' })
  await expect(iconsTab).toBeVisible()
  await iconsTab.click()
  await expect(picker.locator('button[title]').first()).toBeVisible({ timeout: 10_000 })
})
