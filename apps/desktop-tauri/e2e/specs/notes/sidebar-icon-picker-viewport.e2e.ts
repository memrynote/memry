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

  const box = await picker.boundingBox()
  expect(box).not.toBeNull()
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  // The regression: a shifted panel reports a negative top.
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1)

  // The tabs are what the reporter could not reach; they must click.
  const iconsTab = picker.getByRole('button', { name: 'Icons' })
  await expect(iconsTab).toBeVisible()
  await iconsTab.click()
  await expect(picker.locator('button[title]').first()).toBeVisible({ timeout: 10_000 })
})
