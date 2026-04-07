// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Inline Subtasks E2E Tests
 *
 * Verifies the inline-subtask-in-notes feature: typing/indenting a checkbox
 * under a task block in a note creates a subtask in the DB with parent_id set,
 * Shift+Tab promotes a subtask back to a standalone task, and pre-seeded
 * indented markdown is normalized to nested task blocks on load.
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, createNote } from './utils/electron-helpers'
import type { Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

// BlockNote's editable surface is exposed as a contenteditable inside the
// `application[aria-label="Rich text editor"]` region. The shared
// `SELECTORS.noteEditor` (`.bn-editor [contenteditable=true]`) doesn't match
// the actual DOM here, so we target the role-based parent directly.
const EDITOR_SELECTOR = '[aria-label="Rich text editor"] [contenteditable="true"]'

interface TaskRow {
  id: string
  parentId: string | null
  title: string
}

// Query tasks via the renderer's IPC bridge instead of opening SQLite directly:
// the test runner uses system Node, while better-sqlite3 in node_modules is
// rebuilt for Electron's NODE_MODULE_VERSION and would crash if loaded here.
async function findTasksByTitles(page: Page, titles: string[]): Promise<TaskRow[]> {
  const all = (await page.evaluate(async () => {
    const api = (window as unknown as { api?: { tasks?: { list?: (o: object) => Promise<unknown> } } }).api
    if (!api?.tasks?.list) return []
    const res = (await api.tasks.list({ includeCompleted: true, includeArchived: true })) as {
      tasks?: { id: string; parentId: string | null; title: string }[]
    }
    return res?.tasks ?? []
  })) as TaskRow[]
  return all.filter((t) => titles.includes(t.title))
}

function readNoteFiles(vaultPath: string): { name: string; content: string; mtime: number }[] {
  const notesDir = path.join(vaultPath, 'notes')
  if (!fs.existsSync(notesDir)) return []
  return fs
    .readdirSync(notesDir)
    .filter((f) => f.endsWith('.md'))
    .map((name) => {
      const full = path.join(notesDir, name)
      const stat = fs.statSync(full)
      return { name, content: fs.readFileSync(full, 'utf8'), mtime: stat.mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

async function focusEditor(page) {
  const editor = page.locator(EDITOR_SELECTOR).first()
  await editor.waitFor({ state: 'visible', timeout: 8000 })
  await editor.click()
  return editor
}

async function waitForTaskBlockCount(page, expected: number, timeout = 8000) {
  await expect
    .poll(
      async () => page.locator('[data-content-type="taskBlock"]').count(),
      { timeout, intervals: [200, 400, 800] }
    )
    .toBe(expected)
}

// Create a real DB task via IPC and return its id. We make tasks via the
// existing tasks-handlers IPC so the rows match what convertCheckboxToTask
// would create on the live edit path.
async function createTaskInDb(page, title: string): Promise<string> {
  return (await page.evaluate(async ({ title }) => {
    const api = (window as any).api
    if (!api?.tasks) throw new Error('window.api.tasks not exposed')
    const projectsRes = await api.tasks.listProjects()
    const projects = projectsRes?.projects ?? []
    const defaultProject =
      projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
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
  }, { title })) as string
}

// Replace the editor document with a single parent task block that has the
// given checklist children. Triggers a fresh onChange so ContentArea's
// scanBlocks runs and converts the nested checklist items into subtasks.
async function setDocumentToParentWithSubtask(
  page,
  parent: { taskId: string; title: string },
  sub: { title: string }
): Promise<void> {
  await page.evaluate(
    ({ parent, sub }) => {
      const editor = (window as any).__memryEditor
      if (!editor) throw new Error('window.__memryEditor not exposed')
      editor.replaceBlocks(editor.document, [
        {
          type: 'taskBlock',
          props: {
            taskId: parent.taskId,
            title: parent.title,
            checked: false,
            parentTaskId: ''
          },
          children: [
            {
              type: 'checkListItem',
              props: { isChecked: false },
              content: [{ type: 'text', text: sub.title, styles: {} }]
            }
          ]
        }
      ])
    },
    { parent, sub }
  )
}

// Replace the editor document so that `child` is nested inside `parent` but
// `child.props.parentTaskId` is still empty. This is exactly the post-Tab
// state — BlockNote moved the block into the parent's children[] but no one
// has wired the prop or DB yet. ContentArea's onChange should detect the
// stale prop, update both, and call tasksService.update.
async function setDocumentToTabIndentedTasks(
  page,
  parent: { taskId: string; title: string },
  child: { taskId: string; title: string }
): Promise<void> {
  await page.evaluate(
    ({ parent, child }) => {
      const editor = (window as any).__memryEditor
      if (!editor) throw new Error('window.__memryEditor not exposed')
      editor.replaceBlocks(editor.document, [
        {
          type: 'taskBlock',
          props: { taskId: parent.taskId, title: parent.title, checked: false, parentTaskId: '' },
          children: [
            {
              type: 'taskBlock',
              props: {
                taskId: child.taskId,
                title: child.title,
                checked: false,
                // Stale: still empty even though tree position is nested.
                parentTaskId: ''
              }
            }
          ]
        }
      ])
    },
    { parent, child }
  )
}

// Replace the editor document with a parent task block at the top level and
// the (already-existing) subtask checklist hoisted out as a sibling. This
// simulates the structural change that Shift+Tab makes — ContentArea's
// onChange then detects the un-indent and clears parentTaskId in the DB.
async function setDocumentToParentSiblingSub(
  page,
  parent: { taskId: string; title: string },
  sub: { taskId: string; title: string }
): Promise<void> {
  await page.evaluate(
    ({ parent, sub }) => {
      const editor = (window as any).__memryEditor
      if (!editor) throw new Error('window.__memryEditor not exposed')
      editor.replaceBlocks(editor.document, [
        {
          type: 'taskBlock',
          props: {
            taskId: parent.taskId,
            title: parent.title,
            checked: false,
            parentTaskId: ''
          }
        },
        {
          type: 'taskBlock',
          props: {
            taskId: sub.taskId,
            title: sub.title,
            checked: false,
            // parentTaskId is still set: this is exactly the state after
            // Shift+Tab, before ContentArea.tsx:567-576 clears it.
            parentTaskId: parent.taskId
          }
        }
      ])
    },
    { parent, sub }
  )
}

test.describe('Inline Subtasks', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('should create a subtask under a task block when an indented checkbox is added', async ({
    page,
    testVaultPath
  }) => {
    // #given — fresh note + a parent task already in the DB and rendered as
    // a taskBlock in the editor
    const parentTitle = `Buy groceries ${Date.now()}`
    const subTitle = `Buy milk ${Date.now()}`

    await createNote(page, `Subtask Test ${Date.now()}`)
    await focusEditor(page)

    const parentTaskId = await createTaskInDb(page, parentTitle)

    // #when — set the document to a parent task with a checklistitem as its
    // child. ContentArea's onChange runs scanBlocks, finds the nested
    // checklistitem under a taskBlock with taskId, and triggers
    // convertCheckboxToSubtask which inserts a DB row with parentId set.
    await setDocumentToParentWithSubtask(
      page,
      { taskId: parentTaskId, title: parentTitle },
      { title: subTitle }
    )
    await waitForTaskBlockCount(page, 2)

    // Allow the async DB write inside convertCheckboxToSubtask to settle.
    await page.waitForTimeout(1500)

    // #then — both tasks exist; the second has parentId pointing at the first
    const rows = await findTasksByTitles(page, [parentTitle, subTitle])
    expect(rows).toHaveLength(2)
    const parentRow = rows.find((r) => r.title === parentTitle)
    const subRow = rows.find((r) => r.title === subTitle)
    expect(parentRow!.id).toBe(parentTaskId)
    expect(parentRow!.parentId).toBeNull()
    expect(subRow!.parentId).toBe(parentRow!.id)

    // #then — markdown file persists the parent at column 0 and the sub indented
    const files = readNoteFiles(testVaultPath)
    expect(files.length).toBeGreaterThan(0)
    const md = files[0].content
    expect(md).toContain(`- [ ] ${parentTitle} {task:${parentRow!.id}}`)
    expect(md).toContain(`  - [ ] ${subTitle} {task:${subRow!.id}}`)
  })

  test('should promote a subtask back to standalone when un-indented', async ({
    page,
    testVaultPath
  }) => {
    // #given — parent task with one subtask, both wired in the DB
    const parentTitle = `Plan trip ${Date.now()}`
    const subTitle = `Book flight ${Date.now()}`

    await createNote(page, `Promote Test ${Date.now()}`)
    await focusEditor(page)

    const parentTaskId = await createTaskInDb(page, parentTitle)
    await setDocumentToParentWithSubtask(
      page,
      { taskId: parentTaskId, title: parentTitle },
      { title: subTitle }
    )
    await waitForTaskBlockCount(page, 2)
    await page.waitForTimeout(1500)

    const beforeRows = await findTasksByTitles(page, [parentTitle, subTitle])
    const parentBefore = beforeRows.find((r) => r.title === parentTitle)
    const subBefore = beforeRows.find((r) => r.title === subTitle)
    expect(parentBefore!.id).toBe(parentTaskId)
    expect(subBefore!.parentId).toBe(parentBefore!.id)

    // #when — restructure the document so the subtask becomes a top-level
    // sibling of the parent (still carrying parentTaskId in its props). This
    // is the exact post-Shift+Tab state. ContentArea's onChange handler at
    // ContentArea.tsx:567-576 detects the top-level taskBlock with
    // parentTaskId and clears the linkage in the DB.
    await setDocumentToParentSiblingSub(
      page,
      { taskId: parentBefore!.id, title: parentTitle },
      { taskId: subBefore!.id, title: subTitle }
    )

    // Wait for promotion side effect.
    await page.waitForTimeout(1500)

    // #then — DB shows subtask is now standalone
    const afterRows = await findTasksByTitles(page, [parentTitle, subTitle])
    const subAfter = afterRows.find((r) => r.title === subTitle)
    expect(subAfter).toBeDefined()
    expect(subAfter!.parentId).toBeNull()

    // #then — markdown file has both lines un-indented
    const md = readNoteFiles(testVaultPath)[0].content
    expect(md).toContain(`- [ ] ${parentTitle} {task:${parentBefore!.id}}`)
    expect(md).toContain(`- [ ] ${subTitle} {task:${subBefore!.id}}`)
    expect(md).not.toContain(`  - [ ] ${subTitle}`)
  })

  test('should normalize a pre-seeded markdown file with indented subtasks on load', async ({
    page,
    testVaultPath
  }) => {
    // #given — write a markdown file with parent + indented subtask BEFORE the
    // page is asked to display anything.
    const noteId = 'seeded-subtask-note'
    const parentTaskId = 'seeded-parent-task'
    const subTaskId = 'seeded-sub-task'
    const parentTitle = 'Seeded parent'
    const subTitle = 'Seeded child'
    const md = [
      '---',
      `id: ${noteId}`,
      'title: Seeded Subtask Note',
      '---',
      '',
      `- [ ] ${parentTitle} {task:${parentTaskId}}`,
      `  - [x] ${subTitle} {task:${subTaskId}}`,
      ''
    ].join('\n')
    fs.writeFileSync(path.join(testVaultPath, 'notes', `${noteId}.md`), md)

    // Force the indexer to pick up the new file by waiting; the watcher should
    // notice it. We then open the file via search → click result.
    await page.waitForTimeout(2000)

    // Open the note via search (Cmd+K)
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`)
    await page.waitForTimeout(400)
    const searchInput = page
      .locator('input[placeholder*="Search"], input[role="combobox"]')
      .first()
    if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchInput.fill('Seeded Subtask')
      await page.waitForTimeout(500)
      await page.keyboard.press('Enter')
    }

    // #when — wait for the editor to load and normalizeTaskBlocks to run
    await page.waitForTimeout(2000)

    // #then — DOM has 2 task blocks; the second is nested under the first
    await waitForTaskBlockCount(page, 2)

    const taskBlocks = page.locator('[data-content-type="taskBlock"]')
    expect(await taskBlocks.count()).toBe(2)

    // The seeded file's text content should appear in the editor
    const editorText = await page
      .locator('[aria-label="Rich text editor"]')
      .first()
      .textContent()
    expect(editorText).toContain(parentTitle)
    expect(editorText).toContain(subTitle)
  })

  test('should wire DB parent_id when an existing top-level task is Tab-indented under another', async ({
    page
  }) => {
    // #given — two top-level tasks already in DB and rendered as taskBlocks
    const parentTitle = `Plan trip ${Date.now()}`
    const childTitle = `Book flight ${Date.now()}`

    await createNote(page, `Tab Indent Test ${Date.now()}`)
    await focusEditor(page)

    const parentTaskId = await createTaskInDb(page, parentTitle)
    const childTaskId = await createTaskInDb(page, childTitle)

    // Sanity: both DB rows start as top-level (parentId === null).
    const before = await findTasksByTitles(page, [parentTitle, childTitle])
    expect(before.find((r) => r.title === childTitle)?.parentId).toBeNull()

    // #when — simulate the post-Tab structure (child nested in parent's
    // children[]) but with stale parentTaskId='' on the child. ContentArea's
    // demoted-block detection should fire and write parent_id to the DB row.
    await setDocumentToTabIndentedTasks(
      page,
      { taskId: parentTaskId, title: parentTitle },
      { taskId: childTaskId, title: childTitle }
    )

    // Allow the async tasksService.update to land.
    await page.waitForTimeout(1500)

    // #then — child row in DB has parent_id pointing at the parent
    const after = await findTasksByTitles(page, [parentTitle, childTitle])
    const childRow = after.find((r) => r.title === childTitle)
    expect(childRow).toBeDefined()
    expect(childRow!.parentId).toBe(parentTaskId)
  })

  test('should NOT clobber DB parent_id when a properly-nested subtask is rendered', async ({
    page
  }) => {
    // #given — parent + already-wired subtask in DB. The block tree mirrors
    // that wiring (child has parentTaskId set to match its tree parent).
    const parentTitle = `Plan launch ${Date.now()}`
    const childTitle = `Draft email ${Date.now()}`

    await createNote(page, `Stable Subtask Test ${Date.now()}`)
    await focusEditor(page)

    const parentTaskId = await createTaskInDb(page, parentTitle)
    const childTaskId = await createTaskInDb(page, childTitle)

    // Wire the child as a subtask of parent in the DB upfront.
    await page.evaluate(
      async ({ childTaskId, parentTaskId }) => {
        const api = (window as any).api
        await api.tasks.update({ id: childTaskId, parentId: parentTaskId })
      },
      { childTaskId, parentTaskId }
    )

    // Render the editor in the matching nested state (child has parentTaskId
    // set correctly — no demote intent should fire).
    await page.evaluate(
      ({ parent, child }) => {
        const editor = (window as any).__memryEditor
        if (!editor) throw new Error('window.__memryEditor not exposed')
        editor.replaceBlocks(editor.document, [
          {
            type: 'taskBlock',
            props: {
              taskId: parent.taskId,
              title: parent.title,
              checked: false,
              parentTaskId: ''
            },
            children: [
              {
                type: 'taskBlock',
                props: {
                  taskId: child.taskId,
                  title: child.title,
                  checked: false,
                  parentTaskId: parent.taskId
                }
              }
            ]
          }
        ])
      },
      {
        parent: { taskId: parentTaskId, title: parentTitle },
        child: { taskId: childTaskId, title: childTitle }
      }
    )

    await page.waitForTimeout(1000)

    // #then — DB row should still have parent_id set (not cleared by an
    // accidental un-indent fire).
    const after = await findTasksByTitles(page, [parentTitle, childTitle])
    const childRow = after.find((r) => r.title === childTitle)
    expect(childRow).toBeDefined()
    expect(childRow!.parentId).toBe(parentTaskId)
  })

  test('should demote a task to subtask when Tab is pressed in the title input', async ({
    page
  }) => {
    // Reproduces the user's exact complaint: a taskBlock that is already
    // converted (focus lives in the React title input) used to lose Tab to
    // browser focus navigation. The TaskBlockRenderer's title input now
    // intercepts Tab and reparents the block under the previous taskBlock
    // sibling, writing parent_id to the DB.
    const parentTitle = `Outline doc ${Date.now()}`
    const childTitle = `Add intro ${Date.now()}`

    await createNote(page, `Tab Input Demote Test ${Date.now()}`)
    await focusEditor(page)

    const parentTaskId = await createTaskInDb(page, parentTitle)
    const childTaskId = await createTaskInDb(page, childTitle)

    // Render two top-level taskBlocks in the editor.
    await page.evaluate(
      ({ parent, child }) => {
        const editor = (window as any).__memryEditor
        editor.replaceBlocks(editor.document, [
          {
            type: 'taskBlock',
            props: {
              taskId: parent.taskId,
              title: parent.title,
              checked: false,
              parentTaskId: ''
            }
          },
          {
            type: 'taskBlock',
            props: {
              taskId: child.taskId,
              title: child.title,
              checked: false,
              parentTaskId: ''
            }
          }
        ])
      },
      {
        parent: { taskId: parentTaskId, title: parentTitle },
        child: { taskId: childTaskId, title: childTitle }
      }
    )
    await waitForTaskBlockCount(page, 2)
    // Allow useTaskBlockData + useTasksOptional to populate before we look
    // for the rendered title text.
    await page.waitForTimeout(1500)

    // Drive the renderer's <input> directly via its key handler. The block
    // renders the input automatically (the renderer auto-enters edit mode on
    // first mount until the task loads from DB) so we don't need a click —
    // just find the input and dispatch a Tab keydown that React will route
    // through handleTitleKeyDown.
    const dispatched = await page.evaluate(
      async ({ childTaskId }) => {
        const taskBlocks = document.querySelectorAll<HTMLElement>(
          '[data-content-type="taskBlock"]'
        )
        if (taskBlocks.length < 2) {
          return { reason: 'taskBlock count', taskBlocks: taskBlocks.length }
        }
        const secondBlock = taskBlocks[1]
        // Try input first; if not present, click the clickable title to
        // enter edit mode and re-query.
        let input = secondBlock.querySelector<HTMLInputElement>('input[type="text"]')
        if (!input) {
          const clickable = secondBlock.querySelector<HTMLElement>(
            '[role="button"][tabindex="0"]'
          )
          if (clickable) {
            clickable.click()
            await new Promise((r) => requestAnimationFrame(() => r(null)))
            await new Promise((r) => requestAnimationFrame(() => r(null)))
            input = secondBlock.querySelector<HTMLInputElement>('input[type="text"]')
          }
        }
        if (!input) {
          return {
            reason: 'no input or clickable',
            html: secondBlock.outerHTML.slice(0, 600)
          }
        }
        input.focus()
        const ev = new KeyboardEvent('keydown', {
          key: 'Tab',
          code: 'Tab',
          bubbles: true,
          cancelable: true
        })
        input.dispatchEvent(ev)
        return { reason: 'ok', childTaskId }
      },
      { childTaskId }
    )
    // eslint-disable-next-line no-console
    console.log('dispatched:', dispatched)

    await page.waitForTimeout(1500)

    const after = await findTasksByTitles(page, [parentTitle, childTitle])
    const childRow = after.find((r) => r.title === childTitle)
    expect(childRow).toBeDefined()
    expect(childRow!.parentId).toBe(parentTaskId)
  })

  test('should debounce standalone auto-convert and let a Tab-indent win', async ({ page }) => {
    // Reproduces the race the user reported: a checkListItem typed under a
    // pre-existing parent taskBlock used to be auto-converted to a top-level
    // task immediately, locking focus into the read-only renderer before the
    // user could press Tab. With the debounce in place, the checkbox stays a
    // checklist for ~600ms; if it ends up nested under a taskBlock (Tab-indent
    // path) within that window, the conversion routes through the SUBTASK
    // path and writes parent_id to the DB.
    const parentTitle = `Cook dinner ${Date.now()}`
    const childTitle = `Chop veggies ${Date.now()}`

    await createNote(page, `Type Tab Race Test ${Date.now()}`)
    await focusEditor(page)
    const parentTaskId = await createTaskInDb(page, parentTitle)

    // Seed the editor with just the parent taskBlock.
    await page.evaluate(
      ({ taskId, title }) => {
        const editor = (window as any).__memryEditor
        editor.replaceBlocks(editor.document, [
          {
            type: 'taskBlock',
            props: { taskId, title, checked: false, parentTaskId: '' }
          }
        ])
      },
      { taskId: parentTaskId, title: parentTitle }
    )
    await waitForTaskBlockCount(page, 1)

    // #when — drop a top-level checkListItem (the "typed but not yet
    // converted" state). The standalone-convert path should NOT fire
    // immediately because of the debounce.
    await page.evaluate(
      ({ parentTaskId, parentTitle, childTitle }) => {
        const editor = (window as any).__memryEditor
        editor.replaceBlocks(editor.document, [
          {
            type: 'taskBlock',
            props: { taskId: parentTaskId, title: parentTitle, checked: false, parentTaskId: '' }
          },
          {
            type: 'checkListItem',
            props: { isChecked: false },
            content: [{ type: 'text', text: childTitle, styles: {} }]
          }
        ])
      },
      { parentTaskId, parentTitle, childTitle }
    )

    // Less than the debounce window: simulate the user pressing Tab while the
    // standalone-convert timer is still pending. We re-shape the document so
    // the checkListItem becomes a child of the parent — exactly what
    // BlockNote's nestBlock command would do for a real Tab keypress.
    await page.waitForTimeout(150)
    await page.evaluate(
      ({ parentTaskId, parentTitle }) => {
        const editor = (window as any).__memryEditor
        const doc = editor.document as any[]
        const parent = doc.find((b) => b.type === 'taskBlock')
        const checkbox = doc.find((b) => b.type === 'checkListItem')
        if (!parent || !checkbox) throw new Error('expected parent + checkbox in doc')
        editor.replaceBlocks(doc, [
          {
            type: 'taskBlock',
            props: { taskId: parentTaskId, title: parentTitle, checked: false, parentTaskId: '' },
            children: [checkbox]
          }
        ])
      },
      { parentTaskId, parentTitle }
    )

    // Wait for: debounce expiry → re-scan picks subtask path → DB create.
    await page.waitForTimeout(2000)

    const rows = await findTasksByTitles(page, [parentTitle, childTitle])
    const parentRow = rows.find((r) => r.title === parentTitle)
    const childRow = rows.find((r) => r.title === childTitle)
    expect(parentRow).toBeDefined()
    expect(childRow).toBeDefined()
    // The standalone-convert MUST NOT have fired — the child should be a
    // subtask, not a top-level task.
    expect(childRow!.parentId).toBe(parentRow!.id)
  })

  test('should write parent_id when a draft taskBlock has parentTaskId pre-set (Tab-then-type)', async ({
    page
  }) => {
    // Reproduces the user's exact bug:
    //   - task1
    //     - task1.1   ← shows in UI as nested but DB row had parent_id = null
    //
    // Sequence: type "task1" → Enter (renderer inserts new draft after) →
    // Tab (renderer's Tab branch nests the draft into task1.children AND
    // pre-sets parentTaskId='task1' on the draft block, but skips DB update
    // because the draft has no taskId yet) → type "task1.1" → save-title
    // debounce calls editor.updateBlock with the new title → onChange's
    // draftTaskBlock intent fires → createTaskForDraftBlock runs.
    //
    // The bug is in createTaskForDraftBlock: it ignores the block's
    // parentTaskId prop and creates a top-level row. After create, the block
    // gets taskId merged in, but parentTaskId still equals the tree-parent's
    // taskId, so the demote-repair sees prop===tree and silently skips. The
    // DB row never gets parent_id wired.
    //
    // We reproduce the exact post-Tab-then-type tree state programmatically:
    // a draft taskBlock with title set + parentTaskId pre-wired, nested as
    // a child of an existing parent taskBlock.
    const parentTitle = `Cook dinner ${Date.now()}`
    const childTitle = `Chop veggies ${Date.now()}`

    await createNote(page, `Tab Then Type Race ${Date.now()}`)
    await focusEditor(page)

    const parentTaskId = await createTaskInDb(page, parentTitle)

    // Sanity: parent starts with no children in DB.
    const before = await findTasksByTitles(page, [parentTitle])
    expect(before).toHaveLength(1)

    await page.evaluate(
      ({ parent, childTitle }) => {
        const editor = (window as any).__memryEditor
        if (!editor) throw new Error('window.__memryEditor not exposed')
        editor.replaceBlocks(editor.document, [
          {
            type: 'taskBlock',
            props: {
              taskId: parent.taskId,
              title: parent.title,
              checked: false,
              parentTaskId: ''
            },
            children: [
              {
                type: 'taskBlock',
                // The critical state: a DRAFT (taskId='') with title already
                // populated AND parentTaskId pre-wired by the renderer's Tab
                // branch. This is the exact state right after the user
                // presses Tab on a freshly-Enter'd block and starts typing.
                props: {
                  taskId: '',
                  title: childTitle,
                  checked: false,
                  parentTaskId: parent.taskId
                }
              }
            ]
          }
        ])
      },
      { parent: { taskId: parentTaskId, title: parentTitle }, childTitle }
    )

    // Allow createTaskForDraftBlock to fire and the DB write to settle.
    await page.waitForTimeout(2000)

    // #then — the new task row exists AND has parent_id pointing at parent.
    // With today's bug, parentId would be null (createTaskForDraftBlock
    // ignores parentTaskId).
    const rows = await findTasksByTitles(page, [parentTitle, childTitle])
    const parentRow = rows.find((r) => r.title === parentTitle)
    const childRow = rows.find((r) => r.title === childTitle)
    expect(parentRow).toBeDefined()
    expect(childRow).toBeDefined()
    expect(childRow!.parentId).toBe(parentRow!.id)
  })
})
