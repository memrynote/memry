/**
 * Obsidian Tasks lines become Memry tasks the first time the note is opened.
 *
 * Memry reads the plugin's two line formats, the emoji one (`📅 2026-09-01 ⏫`)
 * and the Dataview inline-field one (`[due:: 2026-09-15]`), turns each into a
 * real task, and appends its own `{task:<id>}` suffix to the line it claimed.
 * Three constructs are declined and the line is left byte-identical: `🆔`, `⛔`
 * and a trailing `^blockid`. `packages/shared/src/obsidian-tasks.ts` gives the
 * reason. Memry's suffix has to be the last thing on the line, which un-anchors
 * every end-anchored regex the plugin owns, and the id and depends-on fields
 * point into files Memry has never read.
 *
 * The parser is pinned field by field in
 * `packages/shared/src/obsidian-tasks.test.ts`. What only an E2E can show is
 * that the RUNNING app wires it to the vault, so the note is seeded as bytes on
 * disk, opened in the real editor, and the `.md` is read back with `fs`.
 * `getNoteFileBodyById` is deliberately not the reader. Its `normalizeBodyText`
 * trims the end of the body and collapses blank-line runs, so it would report
 * the declined line as untouched even when the app had rewritten the file
 * around it. `fs` is the only honest reader for a claim about bytes.
 *
 * The second open is asserted because a line that already carries
 * `{task:<id>}` is a Memry task and not an import candidate. A suite that only
 * ever opened the note once would stay green while every open silently doubled
 * the task list. The four UI edits live in a second test because the per-test
 * timeout is 180 s (`config/playwright.config.ts`) and one monolith would risk
 * it.
 *
 * Run with `BUILD_BEFORE_TEST=1`.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { getNoteHandleByTitle, openNoteByTitle } from './utils/note-sync-helpers'
import { closeTaskDrawer, openTaskDrawer, taskRow } from './utils/task-drawer-helpers'
import {
  navigateTo,
  showAllTasksScope,
  waitForAppReady,
  waitForVaultReady,
  SELECTORS
} from './utils/electron-helpers'

/** Two spaces before each `[`, which is what the Dataview format actually writes. */
const DATAVIEW_LINE = '- [ ] Pay rent  [due:: 2026-09-15]  [priority:: high]'
const DECLINED_LINE = '- [ ] Do first 🆔 dcf64c'
const BODY = ['- [ ] Buy milk 📅 2026-09-01 ⏫ #errand', DATAVIEW_LINE, DECLINED_LINE].join('\n')

type DateParts = { year: number; month: number; day: number }

interface TaskRecord {
  id: string
  title: string
  projectId: string | null
  dueDate: string | number | Date | null | undefined
}

interface TaskApi {
  get(id: string): Promise<TaskRecord | null>
  list(input: { limit: number }): Promise<{ tasks: TaskRecord[] }>
  createProject(input: {
    name: string
    description: string
    color: string
    icon: string
    statuses: Array<{ name: string; color: string; type: string; order: number }>
  }): Promise<{ success: boolean; project?: { id: string }; error?: string }>
}

type TaskApiWindow = Window & { api: { tasks: TaskApi } }

function seedVaultFile(vaultPath: string, title: string, body: string): string {
  const absPath = path.join(vaultPath, 'notes', `${title}.md`)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, body, 'utf8')
  return absPath
}

