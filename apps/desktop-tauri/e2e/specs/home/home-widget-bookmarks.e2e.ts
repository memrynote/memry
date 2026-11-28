// The Bookmarks widget on the Home board (Group G), ported from Electron's
// `tests/e2e/home-widget-bookmarks.e2e.ts` (Step 30c2, #3547): empty state, populated state, the
// note, journal and task item types, where a click opens, size to row limit, an orphan bookmark,
// and un-bookmarking. Every test runs against a fresh empty vault. Bookmarks have no file; they
// live in `data.db` and are seeded through `bookmarks_toggle`, as the renderer toggles them. The
// seeded board ships one bookmarks widget at size M (limit 6); every assertion is scoped to it.
import type { Page } from '../../harness/pw-compat/page'
import {
  bootstrap,
  expect,
  noteIdsByTitle,
  reindexVault,
  setWidgetHeight,
  test,
  writeNoteFile
} from '../../harness/home-widgets'
import { invoke } from '../../harness/vault-commands'

interface TaskMutation {
  task: { id: string } | null
}

/** The seeded Home board's bookmarks widget card. */
const bookmarksWidget = (page: Page) =>
  page.locator('[data-testid="widget"][data-widget-type="bookmarks"]').first()

const bookmarkRows = (page: Page) => bookmarksWidget(page).locator('[data-testid="bookmark-item"]')

const bookmarkRow = (page: Page, itemType: string, itemId: string) =>
  bookmarksWidget(page).locator(
    `[data-testid="bookmark-item"][data-item-type="${itemType}"][data-item-id="${itemId}"]`
  )

/**
 * Lands on Home and waits for the board. A bookmark opens like a sidebar item, so its click can
 * replace the Home tab and the app restores that tab on reload; the rail's Home button always
 * navigates Home.
 */
async function gotoHome(page: Page): Promise<void> {
  await bootstrap(page)
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Home' })
    .click()
  await expect(page.locator('[data-testid="home-page"]')).toBeVisible({ timeout: 15000 })
  await expect(bookmarksWidget(page)).toBeVisible({ timeout: 15000 })
}

async function reloadHome(page: Page): Promise<void> {
  await page.reload()
  await gotoHome(page)
}

async function noteIdByTitle(page: Page, title: string): Promise<string> {
  return (await noteIdsByTitle(page))[title] ?? ''
}

async function bookmark(page: Page, itemType: string, itemId: string): Promise<void> {
  await invoke(page, 'bookmarks_toggle', { input: { itemType, itemId } })
}

/** A task in the first project, or '' when there is no project to hold one. */
async function createTask(page: Page, title: string): Promise<string> {
  const { projects } = await invoke<{ projects: Array<{ id: string }> }>(page, 'tasks_project_list')
  const projectId = projects?.[0]?.id
  if (!projectId) return ''
  const res = await invoke<TaskMutation>(page, 'tasks_create', { input: { projectId, title } })
  return res?.task?.id ?? ''
}

