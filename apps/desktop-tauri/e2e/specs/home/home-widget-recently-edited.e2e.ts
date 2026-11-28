// The Recently edited widget on the Home board (Group F), ported from Electron's
// `tests/e2e/home-widget-recently-edited.e2e.ts` (Step 30c2, #3547). Every test runs against a
// fresh empty vault. Notes are seeded as markdown files under `notes/` and picked up by a full
// reindex; a note's title is its filename and its id comes from the index, so real ids are read
// back through `notes_list`.
//
// The widget registers sizes S and M (default M); rows are limited to 3 at S and 6 at M. The
// seeded board ships one widget at M. Rows are `button[data-testid="recent-note"]` carrying
// `data-note-id`; a click opens the note in a tab titled with its title.
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

const RECENT_WIDGET = '[data-testid="widget"][data-widget-type="recently-edited"]'

/** Seeds `count` notes and answers them newest-first; ids are filled by `resolveIds`. */
function seedNotesByRecency(
  vaultPath: string,
  count: number
): Array<{ id: string; title: string }> {
  const seeded: Array<{ id: string; title: string }> = []
  for (let i = 0; i < count; i += 1) {
    const title = `Recent Note ${i + 1}`
    writeNoteFile(vaultPath, title, { title }, `# ${title}\n\nRecency seed.`)
    seeded.push({ id: '', title })
  }
  return seeded.toReversed()
}

async function resolveIds(page: Page, rows: Array<{ id: string; title: string }>): Promise<void> {
  const byTitle = await noteIdsByTitle(page)
  for (const row of rows) row.id = byTitle[row.title] ?? row.id
}

const recentRows = (page: Page) =>
  page.locator(RECENT_WIDGET).first().locator('[data-testid="recent-note"]')

async function reload(page: Page): Promise<void> {
  await page.reload()
  await bootstrap(page)
}

const HEIGHT_BY_SIZE: Record<'S' | 'M', number> = { S: 2, M: 4 }

/** Sets the widget's size tier through its grid height, then reloads to render the saved board. */
async function resizeWidgetTo(page: Page, size: 'S' | 'M'): Promise<void> {
  await setWidgetHeight(page, 'recently-edited', HEIGHT_BY_SIZE[size])
  await reload(page)
  await expect(page.locator(RECENT_WIDGET).first()).toHaveAttribute('data-widget-size', size)
}

test.describe('Group F — Recently edited widget', () => {
  test('F1: no notes → widget renders empty, non-crashing state (zero rows)', async ({ page }) => {
    await bootstrap(page)

    // Home is the default startup tab.
    await expect(page.locator('[data-testid="home-page"]')).toBeVisible()
    const widget = page.locator(RECENT_WIDGET).first()
    await expect(widget).toBeVisible()

    await expect(recentRows(page)).toHaveCount(0)
  })

  // Electron marks this fixme: a seeded note's modified time is its file mtime, and the harness
  // cannot space the mtimes without stalling the watcher's reindex. Kept as Electron has it.
  test.fixme('F2: rows appear in descending modified order (top = most recent)', async ({
    page,
    testVaultPath
  }) => {
    const newestFirst = seedNotesByRecency(testVaultPath, 8)
    await bootstrap(page)
    await reindexVault(page, 8)
    await resolveIds(page, newestFirst)
    await reload(page)

    const rows = recentRows(page)
    await expect(rows.first()).toBeVisible()
    await expect(rows.first()).toHaveAttribute('data-note-id', newestFirst[0].id)
    await expect(rows.first()).toContainText(newestFirst[0].title)
  })

  test('F3: size→limit — S shows ≤3 rows, M shows ≤6 rows', async ({ page, testVaultPath }) => {
    seedNotesByRecency(testVaultPath, 8)
    await bootstrap(page)
    await reindexVault(page, 8)
    await reload(page)

    await resizeWidgetTo(page, 'S')
    await expect(recentRows(page).first()).toBeVisible()
    const sCount = await recentRows(page).count()
    expect(sCount).toBeLessThanOrEqual(3)
    expect(sCount).toBeGreaterThan(0)

    await resizeWidgetTo(page, 'M')
    await expect(recentRows(page).first()).toBeVisible()
    const mCount = await recentRows(page).count()
    expect(mCount).toBeLessThanOrEqual(6)
    expect(mCount).toBeGreaterThanOrEqual(sCount)
  })

  test('F4: click a recent-note → opens that note in an active note tab', async ({
    page,
    testVaultPath
  }) => {
    const seeded = seedNotesByRecency(testVaultPath, 3)
    await bootstrap(page)
    await reindexVault(page, 3)
    await resolveIds(page, seeded)
    await reload(page)

    // The row is matched by its real id, wherever it sits.
    const target = seeded[0]
    const targetRow = page
      .locator(RECENT_WIDGET)
      .first()
      .locator(`[data-testid="recent-note"][data-note-id="${target.id}"]`)
    await expect(targetRow).toBeVisible()
    await targetRow.click()

    const activeTab = page
      .locator('[role="tab"][data-group-id][aria-selected="true"]')
      .filter({ hasText: target.title })
      .first()
    await expect(activeTab).toBeVisible()
  })

  // Electron marks this fixme for the same harness limit as F2: it asserts a strict recency order.
  test.fixme('F5: editing an older note with a newer modified moves it to the top', async ({
    page,
    testVaultPath
  }) => {
    const newestFirst = seedNotesByRecency(testVaultPath, 5)
    await bootstrap(page)
    await reindexVault(page, 5)
    await resolveIds(page, newestFirst)
    await reload(page)

    const oldest = newestFirst[newestFirst.length - 1]
    await expect(recentRows(page).first()).not.toHaveAttribute('data-note-id', oldest.id)

    // The edit bumps its `modified` past every other note's.
    await invoke(page, 'notes_update', { input: { id: oldest.id, content: 'Bumped.' } })
    await expect
      .poll(
        async () => {
          const list = await invoke<{ notes: Array<{ id: string }> }>(page, 'notes_list', {
            options: { sortBy: 'modified', sortOrder: 'desc', limit: 500 }
          })
          return list.notes[0]?.id === oldest.id
        },
        { timeout: 20000 }
      )
      .toBe(true)
    await reload(page)

    await expect(recentRows(page).first()).toHaveAttribute('data-note-id', oldest.id)
  })

  // Truncation is the row button's CSS `truncate` class; a clipped-width check depends on fonts
  // and widget width, so Electron skips it.
  test.skip('F6: very long title truncates within the card (visual / CSS-only)', async () => {})
})
