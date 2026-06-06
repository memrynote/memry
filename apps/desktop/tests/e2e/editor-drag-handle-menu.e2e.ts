import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote, SELECTORS } from './utils/electron-helpers'

/**
 * Regression: autosave used to echo a notes:updated event back to the saving
 * window, force-remounting the editor (key bump in note.tsx) and destroying
 * any open BlockNote menu between pointerdown and pointerup — drag-handle
 * colors/delete and toolbar menus silently did nothing. These tests drive the
 * menu with real pointer clicks while the autosave echo lands.
 */

async function focusEditor(page: Page) {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()
  return editor
}

async function firstBlock(page: Page) {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const block = editor.document[0]
    return { id: block?.id as string | undefined, props: (block?.props ?? {}) as any }
  })
}

async function openDragHandleMenu(page: Page): Promise<void> {
  await page.locator('.bn-block-content').first().hover()
  const handle = page.locator('[data-test="dragHandle"]').first()
  await handle.waitFor({ state: 'visible', timeout: 5_000 })
  await handle.click()
  await page.locator('[role="menu"]').first().waitFor({ state: 'visible', timeout: 5_000 })
}

test.describe('Drag handle menu E2E', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('applies block text color via real menu clicks while autosave echo lands', async ({
    page
  }) => {
    const title = uniqueLabel('Drag Menu Colors')
    await createNote(page, title)
    await focusEditor(page)
    // Typing arms the 1s autosave debounce — its notes:updated echo lands
    // while the menu is open below, which used to remount the editor.
    await page.keyboard.type('Color me via the drag handle')

    await openDragHandleMenu(page)
    // Sit past the autosave debounce with the menu open. Pre-fix, the echo
    // remounted the editor here and the menu was destroyed.
    await page.waitForTimeout(1_500)
    await expect(page.locator('[role="menu"]').first()).toBeVisible()

    await page.getByText('Colors', { exact: true }).first().click()
    const redItem = page.locator('[data-test="text-color-red"]').first()
    await redItem.waitFor({ state: 'visible', timeout: 5_000 })
    await redItem.click()

    await expect.poll(async () => (await firstBlock(page)).props.textColor).toBe('red')
    await expect(page.locator('.bn-block-content[data-text-color="red"]').first()).toBeVisible()

    // Persistence: autosave writes a color marker into the markdown file…
    await expect
      .poll(
        () =>
          page.evaluate(async (noteTitle) => {
            const list = await (window as any).api.notes.list({})
            const note = list.notes.find((n: { title: string }) => n.title === noteTitle)
            if (!note) return null
            const full = await (window as any).api.notes.get(note.id)
            return full?.content ?? null
          }, title),
        { timeout: 10_000 }
      )
      .toContain('<!-- colors:{"textColor":"red"} -->')

    // …and the color survives a full reload (markdown re-parse from disk).
    await page.reload()
    await ready(page)
    await focusEditor(page)
    await expect.poll(async () => (await firstBlock(page)).props.textColor).toBe('red')
    await expect(page.locator('.bn-block-content[data-text-color="red"]').first()).toBeVisible()
  })

  test('deletes a block via real menu clicks', async ({ page }) => {
    await createNote(page, uniqueLabel('Drag Menu Delete'))
    await focusEditor(page)
    await page.keyboard.type('Delete me via the drag handle')
    const { id: targetId } = await firstBlock(page)

    await openDragHandleMenu(page)
    await page.getByRole('menuitem', { name: 'Delete' }).first().click()

    await expect
      .poll(async () =>
        page.evaluate((blockId) => {
          const editor = (window as any).__memryEditor
          if (!editor) throw new Error('window.__memryEditor not exposed')
          return editor.document.some((block: any) => block.id === blockId)
        }, targetId)
      )
      .toBe(false)
  })
})