/** How many lines the importer has claimed. Counted, so a third stamp fails loudly. */
function countTaskStamps(markdown: string): number {
  return markdown.match(/\{task:/g)?.length ?? 0
}

/**
 * The bytes the file settles on once the indexer has claimed it. Indexing a
 * file that has never been seen rewrites it before any editor exists, so
 * baselining after it stops moving makes the later comparison mean exactly
 * "did OPENING it change anything".
 */
async function indexedBaseline(page: Page, title: string, absPath: string): Promise<string> {
  await getNoteHandleByTitle(page, title) // blocks until the note is in the index
  let bytes = fs.readFileSync(absPath, 'utf8')
  await expect
    .poll(
      () => {
        const next = fs.readFileSync(absPath, 'utf8')
        const settled = next === bytes
        bytes = next
        return settled
      },
      { timeout: 20_000, intervals: [1000] }
    )
    .toBe(true)
  return bytes
}

async function openInEditor(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function goToTasksPage(page: Page): Promise<void> {
  await navigateTo(page, 'tasks')
  // `navigateTo` swallows its own click failure, so the scope combobox is the
  // only proof the click landed on Tasks and not wherever the app already was.
  await expect(page.getByRole('combobox', { name: 'Task views' })).toBeVisible({ timeout: 20_000 })
  await showAllTasksScope(page)
}

async function listTasks(page: Page): Promise<Array<{ id: string; title: string }>> {
  return page.evaluate(async () => {
    const result = await (window as unknown as TaskApiWindow).api.tasks.list({ limit: 200 })
    return result.tasks.map((task) => ({ id: task.id, title: task.title }))
  })
}

async function taskIdByTitle(page: Page, titleFragment: string): Promise<string> {
  const match = (await listTasks(page)).find((task) => task.title.includes(titleFragment))
  if (!match) throw new Error(`no imported task whose title contains "${titleFragment}"`)
  return match.id
}

/**
 * One read of a task, with the due date already split into calendar parts.
 *
 * A `YYYY-MM-DD` due date is read digit by digit rather than through `Date`.
 * The importer writes a date key, which names a calendar day and carries no
 * zone, and `new Date('2026-09-01')` would resolve it as UTC midnight and hand
 * back 31 August anywhere west of Greenwich. A real `Date` gets local getters,
 * which is how the app's own badge renders it.
 */
async function readTask(
  page: Page,
  taskId: string
): Promise<{ title: string; projectId: string | null; due: DateParts | null } | null> {
  return page.evaluate(async (id) => {
    const task = await (window as unknown as TaskApiWindow).api.tasks.get(id)
    if (!task) return null

    const raw = task.dueDate
    let due: DateParts | null = null
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      due = {
        year: Number(raw.slice(0, 4)),
        month: Number(raw.slice(5, 7)),
        day: Number(raw.slice(8, 10))
      }
    } else if (raw !== null && raw !== undefined) {
      const parsed = raw instanceof Date ? raw : new Date(raw)
      due = { year: parsed.getFullYear(), month: parsed.getMonth() + 1, day: parsed.getDate() }
    }

    return { title: task.title, projectId: task.projectId ?? null, due }
  }, taskId)
}

async function dueByTitle(page: Page, titleFragment: string): Promise<DateParts | null> {
  const task = await readTask(page, await taskIdByTitle(page, titleFragment))
  return task?.due ?? null
}

async function createProject(page: Page, name: string): Promise<string> {
  return page.evaluate(async (projectName) => {
    const result = await (window as unknown as TaskApiWindow).api.tasks.createProject({
      name: projectName,
      description: 'Obsidian import target',
      color: '#3b82f6',
      icon: 'FolderKanban',
      // `ProjectCreateSchema` requires at least two statuses.
      statuses: [
        { name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
        { name: 'Done', color: '#10b981', type: 'done', order: 1 }
      ]
    })
    if (!result.success || !result.project) throw new Error(result.error ?? 'project create failed')
    return result.project.id
  }, name)
}

test.describe('Obsidian Tasks import', () => {
  test('opening a note imports two lines, declines the 🆔 line, and does not import twice', async ({
    page,
    testVaultPath
  }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // #given three Obsidian Tasks lines written straight to disk
    const title = `Obsidian Tasks ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, BODY)
    const baseline = await indexedBaseline(page, title, absPath)
    expect(baseline, 'the indexer left the declined line alone').toContain(DECLINED_LINE)

    // #when the note is opened in the real editor
    await openInEditor(page, title)

    // #then exactly two of the three lines carry a Memry task id
    await expect
      .poll(() => countTaskStamps(fs.readFileSync(absPath, 'utf8')), { timeout: 30_000 })
      .toBe(2)

    const afterFirstOpen = fs.readFileSync(absPath, 'utf8')
    expect(afterFirstOpen, 'the 🆔 line is byte-identical').toContain(DECLINED_LINE)
    expect(
      afterFirstOpen.split('\n').filter((line) => line.includes('🆔') && line.includes('{task:')),
      'no 🆔 line was stamped'
    ).toEqual([])

    await goToTasksPage(page)
    await expect(taskRow(page, 'Buy milk')).toBeVisible({ timeout: 20_000 })
    await expect(taskRow(page, 'Pay rent')).toBeVisible({ timeout: 20_000 })

    expect(await dueByTitle(page, 'Buy milk')).toEqual({ year: 2026, month: 9, day: 1 })
    expect(await dueByTitle(page, 'Pay rent')).toEqual({ year: 2026, month: 9, day: 15 })

    const tasksAfterFirstOpen = await listTasks(page)
    expect(
      tasksAfterFirstOpen.filter((task) => task.title.includes('Do first')),
      'the declined line produced no task'
    ).toEqual([])

    // #when the app is reloaded and the same note opened again
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await openInEditor(page, title)
    await page.waitForTimeout(3_000)

    // #then nothing is imported a second time. A line that already carries
    // `{task:<id>}` is a Memry task, not an import candidate, and a spec that
    // only ever imported once would pass without ever proving that.
    expect((await listTasks(page)).length).toBe(tasksAfterFirstOpen.length)
    expect(countTaskStamps(fs.readFileSync(absPath, 'utf8'))).toBe(2)
  })

  test('an imported task renames, moves project, takes a due date and deletes from the UI', async ({
    page,
    testVaultPath
  }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // #given the same three lines, imported by opening the note
    const title = `Obsidian Tasks UI ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, BODY)
    await indexedBaseline(page, title, absPath)
    await openInEditor(page, title)
    await expect
      .poll(() => countTaskStamps(fs.readFileSync(absPath, 'utf8')), { timeout: 30_000 })
      .toBe(2)

    const projectName = `Imported Home ${Date.now()}`
    const projectId = await createProject(page, projectName)

    await goToTasksPage(page)
    const buyMilkId = await taskIdByTitle(page, 'Buy milk')

    // #when the drawer renames it
    const drawer = await openTaskDrawer(page, 'Buy milk')
    const renamed = `Buy oat milk ${Date.now()}`
    await drawer.getByRole('textbox', { name: 'Task name' }).fill(renamed)

    // #then the rename reached the database and not just the input
    await expect
      .poll(async () => (await readTask(page, buyMilkId))?.title, { timeout: 20_000 })
      .toBe(renamed)

    // #when the drawer moves it into a project
    await drawer.getByRole('button', { name: /^Project: .*\. Click to change\.$/ }).click()
    await page.getByRole('option', { name: projectName }).click()

    // #then
    await expect
      .poll(async () => (await readTask(page, buyMilkId))?.projectId, { timeout: 20_000 })
      .toBe(projectId)

    // #when the drawer replaces the imported 2026-09-01 with today
    const today = await page.evaluate(() => {
      const now = new Date()
      return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
    })
    await drawer.getByRole('button', { name: /^Due: .*\. Click to change\.$/ }).click()
    // The preset lives in a Radix popover, portalled out of the drawer, and its
    // accessible name carries the formatted date after the label: "Today Aug 31".
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Today\b/ })
      .click()

    // #then
    await expect
      .poll(async () => (await readTask(page, buyMilkId))?.due, { timeout: 20_000 })
      .toEqual(today)

    await closeTaskDrawer(page)

    // #when the other imported task is deleted from its drawer
    const rentDrawer = await openTaskDrawer(page, 'Pay rent')
    await rentDrawer.getByRole('button', { name: 'Delete task', exact: true }).click()
    // Capital T, and the trigger behind the dialog is still in the DOM.
    await page.getByRole('button', { name: 'Delete Task', exact: true }).click()

    // #then it is gone from the database and from the list
    await expect
      .poll(async () => (await listTasks(page)).some((task) => task.title.includes('Pay rent')), {
        timeout: 20_000
      })
      .toBe(false)
    await expect(taskRow(page, 'Pay rent')).toBeHidden({ timeout: 20_000 })
  })
})
