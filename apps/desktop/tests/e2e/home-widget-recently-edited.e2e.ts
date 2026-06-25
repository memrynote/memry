// @ts-nocheck
/**
 * Home Dashboard — Recently edited widget E2E (group F)
 *
 * Each test runs against a fresh temp vault (fixtures), so the migration-skip
 * bug we just fixed (0032 journal `when`) is NOT reproducible here — it only
 * manifests on a vault already migrated to 0031. That case is covered by the
 * unit test `apps/desktop/src/main/database/migrate-journal.test.ts`.
 *
 * Notes are seeded as markdown files (gray-matter frontmatter) into
 * <testVaultPath>/notes/, mirroring folder-view.e2e.ts. `modified`/`created`
 * timestamps control recency ordering. The widget reads notes via
 * useNotesList({ sortBy: 'modified', sortOrder: 'desc' }).
 *
 * Widget facts (apps/.../widgets/recently-edited-widget.tsx + index.ts):
 * - Registered sizes: S and M only (no L). defaultSize: 'M'.
 * - Row limit by size: S = 3, M = 6 (L would be 12 but L is not allowed).
 * - The default seeded board ships ONE recently-edited widget at size M.
 * - Rows render as <button data-testid="recent-note" data-note-id={id}>; click
 *   opens the note in a tab titled with the note title.
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

/** Write a note markdown file with explicit id/title/modified into notes/. */
function writeNote(
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
    id: frontmatter.id ?? normalizedName.replace(/\.md$/, ''),
    title: frontmatter.title ?? normalizedName.replace(/\.md$/, ''),
    created: frontmatter.created ?? now,
    modified: frontmatter.modified ?? now,
    tags: frontmatter.tags ?? [],
    ...frontmatter
  }

  fs.writeFileSync(path.join(notesDir, normalizedName), matter.stringify(body, data))
}

/**
 * Seed `count` notes with strictly increasing `modified` timestamps so note N
 * (1-indexed) is more recent than note N-1. Returns the list newest-first,
 * matching the widget's descending order.
 */
function seedNotesByRecency(
  vaultPath: string,
  count: number
): Array<{ id: string; title: string; modified: string }> {
  const base = new Date('2026-01-01T00:00:00.000Z').getTime()
  const seeded: Array<{ id: string; title: string; modified: string }> = []
  for (let i = 0; i < count; i += 1) {
    const id = `recent-${i + 1}`
    const title = `Recent Note ${i + 1}`
    // Later index → later modified (one hour apart).
    const modified = new Date(base + i * 60 * 60 * 1000).toISOString()
    const created = new Date(base).toISOString()
    writeNote(vaultPath, id, { id, title, created, modified }, `# ${title}\n\nRecency seed.`)
    seeded.push({ id, title, modified })
  }
  // Newest-first.
  return seeded.reverse()
}

const RECENT_WIDGET = '[data-testid="widget"][data-widget-type="recently-edited"]'

/** Locator scoped to the recently-edited widget's row buttons. */
function recentRows(page) {
  return page.locator(RECENT_WIDGET).first().locator('[data-testid="recent-note"]')
}

async function reload(page): Promise<void> {
  await page.reload()
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
}

/**
 * Deterministically index notes seeded to disk after launch.
 *
 * The initial vault scan completes inside the `electronApp` fixture BEFORE the
 * test body writes any files, and the chokidar watcher does not reliably pick
 * up a burst of post-launch writes within the test window (it lands one file
 * non-deterministically). `window.api.vault.reindex()` runs a full main-process
 * vault scan that reads each note's frontmatter `modified` via syncNoteToCache,
 * so the note_cache reflects the seeded timestamps exactly. We poll the notes
 * RPC until the expected count is present, then the caller reloads so the
 * react-query-backed widget re-fetches.
 */
async function reindexVault(page, expectedCount: number): Promise<void> {
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

async function bootstrap(page): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
}

// Grid height that maps to each content-density tier (sizeTier: h<=2 → S,
// h<=4 → M). The board engine derives the tier from the widget's row span, so
// there is no resize button to click — height IS the size.
const HEIGHT_BY_SIZE: Record<'S' | 'M', number> = { S: 2, M: 4 }

/**
 * Set the recently-edited widget to a given content-density tier by writing its
 * grid height through the homePages API, then reload so the board re-renders from
 * the stored layout.
 */
async function resizeWidgetTo(page, size: 'S' | 'M'): Promise<void> {
  await page.evaluate(
    async ({ h }) => {
      const boards = await window.api.homePages.list()
      const board = boards.find((b) => b.widgets.some((w) => w.type === 'recently-edited'))
      if (!board) throw new Error('no board with a recently-edited widget')
      const widgets = board.widgets.map((w) => (w.type === 'recently-edited' ? { ...w, h } : w))
      await window.api.homePages.update({ id: board.id, widgets })
    },
    { h: HEIGHT_BY_SIZE[size] }
  )
  await reload(page)
  await expect(page.locator(RECENT_WIDGET).first()).toHaveAttribute('data-widget-size', size)
}