test.describe('Group G — Bookmarks widget', () => {
  test('G1: empty state with no bookmarks', async ({ page }) => {
    await gotoHome(page)
    await expect(bookmarksWidget(page)).toBeVisible()
    await expect(bookmarkRows(page)).toHaveCount(0)
  })

  test('G2: bookmarked note appears with its title', async ({ page, testVaultPath }) => {
    const title = 'Bookmarked Note G2'
    writeNoteFile(testVaultPath, 'g2-note.md', { title }, `# ${title}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    const id = await noteIdByTitle(page, title)
    expect(id).not.toBe('')

    await bookmark(page, 'note', id)
    await reloadHome(page)

    const row = bookmarkRow(page, 'note', id)
    await expect(row).toBeVisible()
    // The row puts a screen-reader-only type label ("Note") before the title.
    await expect(row).toContainText(title)
  })

  test('G3: itemType variants render with correct data-item-type', async ({
    page,
    testVaultPath
  }) => {
    const noteTitle = 'Variant Note G3'
    writeNoteFile(testVaultPath, 'g3-note.md', { title: noteTitle }, `# ${noteTitle}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    const noteId = await noteIdByTitle(page, noteTitle)
    expect(noteId).not.toBe('')
    await bookmark(page, 'note', noteId)

    // A journal day's id is the one `journal_create_entry` answers.
    const entry = await invoke<{ id: string } | null>(page, 'journal_create_entry', {
      input: { date: '2026-06-21', content: 'Journal body for G3' }
    })
    const journalId = entry?.id ?? ''
    expect(journalId).not.toBe('')
    await bookmark(page, 'journal', journalId)

    // A task needs a project; the sub-assertion is skipped when there is none, as in Electron.
    const taskId = await createTask(page, 'Variant Task G3')
    if (taskId) await bookmark(page, 'task', taskId)

    await reloadHome(page)

    await expect(bookmarkRow(page, 'note', noteId)).toBeVisible()
    await expect(bookmarkRow(page, 'journal', journalId)).toBeVisible()

    if (taskId) {
      await expect(bookmarkRow(page, 'task', taskId)).toBeVisible()
    } else {
      console.log('G3: task sub-assertion skipped — no default project available to create a task')
    }
  })

  test('G4: clicking a bookmark opens the correct tab', async ({ page, testVaultPath }) => {
    const noteTitle = 'Clickable Note G4'
    writeNoteFile(testVaultPath, 'g4-note.md', { title: noteTitle }, `# ${noteTitle}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    const noteId = await noteIdByTitle(page, noteTitle)
    expect(noteId).not.toBe('')
    await bookmark(page, 'note', noteId)

    const taskId = await createTask(page, 'Clickable Task G4')
    if (taskId) await bookmark(page, 'task', taskId)

    await reloadHome(page)

    // A note opens in a tab titled with the note title.
    await bookmarkRow(page, 'note', noteId).click()
    await expect(
      page.locator('[role="tab"][data-group-id]').filter({ hasText: noteTitle }).first()
    ).toBeVisible({ timeout: 10000 })

    if (taskId) {
      await reloadHome(page)
      await bookmarkRow(page, 'task', taskId).click()
      await expect(
        page.locator('[role="tab"][data-group-id]').filter({ hasText: 'Clickable Task G4' }).first()
      ).toBeVisible({ timeout: 10000 })
    } else {
      console.log('G4: task click sub-assertion skipped — no default project available')
    }
  })

  test('G5: row limit follows widget size (S ≤3, M ≤6)', async ({ page, testVaultPath }) => {
    // More bookmarks than any size limit.
    const titles: string[] = []
    for (let i = 1; i <= 8; i += 1) {
      const title = `Limit Note ${i}`
      titles.push(title)
      writeNoteFile(testVaultPath, `g5-note-${i}.md`, { title }, `# ${title}`)
    }

    await gotoHome(page)
    await reindexVault(page, 8)

    const ids = await noteIdsByTitle(page)
    for (const title of titles) {
      const id = ids[title] ?? ''
      expect(id).not.toBe('')
      await bookmark(page, 'note', id)
    }

    await reloadHome(page)

    // The default span h=4 is the M tier, limit 6.
    await expect(bookmarksWidget(page)).toHaveAttribute('data-widget-size', 'M')
    await expect(bookmarkRows(page)).toHaveCount(6)

    // h=2 is the S tier, limit 3.
    await setWidgetHeight(page, 'bookmarks', 2)
    await reloadHome(page)
    await expect(bookmarksWidget(page)).toHaveAttribute('data-widget-size', 'S')
    await expect(bookmarkRows(page)).toHaveCount(3)

    await setWidgetHeight(page, 'bookmarks', 4)
    await reloadHome(page)
    await expect(bookmarksWidget(page)).toHaveAttribute('data-widget-size', 'M')
    await expect(bookmarkRows(page)).toHaveCount(6)
  })

  // A bookmark whose target is gone (itemExists: false) is hidden instead of rendering an
  // unopenable "Untitled" row.
  test('G6: orphan bookmark is hidden from the widget', async ({ page }) => {
    await gotoHome(page)

    const ghostId = 'ghost-note-id-does-not-exist'
    await bookmark(page, 'note', ghostId)

    await reloadHome(page)

    await expect(bookmarkRow(page, 'note', ghostId)).toHaveCount(0)
  })

  test('G7: un-bookmarking removes the row', async ({ page, testVaultPath }) => {
    const title = 'Toggle Note G7'
    writeNoteFile(testVaultPath, 'g7-note.md', { title }, `# ${title}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    const id = await noteIdByTitle(page, title)
    expect(id).not.toBe('')

    await bookmark(page, 'note', id)
    await reloadHome(page)
    await expect(bookmarkRow(page, 'note', id)).toBeVisible()

    await bookmark(page, 'note', id)
    await reloadHome(page)
    await expect(bookmarkRow(page, 'note', id)).toHaveCount(0)
  })
})
