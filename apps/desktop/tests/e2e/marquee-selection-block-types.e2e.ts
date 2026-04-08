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

// Read `parentId` from the DB via the tasks IPC. Verifies the indent/outdent
// operation persisted through `tasksService.update` — in-memory prop change
// alone is not enough, the round-trip through IPC is the whole point.
//
// `tasks:get` returns the task object directly (with `parentId` on it), not
// wrapped in `{ task }`. See tasks-handlers.ts:157-178.
async function getTaskParentIdInDb(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const api = (window as any).api
    if (!api?.tasks?.get) throw new Error('window.api.tasks.get not exposed')
    const res = await api.tasks.get(id)
    return res?.parentId ?? null
  }, taskId)
}

// Walk the BlockNote document (including children[]) to find the taskBlock
// whose props.taskId matches `blockTaskId`, and return its `parentTaskId` prop.
// Returns '' if not found OR if found with no parent — both mean "top-level"
// and test assertions compare against the taskId string value directly.
async function getBlockParentTaskIdProp(page: Page, blockTaskId: string): Promise<string> {
  return page.evaluate((tid) => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const walk = (blocks: any[]): string | null => {
      for (const b of blocks) {
        if (b?.type === 'taskBlock' && b?.props?.taskId === tid) {
          return b.props.parentTaskId ?? ''
        }
        if (Array.isArray(b?.children) && b.children.length > 0) {
          const nested = walk(b.children)
          if (nested !== null) return nested
        }
      }
      return null
    }
    return walk(editor.document) ?? ''
  }, blockTaskId)
}

