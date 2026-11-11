// The block drag handle's menu driven with real pointer clicks, ported from Electron's
// `editor-drag-handle-menu.e2e.ts` (Step 14k, #3531). Regression: autosave used to echo a
// notes:updated event back to the saving window and remount the editor, which destroyed any open
// BlockNote menu between pointerdown and pointerup, so colors and delete silently did nothing.
import { ensureDayPanelClosed } from '../../harness/app-helpers'
import {
  editorDocument,
  blockText,
  glide,
  noteBody,
  openNewNote,
  openNoteWithLines,
  typeInEditor
} from '../../harness/editor'
import { invokeTest } from '../../harness/invoke-test'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const MENU = '[role="menu"]'
const label = (name: string): string => `${name} ${Date.now().toString(36)}`
const menuItem = (page: Page, name: string): Locator => page.getByRole('menuitem', { name }).first()

/** Opens a new note and types `text` into its first block. */
async function noteWithLine(page: Page, title: string, text: string) {
  const note = await openNewNote(page, title)
  await page.locator(NOTE_EDITOR).first().click()
  await typeInEditor(page, text)
  return note
}

const firstBlock = async (page: Page) => (await editorDocument(page))[0]
const hasBlock = async (page: Page, id: string): Promise<boolean> =>
  (await editorDocument(page)).some((block) => block.id === id)

async function openDragHandleMenu(page: Page): Promise<void> {
  await page.locator('.bn-block-content').first().hover()
  const handle = page.locator('[data-test="dragHandle"]').first()
  await handle.waitFor({ state: 'visible', timeout: 5_000 })
  await handle.click()
  await page.locator(MENU).first().waitFor({ state: 'visible', timeout: 5_000 })
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${locator} is not rendered`)
  return box
}

test('applies block text color via real menu clicks while autosave echo lands', async ({
  page
}) => {
  await vaultOpen(page)
  // Typing arms the autosave debounce; its echo lands while the menu below is open.
  const note = await noteWithLine(page, label('Drag Menu Colors'), 'Color me via the drag handle')

  await openDragHandleMenu(page)
  // Past the autosave debounce with the menu open. Before the fix, the echo remounted the editor.
  await page.waitForTimeout(1_500)
  await expect(page.locator(MENU).first()).toBeVisible()

  await page.getByText('Colors', { exact: true }).first().click()
  const red = page.locator('[data-test="text-color-red"]').first()
  await red.waitFor({ state: 'visible', timeout: 5_000 })
  await red.click()

  await expect.poll(async () => (await firstBlock(page))?.props?.textColor).toBe('red')
  await expect(page.locator('.bn-block-content[data-text-color="red"]').first()).toBeVisible()

  // Autosave writes a color marker into the markdown file, and the color survives a reload.
  await expect.poll(() => noteBody(page, note.id)).toContain('<!-- colors:{"textColor":"red"} -->')
  await page.reload()
  await vaultOpen(page)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })
  await expect.poll(async () => (await firstBlock(page))?.props?.textColor).toBe('red')
  await expect(page.locator('.bn-block-content[data-text-color="red"]').first()).toBeVisible()
})

test('turns a paragraph into a heading via the menu', async ({ page }) => {
  await vaultOpen(page)
  await noteWithLine(page, label('Drag Menu Turn Into'), 'Promote me to a heading')

  await openDragHandleMenu(page)
  await menuItem(page, 'Turn into').click()
  await menuItem(page, 'Heading 1').click()

  await expect.poll(async () => (await firstBlock(page))?.type).toBe('heading')
})

// #3185: on a short window the tall Turn into submenu shifts up to fit, so reaching Heading 1 is a
// diagonal across open editor space. The submenu used to close 40 ms after the pointer stopped
// there, so a brief hesitation dropped the click onto the editor and nothing converted.
test('keeps the Turn into submenu open through a hesitation on the way to it', async ({
  app,
  page
}) => {
  await vaultOpen(page)
  // Shorter than Electron's 720: WebKit's submenu is shorter, and at 720 it fits with Heading 1
  // level with its trigger, so the path would not be the diagonal under test.
  await invokeTest(app, 'e2e_set_window_rect', {
    label: 'main',
    x: 0,
    y: 0,
    width: 1280,
    height: 600
  })
  await expect.poll(() => page.evaluate(() => window.innerHeight <= 600)).toBe(true)
  await ensureDayPanelClosed(page)
  // Returns once the body is on disk, so no save is still landing during the pause below.
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`)
  await openNoteWithLines(page, label('Drag Menu Hesitation'), lines)

  const target = page.locator('.bn-block-content').filter({ hasText: /^Line 20$/ })
  // BlockNote hides the side menu on any scroll of its ancestors, and a `scroll` event is
  // dispatched in the rendering update before that frame's animation callbacks. Resolving on the
  // next frame keeps this scroll's event from landing after the hover below.
  await target.evaluate(
    (el: HTMLElement) =>
      new Promise<void>((resolve) => {
        el.scrollIntoView({ block: 'center' })
        requestAnimationFrame(() => resolve())
      })
  )
  const line = await boxOf(target)
  await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2)
  // The side menu mounts at the editor's origin, here scrolled out of view above, and moves beside
  // the line a task later. A click in between scrolled the editor to the unplaced handle, the scroll
  // closed the menu, and with the pointer still the handle never came back (#4227, linux-x64 runs
  // 43006737328 and 43012776097). The click waits until the handle sits beside Line 20.
  const handle = page.locator('[data-test="dragHandle"]').first()
  await expect
    .poll(async () => {
      const box = await handle.boundingBox()
      const middle = box ? box.y + box.height / 2 : -1
      return middle >= line.y && middle <= line.y + line.height
    })
    .toBe(true)
  await handle.click()
  const turnInto = menuItem(page, 'Turn into')
  await turnInto.hover()
  const heading1 = menuItem(page, 'Heading 1')
  await expect(heading1).toBeVisible()

  const trigger = await boxOf(turnInto)
  const submenu = await boxOf(page.locator(MENU).filter({ hasText: 'Heading 1' }).last())
  const item = await boxOf(heading1)
  const from = { x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 }
  const to = { x: item.x + item.width / 2, y: item.y + item.height / 2 }
  // The submenu shifted up, above its trigger.
  expect(to.y).toBeLessThan(trigger.y)
  // Fractions of the straight path where it leaves Turn into's top edge and where it reaches the
  // submenu. The pause sits between them, over neither menu.
  const leavesTrigger = (from.y - trigger.y) / (from.y - to.y)
  const reachesSubmenu = (submenu.x - from.x) / (to.x - from.x)
  expect(leavesTrigger).toBeLessThan(reachesSubmenu)
  const pause = (leavesTrigger + reachesSubmenu) / 2

  await glide(page, { x: from.x + (to.x - from.x) * pause, y: from.y + (to.y - from.y) * pause }, 4)
  await page.waitForTimeout(100)
  await glide(page, to, 4)
  await expect(heading1).toBeVisible()
  await heading1.click()

  await expect
    .poll(async () => (await editorDocument(page)).find((b) => blockText(b) === 'Line 20')?.type)
    .toBe('heading')
})

