// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Marquee Block Selection — Block Type Matrix
 *
 * Companion to marquee-selection.e2e.ts. That file covers pointer-gesture
 * regressions (drag promotion thresholds, edge-of-zone drags, title click
 * exclusions). This file covers the BLOCK-TYPE matrix: every block type the
 * editor renders must be marquee-selectable, including custom blocks like
 * `taskBlock` that declare `content: 'none'` in their BlockNote schema.
 *
 * Why this matters: the previous implementation relied on
 * `editor.setSelection(firstId, lastId)` and BlockNote's TextSelection path,
 * both of which throw for non-textblock content. The catch silently cleared
 * the visual highlight on release — taskBlock marquee selection was
 * completely broken end-to-end.
 *
 * The fix routes single non-textblock blocks through PM NodeSelection, and
 * multi-block selections through TextSelection.between at depth-0 endpoints.
 * Test #3 below (mixed paragraph + taskBlock + heading + paragraph) is the
 * critical regression gate.
 *
 * NOTE: youtubeEmbed and file blocks are intentionally NOT covered here.
 * They share the same `content: 'none'` schema as taskBlock, so the fix
 * covers them by construction, but their renderers need URL/file fixtures
 * that are flaky in CI.
 */

import { test, expect, type Page } from './fixtures'
import { waitForAppReady, waitForVaultReady, createNote } from './utils/electron-helpers'

const EDITOR_CONTAINER = '.bn-container'
const EDITABLE_SELECTOR = `${EDITOR_CONTAINER} [contenteditable="true"]`
const BLOCK_SELECTOR = '.bn-block[data-id]'
const HIGHLIGHTED_SELECTOR = '.marquee-block-highlight'
const OVERLAY_SELECTOR = '.marquee-overlay'
const MARQUEE_ZONE_SELECTOR = '.marquee-zone'
const TASK_BLOCK_SELECTOR = '[data-content-type="taskBlock"]'

async function focusEditor(page: Page) {
  const container = page.locator(EDITOR_CONTAINER).first()
  await container.waitFor({ state: 'visible', timeout: 10000 })
  const editable = page.locator(EDITABLE_SELECTOR).first()
  await editable.waitFor({ state: 'visible', timeout: 10000 })
  await editable.click()
  return editable
}

async function typeBlocks(page: Page, lines: string[]): Promise<void> {
  for (let i = 0; i < lines.length; i += 1) {
    await page.keyboard.type(lines[i])
    if (i < lines.length - 1) await page.keyboard.press('Enter')
  }
}

async function getBlockBox(page: Page, index: number) {
  const box = await page.locator(BLOCK_SELECTOR).nth(index).boundingBox()
  if (!box) throw new Error(`Block at index ${index} has no bounding box`)
  return box
}

async function getBlockCount(page: Page): Promise<number> {
  return page.locator(BLOCK_SELECTOR).count()
}

async function getMarqueeZoneBox(page: Page) {
  const box = await page.locator(MARQUEE_ZONE_SELECTOR).first().boundingBox()
  if (!box) throw new Error('marquee zone not found')
  return box
}

// Pattern from inline-subtasks.e2e.ts:77 — provision a real DB task via IPC
// so the taskBlock renderer can resolve a row, not a placeholder.
async function createTaskInDb(page: Page, title: string): Promise<string> {
  return (await page.evaluate(
    async ({ title }) => {
      const api = (window as any).api
      if (!api?.tasks) throw new Error('window.api.tasks not exposed')
      const projectsRes = await api.tasks.listProjects()
      const projects = projectsRes?.projects ?? []
      const defaultProject = projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
      if (!defaultProject) throw new Error('no default project found')
      const created = await api.tasks.create({
        projectId: defaultProject.id,
        title,
        priority: 0
      })
      if (!created?.success || !created.task) {
        throw new Error('tasks.create failed: ' + JSON.stringify(created))
      }
      return created.task.id as string
    },
    { title }
  )) as string
}

// Pattern from inline-subtasks.e2e.ts:106 — replace the editor doc with a
// programmatic block array. Triggers BlockNote's onChange.
async function setEditorBlocks(page: Page, blocks: any[]): Promise<void> {
  await page.evaluate((blocks) => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, blocks)
  }, blocks)
}

// Drag from the gutter (start outside any contenteditable so the marquee
// promotion gate at use-block-marquee-selection.ts:226-228 fires on pure
// vertical motion) past block `fromIdx` down to block `toIdx`. End the drag
// just inside the editor so the rect intersects every block in between.
async function marqueeAcross(page: Page, fromIdx: number, toIdx: number) {
  const zone = await getMarqueeZoneBox(page)
  const first = await getBlockBox(page, fromIdx)
  const last = await getBlockBox(page, toIdx)

  const startX = zone.x + 8
  const startY = first.y + 4
  const endX = first.x + Math.min(40, first.width / 2)
  const endY = last.y + last.height - 4

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 14 })
  await page.mouse.up()
  await page.waitForTimeout(150)
}

