/**
 * Note mind map E2E
 *
 * The one end-to-end journey the mind-map epic (#1667) asks for: open a note,
 * press the header toggle, see the note's structure as a map, click a heading
 * node, and land back in the editor at that heading.
 *
 * This journey is only reachable because the map ships a `role="tree"` DOM
 * projection alongside the drawing. The drawing itself is a bitmap surface —
 * Playwright cannot see a node inside it, cannot click one, and cannot read a
 * label off it. The tree layer exists for screen readers, for keyboard users,
 * and for exactly this file.
 *
 * The second test is the undo guarantee. The unit suite asserts it structurally
 * (the editor instance is the same object across a toggle round trip); here it
 * is asserted the way a user would notice it — type, look at the map, come back,
 * undo, and find the typing undone rather than the history gone.
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import {
  waitForAppReady,
  waitForVaultReady,
  seedNote,
  SELECTORS,
  SHORTCUTS
} from './utils/electron-helpers'
import { waitForNoteById, openNoteByHandle } from './utils/note-sync-helpers'

const NOTE_TITLE = 'Mind Map Journey'

/**
 * Long on purpose. The point of the last assertion is that the editor SCROLLED
 * to the clicked heading, so the note has to be taller than the viewport —
 * otherwise "the heading is on screen" is true before the click as well and the
 * test passes without the feature working.
 */
const FILLER = Array.from(
  { length: 12 },
  (_, i) => `Filler paragraph ${i + 1} keeping the sections far apart.`
).join('\n\n')

const NOTE_BODY = [
  '# Overview',
  FILLER,
  '## Background',
  FILLER,
  '# Risks',
  FILLER,
  '## Mitigations',
  FILLER,
  '# Closing Section',
  FILLER
].join('\n\n')

const TOGGLE = '[data-testid="note-mind-map-toggle"]'
const MAP = '[data-testid="note-mind-map"]'
const TREE = '[data-testid="mind-map-tree"]'
const HEADING_NODES = `${TREE} [role="treeitem"][data-mind-map-kind="heading"]`

async function seedAndOpen(page: Page): Promise<void> {
  const id = await seedNote(page, NOTE_TITLE, NOTE_BODY)
  const handle = await waitForNoteById(page, id, NOTE_TITLE)
  await openNoteByHandle(page, handle)
  await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(NOTE_TITLE)
}

test.describe('Note mind map', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('opens a note as a map and lands back on the heading a node names', async ({ page }) => {
    await seedAndOpen(page)

    const toggle = page.locator(TOGGLE)
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // The map replaces the body.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator(MAP)).toBeVisible()

    // The editor is HIDDEN, not unmounted. Both halves matter: `toBeAttached`
    // is the undo-history guarantee, `not.toBeVisible` is the replacement.
    const editor = page.locator(SELECTORS.noteEditor).first()
    await expect(editor).toBeAttached()
    await expect(editor).not.toBeVisible()

    // The region announces itself as the note's map.
    await expect(page.locator(`${MAP} [role="img"]`)).toHaveAttribute(
      'aria-label',
      new RegExp(NOTE_TITLE)
    )

    // Every heading in the note reached the tree.
    const headings = page.locator(HEADING_NODES)
    await expect(headings).toHaveCount(5)
    await expect(headings.filter({ hasText: 'Closing Section' })).toHaveCount(1)

    // Take the LAST heading, so landing on it requires a real scroll.
    const target = headings.filter({ hasText: 'Closing Section' }).first()
    const blockId = await target.getAttribute('data-mind-map-block')
    expect(blockId, 'a heading node carries no block anchor').toBeTruthy()

    // Activated from the keyboard, not with a mouse click, and deliberately so.
    // The tree is `sr-only` — it is the map's accessible projection, sitting at
    // one pixel underneath the drawing, and a pointer never reaches it in the
    // real product either. A mouse user clicks the drawn box on the canvas; a
    // screen-reader or keyboard user walks this tree. Driving it with the
    // keyboard is what the tree is for, and it doubles as the acceptance check
    // that keyboard activation does the same thing a click does.
    await target.press('Enter')

    // The map closed and gave the note back.
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator(MAP)).toHaveCount(0)
    await expect(editor).toBeVisible()

    // Landed on the clicked heading. `.first()` because a block id appears on
    // more than one node in the rendered block, which is why the app's own
    // `scrollToHeadingBlock` scopes its lookup and takes the first match too.
    const landed = page.locator(`[data-id="${blockId}"]`).first()
    await expect(landed).toBeInViewport({ timeout: 10000 })

    // ...and genuinely scrolled there rather than sitting at the top, which is
    // the assertion that fails if the toggle closes without navigating.
    const firstHeading = page.locator(`${SELECTORS.noteEditor} h1`).first()
    await expect(firstHeading).not.toBeInViewport()
  })

  test('keeps undo history across a trip to the map and back', async ({ page }) => {
    await seedAndOpen(page)

    const editor = page.locator(SELECTORS.noteEditor).first()
    await editor.click()
    await page.keyboard.press('End')

    const typed = 'typed before looking at the map'
    await page.keyboard.type(typed)
    await expect(editor).toContainText(typed)

    // Look at the map and come back.
    const toggle = page.locator(TOGGLE)
    await toggle.click()
    await expect(page.locator(MAP)).toBeVisible()
    await toggle.click()
    await expect(page.locator(MAP)).toHaveCount(0)
    await expect(editor).toBeVisible()

    // If the map had unmounted the editor, the collaborative undo manager would
    // have gone with it and this would undo nothing — or worse, everything.
    await editor.click()
    await page.keyboard.press(SHORTCUTS.undo)

    await expect(editor).not.toContainText(typed)
    await expect(editor).toContainText('Overview')
  })
})