// Count how many `api.tasks.update` calls happen during the body callback.
// Used to verify "Tab on already-nested subtask" does NOT fire a spurious
// DB write.
async function withTasksUpdateSpy<T>(
  page: Page,
  body: () => Promise<T>
): Promise<{ result: T; updateCalls: number }> {
  await page.evaluate(() => {
    const api = (window as any).api
    if (!api?.tasks?.update) throw new Error('api.tasks.update not exposed')
    ;(window as any).__spyOriginalTasksUpdate = api.tasks.update.bind(api.tasks)
    ;(window as any).__spyTasksUpdateCalls = 0
    api.tasks.update = (...args: unknown[]) => {
      ;(window as any).__spyTasksUpdateCalls += 1
      return (window as any).__spyOriginalTasksUpdate(...args)
    }
  })
  try {
    const result = await body()
    const updateCalls = await page.evaluate(
      () => ((window as any).__spyTasksUpdateCalls as number) ?? 0
    )
    return { result, updateCalls }
  } finally {
    await page.evaluate(() => {
      const api = (window as any).api
      const original = (window as any).__spyOriginalTasksUpdate
      if (original) api.tasks.update = original
      delete (window as any).__spyOriginalTasksUpdate
      delete (window as any).__spyTasksUpdateCalls
    })
  }
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

  test('8. Tab on marquee-selected taskBlocks indents them under the previous task', async ({
    page
  }) => {
    // Flipped semantics: previously this test asserted Tab was a safe no-op
    // because BlockNote's nestBlock crashes on non-textblocks. The marquee
    // hook now routes task blocks through their own hierarchy mechanism
    // (parentTaskId prop + tasks.update IPC), mirroring the single-task Tab
    // handler in task-block-renderer.tsx. The no-crash guarantee still
    // holds and is re-asserted via the console error listener.
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
    await page.waitForTimeout(500)

    const editorErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('Block type does not match') || text.includes('Editor crash')) {
          editorErrors.push(text)
        }
      }
    })

    // Marquee-select the last two task blocks — leave task #1 as the
    // intended parent.
    await marqueeAcross(page, 1, 2)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    await page.keyboard.press('Tab')
    await page.waitForTimeout(500)

    expect(editorErrors).toEqual([])
    // Both tasks are now children of task #1 rendered inside its tree — the
    // taskBlock selector still matches all three (BlockNote renders nested
    // children recursively).
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)

    // In-memory block tree — flat siblings under common predecessor.
    expect(await getBlockParentTaskIdProp(page, id2)).toBe(id1)
    expect(await getBlockParentTaskIdProp(page, id3)).toBe(id1)

    // DB round-trip through tasks.update IPC.
    expect(await getTaskParentIdInDb(page, id2)).toBe(id1)
    expect(await getTaskParentIdInDb(page, id3)).toBe(id1)

    // Marquee highlight should still be visible post-indent — the hook
    // recomputes highlight rects after replaceBlocks so the selection
    // follows the moved blocks.
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    // Shift+Tab lifts both subtasks back to top level.
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(500)
    expect(editorErrors).toEqual([])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)
    expect(await getBlockParentTaskIdProp(page, id2)).toBe('')
    expect(await getBlockParentTaskIdProp(page, id3)).toBe('')
    expect(await getTaskParentIdInDb(page, id2)).toBeNull()
    expect(await getTaskParentIdInDb(page, id3)).toBeNull()
  })

  test('9. Tab on mixed taskBlock + bullet marquee — both indent via their own paths', async ({
    page
  }) => {
    // Two independent pairs so each path gets a same-type previous sibling
    // to nest under — avoid placing bullets directly after a taskBlock,
    // since BlockNote's nestBlock would then nest the bullet INTO the task
    // (the PM sinkListItem doesn't care about prev sibling type). Layout:
    //   [anchorBullet, willIndentBullet, anchorTask, willIndentTask]
    // Marquee indices 1-3 selects willIndentBullet + anchorTask + willIndentTask.
    //   - willIndentBullet: prev is anchorBullet → textblock path nests it ✓
    //   - anchorTask: prev is anchorBullet (non-task) → task path skips it ✓
    //   - willIndentTask: prev is anchorTask → task path nests it ✓
    await createNote(page, `Marquee Tab Mixed ${Date.now()}`)
    await focusEditor(page)

    const anchorTaskId = await createTaskInDb(page, 'Anchor task')
    const willIndentTaskId = await createTaskInDb(page, 'Will indent task')
    await setEditorBlocks(page, [
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'anchor bullet', styles: {} }]
      },
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'will indent bullet', styles: {} }]
      },
      {
        type: 'taskBlock',
        props: { taskId: anchorTaskId, title: 'Anchor task', checked: false, parentTaskId: '' }
      },
      {
        type: 'taskBlock',
        props: {
          taskId: willIndentTaskId,
          title: 'Will indent task',
          checked: false,
          parentTaskId: ''
        }
      }
    ])
    expect(await getBlockCount(page)).toBeGreaterThanOrEqual(4)
    await page.waitForTimeout(500)

    const editorErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('Block type does not match') || text.includes('Editor crash')) {
          editorErrors.push(text)
        }
      }
    })

    await marqueeAcross(page, 1, 3)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(3)

    await page.keyboard.press('Tab')
    await page.waitForTimeout(500)

    expect(editorErrors).toEqual([])

    // Task path: willIndentTask is now a subtask of anchorTask.
    expect(await getBlockParentTaskIdProp(page, willIndentTaskId)).toBe(anchorTaskId)
    expect(await getTaskParentIdInDb(page, willIndentTaskId)).toBe(anchorTaskId)

    // Textblock path: willIndentBullet is now nested under anchorBullet.
    // Its DOM node should have 2+ bn-block-group ancestors up to the
    // container. Look up the block via the inner `[data-content-type]`
    // marker (which IS on the bullet) and walk up to its enclosing
    // `.bn-block[data-id]` container. querySelectorAll on the
    // data-content-type returns ALL bullets flat in DOM order, so we
    // use the second one — that's willIndentBullet after nesting.
    const willIndentBulletDepth = await page.evaluate(() => {
      const bullets = Array.from(
        document.querySelectorAll('.bn-container [data-content-type="bulletListItem"]')
      ) as HTMLElement[]
      if (bullets.length < 2) return -1
      // bullets[0] is anchor, bullets[1] is willIndentBullet (the order
      // in DOM flatten is parent-first even when nested).
      const inner = bullets[1]
      const target = inner.closest('.bn-block[data-id]') as HTMLElement | null
      if (!target) return -1
      let depth = 0
      let cursor: Element | null = target.parentElement
      while (cursor && !cursor.classList.contains('bn-container')) {
        if (cursor.classList.contains('bn-block-group')) depth += 1
        cursor = cursor.parentElement
      }
      return depth
    })
    expect(willIndentBulletDepth).toBeGreaterThanOrEqual(2)
  })

  test('10. Shift+Tab on marquee-selected subtasks lifts them back to top level', async ({
    page
  }) => {
    // Pre-seed: two taskBlocks nested under a parent via the doc tree,
    // with empty parentTaskId props. ContentArea.onChange detects the
    // mismatch and fires `demotedTaskBlocks` — wiring up both the block
    // props AND the DB parentId via tasksService.update. This is the
    // canonical pre-seed pattern from inline-subtasks.e2e.ts:138-168.
    await createNote(page, `Marquee Outdent Subtasks ${Date.now()}`)
    await focusEditor(page)

    const parentId = await createTaskInDb(page, 'Parent task')
    const child1Id = await createTaskInDb(page, 'Child task 1')
    const child2Id = await createTaskInDb(page, 'Child task 2')

    await setEditorBlocks(page, [
      {
        type: 'taskBlock',
        props: { taskId: parentId, title: 'Parent task', checked: false, parentTaskId: '' },
        children: [
          {
            type: 'taskBlock',
            props: {
              taskId: child1Id,
              title: 'Child task 1',
              checked: false,
              parentTaskId: ''
            }
          },
          {
            type: 'taskBlock',
            props: {
              taskId: child2Id,
              title: 'Child task 2',
              checked: false,
              parentTaskId: ''
            }
          }
        ]
      }
    ])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)
    await page.waitForTimeout(800)

    // Verify ContentArea wired up parentId in both the doc and the DB.
    expect(await getBlockParentTaskIdProp(page, child1Id)).toBe(parentId)
    expect(await getBlockParentTaskIdProp(page, child2Id)).toBe(parentId)
    expect(await getTaskParentIdInDb(page, child1Id)).toBe(parentId)
    expect(await getTaskParentIdInDb(page, child2Id)).toBe(parentId)

    const editorErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('Block type does not match') || text.includes('Editor crash')) {
          editorErrors.push(text)
        }
      }
    })

    // Marquee both children (they render at DOM indices 1 and 2 under the
    // parent tree).
    await marqueeAcross(page, 1, 2)
    expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(500)

    expect(editorErrors).toEqual([])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(3)

    expect(await getBlockParentTaskIdProp(page, child1Id)).toBe('')
    expect(await getBlockParentTaskIdProp(page, child2Id)).toBe('')
    expect(await getTaskParentIdInDb(page, child1Id)).toBeNull()
    expect(await getTaskParentIdInDb(page, child2Id)).toBeNull()
  })

  test('11. Tab on already-nested subtask is a no-op with no duplicate DB writes', async ({
    page
  }) => {
    // The single-task Tab handler early-returns when a task is already
    // nested (current system is 2-level). Marquee Tab must behave the
    // same way and — critically — must NOT fire a spurious tasks.update
    // IPC call for already-nested blocks.
    //
    // Pre-seed uses the canonical pattern from inline-subtasks.e2e.ts: set
    // child nested with empty parentTaskId and let ContentArea's onChange
    // analyzer wire up the block prop + DB via demotedTaskBlocks intent.
    await createNote(page, `Marquee Tab AlreadyNested ${Date.now()}`)
    await focusEditor(page)

    const parentId = await createTaskInDb(page, 'P')
    const childId = await createTaskInDb(page, 'C')

    await setEditorBlocks(page, [
      {
        type: 'taskBlock',
        props: { taskId: parentId, title: 'P', checked: false, parentTaskId: '' },
        children: [
          {
            type: 'taskBlock',
            props: { taskId: childId, title: 'C', checked: false, parentTaskId: '' }
          }
        ]
      }
    ])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(2)
    await page.waitForTimeout(800)

    // Sanity: ContentArea wired up the hierarchy before we start measuring.
    expect(await getBlockParentTaskIdProp(page, childId)).toBe(parentId)
    expect(await getTaskParentIdInDb(page, childId)).toBe(parentId)

    const editorErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('Block type does not match') || text.includes('Editor crash')) {
          editorErrors.push(text)
        }
      }
    })

    const { updateCalls } = await withTasksUpdateSpy(page, async () => {
      // Marquee only the child subtask (DOM index 1).
      await marqueeAcross(page, 1, 1)
      expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(1)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(400)
      return null
    })

    expect(editorErrors).toEqual([])
    expect(updateCalls).toBe(0)
    expect(await getBlockParentTaskIdProp(page, childId)).toBe(parentId)
    expect(await getTaskParentIdInDb(page, childId)).toBe(parentId)
  })

  test('12. Tab on a single top-level task with no previous task sibling is a no-op', async ({
    page
  }) => {
    // First block in the document has nothing to nest under. The helper
    // returns skipped:no-prev-task-sibling; no crash, no DB write.
    await createNote(page, `Marquee Tab FirstTask ${Date.now()}`)
    await focusEditor(page)

    const onlyId = await createTaskInDb(page, 'Only task')
    await setEditorBlocks(page, [
      {
        type: 'taskBlock',
        props: { taskId: onlyId, title: 'Only task', checked: false, parentTaskId: '' }
      }
    ])
    await expect(page.locator(TASK_BLOCK_SELECTOR)).toHaveCount(1)
    await page.waitForTimeout(500)

    const editorErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('Block type does not match') || text.includes('Editor crash')) {
          editorErrors.push(text)
        }
      }
    })

    const { updateCalls } = await withTasksUpdateSpy(page, async () => {
      await marqueeAcross(page, 0, 0)
      expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(1)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(400)
      return null
    })

    expect(editorErrors).toEqual([])
    expect(updateCalls).toBe(0)
    expect(await getBlockParentTaskIdProp(page, onlyId)).toBe('')
    expect(await getTaskParentIdInDb(page, onlyId)).toBeNull()
  })
})