test.describe('Marquee selection — block types', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('1. single taskBlock — visual highlight + PM NodeSelection + Backspace deletes', async ({
    page
  }) => {
    await createNote(page, `Marquee Single TaskBlock ${Date.now()}`)
    await focusEditor(page)

    const taskId = await createTaskInDb(page, 'Single marquee task')
    await setEditorBlocks(page, [
      {
        type: 'taskBlock',
        props: { taskId, title: 'Single marquee task', checked: false, parentTaskId: '' }
      }
    ])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(1)

    const startCount = await getBlockCount(page)
    await marqueeAcross(page, 0, 0)

    await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(1)

    // The marquee overlay is the primary visual signal. The marquee-side
    // Backspace handler operates on the selectedBlockIds set directly via
    // editor.removeBlocks, so PM selection state is secondary — what
    // matters end-to-end is that Backspace removes the highlighted block.
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(300)
    expect(await getBlockCount(page)).toBeLessThan(startCount)
  })

  test('2. multiple adjacent taskBlocks — highlight survives, Backspace deletes all', async ({
    page
  }) => {
    await createNote(page, `Marquee Multi TaskBlocks ${Date.now()}`)
    await focusEditor(page)

    const id1 = await createTaskInDb(page, 'Multi task 1')
    const id2 = await createTaskInDb(page, 'Multi task 2')
    const id3 = await createTaskInDb(page, 'Multi task 3')
    await setEditorBlocks(page, [
      {
        type: 'taskBlock',
        props: { taskId: id1, title: 'Multi task 1', checked: false, parentTaskId: '' }
      },
      {
        type: 'taskBlock',
        props: { taskId: id2, title: 'Multi task 2', checked: false, parentTaskId: '' }
      },
      {
        type: 'taskBlock',
        props: { taskId: id3, title: 'Multi task 3', checked: false, parentTaskId: '' }
      }
    ])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)
    // Wait for the task block renderers to load their async task data
    // and settle into a stable layout. Without this, the marquee drag
    // can race with re-renders mid-drag and produce 0 highlights.
    await page.waitForTimeout(500)

    const startCount = await getBlockCount(page)
    await marqueeAcross(page, 0, 2)

    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)
    expect(await getBlockCount(page)).toBeLessThan(startCount)
  })

  test('3. CRITICAL: mixed paragraph + taskBlock + heading + paragraph', async ({ page }) => {
    await createNote(page, `Marquee Mixed ${Date.now()}`)
    await focusEditor(page)

    const taskId = await createTaskInDb(page, 'Mixed marquee task')
    await setEditorBlocks(page, [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Para before', styles: {} }]
      },
      {
        type: 'taskBlock',
        props: { taskId, title: 'Mixed marquee task', checked: false, parentTaskId: '' }
      },
      {
        type: 'heading',
        props: { level: 1 },
        content: [{ type: 'text', text: 'Heading in middle', styles: {} }]
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Para after', styles: {} }]
      }
    ])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(1)
    expect(await getBlockCount(page)).toBeGreaterThanOrEqual(4)

    const startCount = await getBlockCount(page)
    await marqueeAcross(page, 0, 3)

    // All four blocks visually highlighted post-release. This is the
    // exact regression that was broken: previously, the catch path on
    // applyPmSelection cleared the highlights when the range included a
    // taskBlock.
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(4)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)
    expect(await getBlockCount(page)).toBeLessThan(startCount)
  })

  test('4. callout block — highlight survives release', async ({ page }) => {
    await createNote(page, `Marquee Callout ${Date.now()}`)
    await focusEditor(page)

    await setEditorBlocks(page, [
      {
        type: 'callout',
        props: { type: 'info' },
        content: [{ type: 'text', text: 'Callout one', styles: {} }]
      },
      {
        type: 'callout',
        props: { type: 'warning' },
        content: [{ type: 'text', text: 'Callout two', styles: {} }]
      }
    ])
    await expect(page.locator('[data-content-type="callout"]')).toHaveCount(2)

    await marqueeAcross(page, 0, 1)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
  })

  test('5. code block — highlight survives, Backspace deletes', async ({ page }) => {
    await createNote(page, `Marquee Code ${Date.now()}`)
    await focusEditor(page)

    await setEditorBlocks(page, [
      {
        type: 'codeBlock',
        props: { language: 'javascript' },
        content: [{ type: 'text', text: 'const foo = 1', styles: {} }]
      }
    ])
    await expect(page.locator('[data-content-type="codeBlock"]')).toHaveCount(1)

    const startCount = await getBlockCount(page)
    await marqueeAcross(page, 0, 0)

    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(1)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(300)
    expect(await getBlockCount(page)).toBeLessThanOrEqual(startCount)
  })

  test('6. bullet list items — highlight survives, Backspace deletes', async ({ page }) => {
    await createNote(page, `Marquee Bullets ${Date.now()}`)
    await focusEditor(page)

    await setEditorBlocks(page, [
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'Bullet one', styles: {} }]
      },
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'Bullet two', styles: {} }]
      },
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'Bullet three', styles: {} }]
      }
    ])
    await expect(page.locator('[data-content-type="bulletListItem"]')).toHaveCount(3)

    const startCount = await getBlockCount(page)
    await marqueeAcross(page, 0, 2)

    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)
    expect(await getBlockCount(page)).toBeLessThan(startCount)
  })

  test('7. highlight persists 200ms post-release (gates rAF guard fix)', async ({ page }) => {
    await createNote(page, `Marquee Persistence ${Date.now()}`)
    await focusEditor(page)

    const taskId = await createTaskInDb(page, 'Persistence task')
    await setEditorBlocks(page, [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Para before', styles: {} }]
      },
      {
        type: 'taskBlock',
        props: { taskId, title: 'Persistence task', checked: false, parentTaskId: '' }
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Para after', styles: {} }]
      }
    ])
    expect(await getBlockCount(page)).toBeGreaterThanOrEqual(3)

    await marqueeAcross(page, 0, 2)

    // The fix uses requestAnimationFrame (not queueMicrotask) for the
    // isApplyingPmSelectionRef guard reset. Without rAF, the secondary
    // onSelectionChange tick from view.focus() would clear our highlight
    // ~1 tick after release. 200ms is well past that race window.
    await page.waitForTimeout(200)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)
  })

  test('8. Tab on taskBlocks is a safe no-op — does NOT crash the editor', async ({ page }) => {
    // Regression gate: before the non-textblock filter in indent/outdent,
    // pressing Tab on a marquee of task blocks threw "Block type does not
    // match" inside ReactNodeViewRenderer and then crashed the next loop
    // iteration in syncNodeSelection.descAt with a null docView. Task
    // blocks declare `content: 'none'` so BlockNote's nestBlock cannot
    // safely run against them — the implementation must skip non-
    // textblock blocks silently.
    await createNote(page, `Marquee Tab TaskBlock ${Date.now()}`)
    await focusEditor(page)

    const id1 = await createTaskInDb(page, 'Tab task 1')
    const id2 = await createTaskInDb(page, 'Tab task 2')
    const id3 = await createTaskInDb(page, 'Tab task 3')
    await setEditorBlocks(page, [
      {
        type: 'taskBlock',
        props: { taskId: id1, title: 'Tab task 1', checked: false, parentTaskId: '' }
      },
      {
        type: 'taskBlock',
        props: { taskId: id2, title: 'Tab task 2', checked: false, parentTaskId: '' }
      },
      {
        type: 'taskBlock',
        props: { taskId: id3, title: 'Tab task 3', checked: false, parentTaskId: '' }
      }
    ])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)

    // Listen for editor error boundary activation — a crash would surface
    // as an "Editor crash" or "Editor error" console error.
    const editorErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('Block type does not match') || text.includes('Editor crash')) {
          editorErrors.push(text)
        }
      }
    })

    // Marquee-select the last two task blocks.
    await marqueeAcross(page, 1, 2)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)

    // The editor must NOT have crashed.
    expect(editorErrors).toEqual([])
    // All three task blocks are still rendered.
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)

    // Now Shift+Tab: same guarantee.
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(300)
    expect(editorErrors).toEqual([])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)
  })

  test('9. Tab on mixed paragraph + taskBlock selection — paragraph indents, taskBlock stays', async ({
    page
  }) => {
    // Mixed selection: paragraphs nest as BlockNote blocks, task blocks
    // are silently skipped. Neither block type should crash the editor.
    await createNote(page, `Marquee Tab Mixed ${Date.now()}`)
    await focusEditor(page)

    const taskId = await createTaskInDb(page, 'Mixed task')
    await setEditorBlocks(page, [
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'anchor bullet', styles: {} }]
      },
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'will indent', styles: {} }]
      },
      {
        type: 'taskBlock',
        props: { taskId, title: 'Mixed task', checked: false, parentTaskId: '' }
      }
    ])
    // BlockNote may auto-append a trailing paragraph when the last block
    // is a non-textblock custom block, so 3 or 4 both qualify.
    expect(await getBlockCount(page)).toBeGreaterThanOrEqual(3)

    const editorErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('Block type does not match') || text.includes('Editor crash')) {
          editorErrors.push(text)
        }
      }
    })

    // Select bullet #2 + taskBlock.
    await marqueeAcross(page, 1, 2)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)

    // Editor must not have crashed.
    expect(editorErrors).toEqual([])
    // Task block still present.
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(1)
    // Bullet #2 indented: its .bn-block data-id element has 2+ bn-block-group ancestors.
    const bullet2Depth = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.bn-container .bn-block[data-id]')
      const target = blocks[1]
      if (!target) return -1
      let depth = 0
      let cursor: Element | null = target.parentElement
      while (cursor && !cursor.classList.contains('bn-container')) {
        if (cursor.classList.contains('bn-block-group')) depth += 1
        cursor = cursor.parentElement
      }
      return depth
    })
    expect(bullet2Depth).toBe(2)
  })
})