// #4245: a menu whose block scrolled out of the note hides (`visibility: hidden`) and stays open.
// Enter must not run the row it had focused, Delete, with nothing on screen. WebKit and Chromium
// move focus off a hidden element, so the keys land on the body.
test('runs no menu row from the keyboard while its block is scrolled out of view', async ({
  page
}) => {
  await vaultOpen(page)
  const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`)
  await openNoteWithLines(page, label('Drag Menu Hidden Keys'), lines)

  await openDragHandleMenu(page)
  const focusedRow = (): Promise<string | undefined> =>
    page.evaluate(() => document.activeElement?.textContent?.trim())
  for (let rows = 0; rows < 10 && (await focusedRow()) !== 'Delete'; rows++) {
    await page.keyboard.press('ArrowDown')
  }
  expect(await focusedRow()).toBe('Delete')

  // Scroll the note's scroll container until Line 1, the menu's anchor, is out of view.
  await page
    .locator('.bn-block-content')
    .first()
    .evaluate((el: HTMLElement) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (
          node.scrollHeight > node.clientHeight &&
          getComputedStyle(node).overflowY !== 'visible'
        ) {
          node.scrollTop = node.scrollHeight
          return
        }
      }
      throw new Error('no scroll container')
    })
  await expect(page.locator(MENU).first()).toBeHidden()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  expect((await editorDocument(page)).map(blockText)).toContain('Line 1')
})

test('duplicates a block via the menu, directly below the original', async ({ page }) => {
  await vaultOpen(page)
  await noteWithLine(page, label('Drag Menu Duplicate'), 'Copy me')

  await openDragHandleMenu(page)
  await menuItem(page, 'Duplicate').click()

  await expect
    .poll(async () => (await editorDocument(page)).map(blockText).slice(0, 2))
    .toEqual(['Copy me', 'Copy me'])
})

// Skipped until #4181: `notes.appendBlocks` is not ported, so Move to only shows its error toast.
test.skip('moves a block into another note and removes it from the source', async ({ page }) => {
  await vaultOpen(page)
  const target = await noteWithLine(page, label('Move Target'), 'Target note body')
  // The target's own save lands before the move writes to it.
  await expect.poll(() => noteBody(page, target.id)).toContain('Target note body')

  await noteWithLine(page, label('Move Source'), 'Relocate this line')
  const moved = await firstBlock(page)

  await openDragHandleMenu(page)
  await menuItem(page, 'Move to').click()
  const search = page.locator('[data-test="move-block-search"]')
  await search.waitFor({ state: 'visible', timeout: 5_000 })
  await search.fill(target.title)
  await page.locator('[data-test="move-block-option"]').first().click()

  // The source loses the block only after the append resolved, and the target gains it.
  await expect.poll(() => hasBlock(page, moved.id)).toBe(false)
  await expect.poll(() => noteBody(page, target.id)).toContain('Relocate this line')
})

test('deletes a block via real menu clicks', async ({ page }) => {
  await vaultOpen(page)
  await noteWithLine(page, label('Drag Menu Delete'), 'Delete me via the drag handle')
  const deleted = await firstBlock(page)

  await openDragHandleMenu(page)
  await menuItem(page, 'Delete').click()

  await expect.poll(() => hasBlock(page, deleted.id)).toBe(false)
})
