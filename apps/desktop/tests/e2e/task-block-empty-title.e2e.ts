// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Empty Task Block Title E2E Tests
 *
 * Regression coverage for the bug where a draft task block (no DB row,
 * taskId='') became unclickable after the user blurred the title input.
 * The read-only span had no fallback content, so an empty title collapsed
 * to zero width and the user could no longer click back into edit mode.
 *
 * Draft task blocks are produced by the Enter-chain in
 * task-block-renderer.tsx:345-349 — when the user presses Enter on a filled
 * task block, the renderer inserts a fresh `{ taskId: '', title: '' }`
 * draft after it. The draft has no DB row (saveTitleToDb early-returns for
 * empty titles, and tasksService.update is skipped when taskId is empty),
 * so we can seed it directly via __memryEditor.replaceBlocks without
 * touching the tasks IPC at all (which would reject empty titles via the
 * z.string().min(1) contract anyway).
 *
 * These tests cover the full CRUD loop for a draft taskBlock:
 *   - create  (seeded directly via __memryEditor.replaceBlocks)
 *   - read    (placeholder span is visible with non-zero width after blur)
 *   - update  (click placeholder → input opens → type → Enter saves prop)
 *   - delete  (Backspace in empty input still tears the block down)
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, createNote } from './utils/electron-helpers'
import type { Page } from '@playwright/test'

const EDITOR_SELECTOR = '[aria-label="Rich text editor"] [contenteditable="true"]'
const TASK_BLOCK_SELECTOR = '[data-content-type="taskBlock"]'

async function focusEditor(page: Page) {
  const editor = page.locator(EDITOR_SELECTOR).first()
  await editor.waitFor({ state: 'visible', timeout: 8000 })
  await editor.click()
  return editor
}

// Replace the document with a single draft task block (taskId='', title='')
// followed by a paragraph the test can click on to force a blur on the
// title input. This is exactly the state the renderer enters at
// task-block-renderer.tsx:345-349 after Enter on a filled task block.
async function seedDraftTaskBlock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, [
      {
        type: 'taskBlock',
        props: { taskId: '', title: '', checked: false, parentTaskId: '' }
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'click-away anchor', styles: {} }]
      }
    ])
  })
}

// Read the current title prop on the (only) task block in the editor doc.
async function readFirstTaskBlockTitle(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) return null
    const doc = editor.document as any[]
    const block = doc.find((b: any) => b.type === 'taskBlock')
    return block ? (block.props?.title ?? null) : null
  })
}

async function countTaskBlocksInDoc(page: Page): Promise<number> {
  return (await page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) return 0
    return (editor.document as any[]).filter((b: any) => b.type === 'taskBlock').length
  })) as number
}

test.describe('Task block — empty title CRUD', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('clicking an empty draft task block re-enters edit mode and saves the typed title', async ({
    page
  }) => {
    // #given — note containing one draft task block + a paragraph anchor
    await createNote(page, `Empty Title Test ${Date.now()}`)
    await focusEditor(page)
    await seedDraftTaskBlock(page)

    const taskBlock = page.locator(TASK_BLOCK_SELECTOR).first()
    await taskBlock.waitFor({ state: 'visible', timeout: 5000 })

    // Allow the rAF auto-focus effect at task-block-renderer.tsx:112-130
    // to mount the title input and focus it.
    await page.waitForTimeout(400)

    // #when — click the paragraph anchor to blur the title input. This is
    // the exact action that used to leave the block stranded in read-only.
    await page.locator(EDITOR_SELECTOR).first().getByText('click-away anchor').click()
    await page.waitForTimeout(250)

    // #then — placeholder span is visible (regression check: pre-fix this
    // span rendered empty content, collapsing to zero width — there was
    // nothing for the user to click).
    const placeholder = taskBlock.locator('[role="button"][tabindex="0"]')
    await expect(placeholder).toBeVisible()
    await expect(placeholder).toHaveText(/Task name/)
    const box = await placeholder.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(10)

    // #when — click the placeholder to re-enter edit mode, type, Enter
    await placeholder.click()
    const titleInput = taskBlock.locator('input[type="text"]')
    await expect(titleInput).toBeVisible({ timeout: 2000 })
    await expect(titleInput).toBeFocused()
    await titleInput.fill('Buy milk')
    await titleInput.press('Enter')

    // #then — Enter on a non-empty title flushes saveTitleToDb (which
    // updates block.props.title for drafts) and inserts a fresh draft
    // sibling. The first task block now carries the typed title; we read
    // it through editor.document so this assertion is independent of the
    // DB layer (drafts have no DB row).
    await page.waitForTimeout(400)
    const savedTitle = await readFirstTaskBlockTitle(page)
    expect(savedTitle).toBe('Buy milk')
  })

  test('backspace in empty draft input deletes the block (delete path sanity)', async ({
    page
  }) => {
    // Guards the pre-existing backspace-deletes-empty-block branch at
    // task-block-renderer.tsx:293-332 from regressing while we touch the
    // surrounding render code.
    await createNote(page, `Empty Title Delete ${Date.now()}`)
    await focusEditor(page)
    await seedDraftTaskBlock(page)

    const taskBlock = page.locator(TASK_BLOCK_SELECTOR).first()
    await taskBlock.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(400)

    // The renderer auto-focuses the input on mount via the rAF effect at
    // line 112. Backspace on an empty input triggers the teardown branch.
    const titleInput = taskBlock.locator('input[type="text"]')
    await expect(titleInput).toBeVisible({ timeout: 2000 })
    await titleInput.focus()
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(500)

    // #then — the task block is gone from the editor doc. There is no DB
    // row to check (drafts never get one — saveTitleToDb early-returns on
    // empty titles, and tasksService.delete in the teardown branch is
    // guarded by `if (taskId)`).
    expect(await countTaskBlocksInDoc(page)).toBe(0)
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(0)
  })
})
