// @ts-nocheck
/**
 * Home Dashboard — Bookmarks widget E2E (Group G)
 *
 * Covers every shipped behavior of the Bookmarks widget on the Home board:
 * empty state, populated state, itemType variants (note / journal / task),
 * click-through targets, size→row-limit, and un-bookmark.
 *
 * Notes on infrastructure:
 * - Every test runs against a fresh temp vault (see ./fixtures). The
 *   migration-skip bug we just fixed (0032 journal `when`) is NOT reproducible
 *   here — it only manifests on a vault already migrated to 0031. That case is
 *   covered by the unit test `apps/desktop/src/main/database/migrate-journal.test.ts`.
 * - Bookmarks have no file representation; they live in `data.db`. Seed them via
 *   `window.api.bookmarks.toggle({ itemType, itemId })` from inside the app.
 * - Item ids:
 *     note    → seed a markdown file, then read its real id via window.api.notes.list
 *     journal → window.api.journal.createEntry returns the canonical note-cache id
 *     task    → window.api.tasks.create({ projectId, title }); projectId from listProjects
 * - The Home board ships a default bookmarks widget at size M (limit 6). All
 *   assertions are scoped to widget[data-widget-type="bookmarks"].
 */

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  dismissFirstRunOnboarding
} from './utils/electron-helpers'
import * as path from 'path'
import * as fs from 'fs'
import matter from 'gray-matter'

// ============================================================================
// Helpers
// ============================================================================

function writeNoteFile(
  vaultPath: string,
  fileName: string,
  frontmatter: Record<string, unknown>,
  body = ''
): void {
  const notesDir = path.join(vaultPath, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })

  const now = new Date().toISOString()
  const normalizedName = fileName.endsWith('.md') ? fileName : `${fileName}.md`

  const data = {
    title: frontmatter.title ?? normalizedName.replace(/\.md$/, ''),
    created: frontmatter.created ?? now,
    modified: frontmatter.modified ?? now,
    tags: frontmatter.tags ?? [],
    ...frontmatter
  }

  fs.writeFileSync(path.join(notesDir, normalizedName), matter.stringify(body, data))
}

/** The seeded Home board's bookmarks widget card. */
function bookmarksWidget(page: import('@playwright/test').Page) {
  return page.locator('[data-testid="widget"][data-widget-type="bookmarks"]').first()
}

function bookmarkRows(page: import('@playwright/test').Page) {
  return bookmarksWidget(page).locator('[data-testid="bookmark-item"]')
}

/**
 * Land on Home and wait for the board to render.
 *
 * Home is the default startup tab, but it is NOT necessarily the active tab
 * after a reload that follows opening another tab (clicking a note/task
 * bookmark switches the active tab; the app restores that tab on reload). The
 * Home tab is a persistent singleton in the strip, so click it to focus Home.
 */
async function gotoHome(page: import('@playwright/test').Page): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
  const homeTab = page.locator('[data-testid="nav-home"]').first()
  if (await homeTab.count()) {
    await homeTab.click()
  }
  await expect(page.locator('[data-testid="home-page"]')).toBeVisible({ timeout: 15000 })
  await expect(bookmarksWidget(page)).toBeVisible({ timeout: 15000 })
}

/**
 * Deterministically index notes seeded to disk after launch.
 *
 * The vault scan runs inside the fixture before the test writes any files, and
 * the chokidar watcher does not reliably catch a burst of post-launch writes
 * within the test window. `window.api.vault.reindex()` runs a full main-process
 * scan that reads each note's frontmatter, then we poll the notes RPC until the
 * expected count is present.
 */
async function reindexVault(
  page: import('@playwright/test').Page,
  expectedCount: number
): Promise<void> {
  await page.evaluate(() => window.api.vault.reindex())
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const res = await window.api.notes.list({
            sortBy: 'modified',
            sortOrder: 'desc',
            limit: 500,
            offset: 0
          })
          return res.notes.length
        }),
      { timeout: 20000 }
    )
    .toBeGreaterThanOrEqual(expectedCount)
}

/** Reload window and re-land on Home. */
async function reloadHome(page: import('@playwright/test').Page): Promise<void> {
  await page.reload()
  await gotoHome(page)
}

/** Resolve a seeded note's real id by matching its title via the notes RPC. */
async function noteIdByTitle(
  page: import('@playwright/test').Page,
  title: string
): Promise<string> {
  return page.evaluate(async (t) => {
    const res = await window.api.notes.list({
      sortBy: 'modified',
      sortOrder: 'desc',
      limit: 500,
      offset: 0
    })
    const match = res.notes.find((n: { title: string }) => n.title === t)
    return match?.id ?? ''
  }, title)
}

async function bookmark(
  page: import('@playwright/test').Page,
  itemType: string,
  itemId: string
): Promise<void> {
  await page.evaluate(({ itemType, itemId }) => window.api.bookmarks.toggle({ itemType, itemId }), {
    itemType,
    itemId
  })
}

