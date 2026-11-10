// The note mind map, ported from Electron's `mind-map.e2e.ts` (Step 14k, #3531): open a note as a
// map, activate a heading node, land back in the editor at that heading; and the editor's undo
// history survives a trip to the map. The drawing is a bitmap a driver cannot read, so the specs
// walk the map's `role="tree"` projection, as a screen reader or keyboard user does.
import { SHORTCUTS } from '../../harness/app-helpers'
import { typeInEditor } from '../../harness/editor'
import { createNote, NOTE_EDITOR, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const NOTE_TITLE = 'Mind Map Journey'

/**
 * Taller than the viewport on purpose: the last assertion is that the editor scrolled to the
 * activated heading, which would hold before the activation on a short note.
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
  await vaultOpen(page)
  const note = await createNote(page, { title: NOTE_TITLE, content: NOTE_BODY })
  await openFromSidebar(page, note)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })
}

/** Whether any part of the element is inside the window's viewport, as `toBeInViewport`. */
const inViewport = (locator: Locator): Promise<boolean> =>
  locator.evaluate((el: Element) => {
    const box = el.getBoundingClientRect()
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.bottom > 0 &&
      box.right > 0 &&
      box.top < window.innerHeight &&
      box.left < window.innerWidth
    )
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

  // The editor is hidden, not unmounted: still in the DOM (the undo history), no longer shown.
  const editor = page.locator(NOTE_EDITOR).first()
  await expect(page.locator(NOTE_EDITOR)).toHaveCount(1)
  await expect(editor).toBeHidden()

  // The labelled region names the note; icons render as role="img" too, but decorative.
  const mapRegion = page.locator(`${MAP} [role="img"][aria-label]:not([aria-hidden="true"])`)
  await expect(mapRegion).toHaveAttribute('aria-label', new RegExp(NOTE_TITLE))

  // Every heading in the note reached the tree.
  const headings = page.locator(HEADING_NODES)
  await expect(headings).toHaveCount(5)
  await expect(headings.filter({ hasText: 'Closing Section' })).toHaveCount(1)

  // The last heading, so landing on it takes a real scroll.
  const target = headings.filter({ hasText: 'Closing Section' }).first()
  const blockId = await target.getAttribute('data-mind-map-block')
  expect(blockId).toBeTruthy()

  // From the keyboard: the tree is the map's sr-only projection, which a pointer never reaches.
  // Focus, then Enter, as Playwright's `press` does; the harness's `press` hit-tests the target
  // first, and the one-pixel tree sits under the sidebar.
  await target.focus()
  await page.keyboard.press('Enter')

  // The map closed and gave the note back.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator(MAP)).toHaveCount(0)
  await expect(editor).toBeVisible()

  // Landed on the heading (a block id is on more than one node of the block, so the first), and
  // scrolled there rather than sitting at the top.
  await expect.poll(() => inViewport(page.locator(`[data-id="${blockId}"]`).first())).toBe(true)
  expect(await inViewport(page.locator(`${NOTE_EDITOR} h1`).first())).toBe(false)
})

test('keeps undo history across a trip to the map and back', async ({ page }) => {
  await seedAndOpen(page)

  const editor = page.locator(NOTE_EDITOR).first()
  await editor.click()
  await page.keyboard.press('End')

  const typed = 'typed before looking at the map'
  await typeInEditor(page, typed)
  await expect(editor).toContainText(typed)

  // Look at the map and come back.
  const toggle = page.locator(TOGGLE)
  await toggle.click()
  await expect(page.locator(MAP)).toBeVisible()
  await toggle.click()
  await expect(page.locator(MAP)).toHaveCount(0)
  await expect(editor).toBeVisible()

  // Had the map unmounted the editor, its undo manager would have gone with it, and this would
  // undo nothing.
  await editor.click()
  await page.keyboard.press(SHORTCUTS.undo)

  await expect(editor).not.toContainText(typed)
  await expect(editor).toContainText('Overview')
})