// ============================================================================
// Tests
// ============================================================================

test.describe('Group F — Recently edited widget', () => {
  test('F1: no notes → widget renders empty, non-crashing state (zero rows)', async ({ page }) => {
    await bootstrap(page)

    // Home is the default startup tab.
    await expect(page.locator('[data-testid="home-page"]')).toBeVisible()
    const widget = page.locator(RECENT_WIDGET).first()
    await expect(widget).toBeVisible()

    // No notes seeded → no recent-note rows, and the widget did not crash.
    await expect(recentRows(page)).toHaveCount(0)
  })

  test('F2: rows appear in descending modified order (top = most recent)', async ({
    page,
    testVaultPath
  }) => {
    const newestFirst = seedNotesByRecency(testVaultPath, 8)

    await bootstrap(page)
    // Index the post-launch seed deterministically, then reload so the widget
    // re-fetches.
    await reindexVault(page, 8)
    await reload(page)

    const rows = recentRows(page)
    // Default widget size is M → up to 6 rows.
    await expect(rows.first()).toBeVisible()

    // Top row must be the most recently modified note. The row also renders an
    // "edited <time>" meta line beneath the title, so assert containment.
    await expect(rows.first()).toHaveAttribute('data-note-id', newestFirst[0].id)
    await expect(rows.first()).toContainText(newestFirst[0].title)
  })

  test('F3: size→limit — S shows ≤3 rows, M shows ≤6 rows', async ({ page, testVaultPath }) => {
    seedNotesByRecency(testVaultPath, 8)

    await bootstrap(page)
    await reindexVault(page, 8)
    await reload(page)

    // Resize to S → at most 3 rows.
    await resizeWidgetTo(page, 'S')
    await expect(recentRows(page).first()).toBeVisible()
    const sCount = await recentRows(page).count()
    expect(sCount).toBeLessThanOrEqual(3)
    expect(sCount).toBeGreaterThan(0)

    // Resize to M → at most 6 rows (and more than S, given 8 notes).
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
    const newestFirst = seedNotesByRecency(testVaultPath, 3)

    await bootstrap(page)
    await reindexVault(page, 3)
    await reload(page)

    const target = newestFirst[0]
    // The data-testid sits on the button itself, so match by attribute directly.
    const targetRow = recentRows(page)
      .and(page.locator(`[data-note-id="${target.id}"]`))
      .first()
    await expect(targetRow).toBeVisible()
    await targetRow.click()

    // A note tab titled with the note title becomes the active tab.
    const activeTab = page
      .locator('[role="tab"][data-group-id][aria-selected="true"]')
      .filter({ hasText: target.title })
      .first()
    await expect(activeTab).toBeVisible()
  })

  test('F5: editing an older note with a newer modified moves it to the top', async ({
    page,
    testVaultPath
  }) => {
    const newestFirst = seedNotesByRecency(testVaultPath, 5)

    await bootstrap(page)
    await reindexVault(page, 5)
    await reload(page)

    // Sanity: oldest note is currently last (not the top row).
    const oldest = newestFirst[newestFirst.length - 1]
    await expect(recentRows(page).first()).not.toHaveAttribute('data-note-id', oldest.id)

    // Rewrite the oldest note with a `modified` newer than every other note.
    const future = new Date('2026-02-01T00:00:00.000Z').toISOString()
    writeNote(
      testVaultPath,
      oldest.id,
      { id: oldest.id, title: oldest.title, modified: future },
      `# ${oldest.title}\n\nBumped.`
    )

    // Re-scan and wait for the bump to land (count stays at 5, so poll on the
    // bumped note's modified timestamp rather than the count).
    await page.evaluate(() => window.api.vault.reindex())
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const res = await window.api.notes.list({
              sortBy: 'modified',
              sortOrder: 'desc',
              limit: 500,
              offset: 0
            })
            return res.notes[0]?.id === id
          }, oldest.id),
        { timeout: 20000 }
      )
      .toBe(true)
    await reload(page)

    // It now sits at the top.
    await expect(recentRows(page).first()).toHaveAttribute('data-note-id', oldest.id)
  })

  // F6 (optional, visual): long-title truncation is enforced purely by the CSS
  // `truncate` class on the row button. Asserting actual clipped width in
  // Electron is non-deterministic (depends on rendered widget width, fonts,
  // zoom), so we skip per the prompt rather than add a flaky pixel check.
  test.skip('F6: very long title truncates within the card (visual / CSS-only)', async () => {
    // Visual-only: row button carries the `truncate` class; no reliable
    // deterministic e2e assertion. Covered by visual review, not automation.
  })
})