/**
 * Set the content-density tier of the first widget of `type` by writing its grid
 * height through the homePages API. The board engine derives the tier from the
 * widget's row span (sizeTier: h<=2 → S, h<=4 → M, else L), so there is no longer
 * a resize button to click — height IS the size. Returns after persisting; the
 * caller reloads to re-render from the stored board.
 */
async function setWidgetHeight(
  page: import('@playwright/test').Page,
  type: string,
  h: number
): Promise<void> {
  await page.evaluate(
    async ({ type, h }) => {
      const boards = await window.api.homePages.list()
      const board = boards.find((b) => b.widgets.some((w) => w.type === type))
      if (!board) throw new Error(`no board with a ${type} widget`)
      const widgets = board.widgets.map((w) => (w.type === type ? { ...w, h } : w))
      await window.api.homePages.update({ id: board.id, widgets })
    },
    { type, h }
  )
}

// ============================================================================
// Tests
// ============================================================================

test.describe('Group G — Bookmarks widget', () => {
  // G1: No bookmarks → empty/non-crashing state.
  test('G1: empty state with no bookmarks', async ({ page }) => {
    await gotoHome(page)
    // Widget renders without crashing and shows zero rows.
    await expect(bookmarksWidget(page)).toBeVisible()
    await expect(bookmarkRows(page)).toHaveCount(0)
  })

  // G2: Bookmark a note → row appears with the note title.
  test('G2: bookmarked note appears with its title', async ({ page, testVaultPath }) => {
    const title = 'Bookmarked Note G2'
    writeNoteFile(testVaultPath, 'g2-note.md', { title }, `# ${title}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    const id = await noteIdByTitle(page, title)
    expect(id).not.toBe('')

    await bookmark(page, 'note', id)
    await reloadHome(page)

    const row = bookmarksWidget(page).locator(
      `[data-testid="bookmark-item"][data-item-type="note"][data-item-id="${id}"]`
    )
    await expect(row).toBeVisible()
    // The row prefixes a screen-reader-only type label ("Note") before the title
    // span, so assert containment rather than exact text.
    await expect(row).toContainText(title)
  })

  // G3: itemType variants — note + journal (+ task if creatable).
  test('G3: itemType variants render with correct data-item-type', async ({
    page,
    testVaultPath
  }) => {
    const noteTitle = 'Variant Note G3'
    writeNoteFile(testVaultPath, 'g3-note.md', { title: noteTitle }, `# ${noteTitle}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    // note
    const noteId = await noteIdByTitle(page, noteTitle)
    expect(noteId).not.toBe('')
    await bookmark(page, 'note', noteId)

    // journal — createEntry returns the canonical note-cache id; bookmark it.
    const journalId = await page.evaluate(async () => {
      const entry = await window.api.journal.createEntry({
        date: '2026-06-21',
        content: 'Journal body for G3'
      })
      return entry?.id ?? ''
    })
    expect(journalId).not.toBe('')
    await bookmark(page, 'journal', journalId)

    // task — best-effort; requires a project. Skip the sub-assertion if none.
    const taskId = await page.evaluate(async () => {
      const projects = await window.api.tasks.listProjects()
      const projectId = projects?.projects?.[0]?.id
      if (!projectId) return ''
      const res = await window.api.tasks.create({ projectId, title: 'Variant Task G3' })
      return res?.task?.id ?? res?.id ?? ''
    })
    if (taskId) {
      await bookmark(page, 'task', taskId)
    }

    await reloadHome(page)

    await expect(
      bookmarksWidget(page).locator(
        `[data-testid="bookmark-item"][data-item-type="note"][data-item-id="${noteId}"]`
      )
    ).toBeVisible()
    await expect(
      bookmarksWidget(page).locator(
        `[data-testid="bookmark-item"][data-item-type="journal"][data-item-id="${journalId}"]`
      )
    ).toBeVisible()

    if (taskId) {
      await expect(
        bookmarksWidget(page).locator(
          `[data-testid="bookmark-item"][data-item-type="task"][data-item-id="${taskId}"]`
        )
      ).toBeVisible()
    } else {
      console.log('G3: task sub-assertion skipped — no default project available to create a task')
    }
  })

  // G4: Click a bookmark row → opens the correct tab (note/journal → note tab; task → tasks tab).
  test('G4: clicking a bookmark opens the correct tab', async ({ page, testVaultPath }) => {
    const noteTitle = 'Clickable Note G4'
    writeNoteFile(testVaultPath, 'g4-note.md', { title: noteTitle }, `# ${noteTitle}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    const noteId = await noteIdByTitle(page, noteTitle)
    expect(noteId).not.toBe('')
    await bookmark(page, 'note', noteId)

    // Optional task target.
    const taskId = await page.evaluate(async () => {
      const projects = await window.api.tasks.listProjects()
      const projectId = projects?.projects?.[0]?.id
      if (!projectId) return ''
      const res = await window.api.tasks.create({ projectId, title: 'Clickable Task G4' })
      return res?.task?.id ?? res?.id ?? ''
    })
    if (taskId) {
      await bookmark(page, 'task', taskId)
    }

    await reloadHome(page)

    // note → note tab (a tab titled with the note title appears in the main tab strip).
    await bookmarksWidget(page)
      .locator(`[data-testid="bookmark-item"][data-item-type="note"][data-item-id="${noteId}"]`)
      .click()
    await expect(
      page.locator('[role="tab"][data-group-id]').filter({ hasText: noteTitle }).first()
    ).toBeVisible({ timeout: 10000 })

    if (taskId) {
      // task → tasks tab. Re-land on Home, click the task bookmark, assert a Tasks tab is active.
      await reloadHome(page)
      await bookmarksWidget(page)
        .locator(`[data-testid="bookmark-item"][data-item-type="task"][data-item-id="${taskId}"]`)
        .click()
      await expect(
        page.locator('[role="tab"][data-group-id]').filter({ hasText: 'Clickable Task G4' }).first()
      ).toBeVisible({ timeout: 10000 })
    } else {
      console.log('G4: task click sub-assertion skipped — no default project available')
    }
  })

  // G5: Size→limit — bookmarks widget defaults to M (≤6); resize to S (≤3) and back.
  test('G5: row limit follows widget size (S ≤3, M ≤6)', async ({ page, testVaultPath }) => {
    // Seed 8 notes so there are more bookmarks than any size limit.
    const titles: string[] = []
    for (let i = 1; i <= 8; i += 1) {
      const title = `Limit Note ${i}`
      titles.push(title)
      writeNoteFile(testVaultPath, `g5-note-${i}.md`, { title }, `# ${title}`)
    }

    await gotoHome(page)
    await reindexVault(page, 8)

    for (const title of titles) {
      const id = await noteIdByTitle(page, title)
      expect(id).not.toBe('')
      await bookmark(page, 'note', id)
    }

    await reloadHome(page)

    // Default span is h=4 → M tier (limit 6) → at most 6 rows.
    await expect(bookmarksWidget(page)).toHaveAttribute('data-widget-size', 'M')
    await expect(bookmarkRows(page)).toHaveCount(6)

    // Shrink to h=2 → S tier (limit 3) → at most 3 rows. Size is derived from the
    // grid span now, so set the height through the board API and reload.
    await setWidgetHeight(page, 'bookmarks', 2)
    await reloadHome(page)
    await expect(bookmarksWidget(page)).toHaveAttribute('data-widget-size', 'S')
    await expect(bookmarkRows(page)).toHaveCount(3)

    // Grow back to h=4 → M tier → 6 rows again.
    await setWidgetHeight(page, 'bookmarks', 4)
    await reloadHome(page)
    await expect(bookmarksWidget(page)).toHaveAttribute('data-widget-size', 'M')
    await expect(bookmarkRows(page)).toHaveCount(6)
  })

  // G6: null-title bookmark shows the "Untitled" fallback.
  // Feasible: a bookmark whose itemId is not in the note cache resolves itemTitle: null,
  // and the widget renders the t('home.widget.untitled') fallback string ("Untitled").
  test('G6: null-title bookmark shows the Untitled fallback', async ({ page }) => {
    await gotoHome(page)

    // Bookmark a note id that does not exist → resolveBookmarkItem returns itemTitle: null.
    const ghostId = 'ghost-note-id-does-not-exist'
    await bookmark(page, 'note', ghostId)

    await reloadHome(page)

    const row = bookmarksWidget(page).locator(
      `[data-testid="bookmark-item"][data-item-type="note"][data-item-id="${ghostId}"]`
    )
    await expect(row).toBeVisible()
    // The row prefixes a screen-reader-only type label ("Note") before the
    // Untitled fallback span, so assert containment rather than exact text.
    await expect(row).toContainText('Untitled')
  })

  // G7: Un-bookmark (toggle again) → row disappears after refresh.
  test('G7: un-bookmarking removes the row', async ({ page, testVaultPath }) => {
    const title = 'Toggle Note G7'
    writeNoteFile(testVaultPath, 'g7-note.md', { title }, `# ${title}`)

    await gotoHome(page)
    await reindexVault(page, 1)

    const id = await noteIdByTitle(page, title)
    expect(id).not.toBe('')

    await bookmark(page, 'note', id)
    await reloadHome(page)
    await expect(
      bookmarksWidget(page).locator(
        `[data-testid="bookmark-item"][data-item-type="note"][data-item-id="${id}"]`
      )
    ).toBeVisible()

    // Toggle again to remove.
    await bookmark(page, 'note', id)
    await reloadHome(page)
    await expect(
      bookmarksWidget(page).locator(
        `[data-testid="bookmark-item"][data-item-type="note"][data-item-id="${id}"]`
      )
    ).toHaveCount(0)
  })
})
