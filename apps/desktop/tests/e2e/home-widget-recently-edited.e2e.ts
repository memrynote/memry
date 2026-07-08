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
 * <testVaultPath>/notes/, mirroring folder-view.e2e.ts, then a manual reindex
 * picks them up. Post frontmatter-diet (#697) a note's title comes from the
 * filename and its id/modified from the index (in-file keys are ignored), so we
 * name each file after its title and resolve real ids via the notes RPC.
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

/** Write a note markdown file into notes/, named after its title. */
function writeNote(
  vaultPath: string,
  fileName: string,
  frontmatter: Record<string, unknown>,
  body = ''
): void {
  const notesDir = path.join(vaultPath, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })

  const now = new Date().toISOString()
  // Post frontmatter-diet (#697) a note's title comes from the filename basename,
  // not an in-file `title:` key — name the file after the requested title so
  // lookups by title resolve it.
  const base = String(frontmatter.title ?? fileName).replace(/\.md$/, '')
  const normalizedName = `${base}.md`

  const data = {
    created: frontmatter.created ?? now,
    modified: frontmatter.modified ?? now,
    tags: frontmatter.tags ?? [],
    ...frontmatter
  }
  delete (data as Record<string, unknown>).id
  delete (data as Record<string, unknown>).title

  fs.writeFileSync(path.join(notesDir, normalizedName), matter.stringify(body, data))
}

/**
 * Seed `count` notes as markdown files. Returns the list newest-first (later
 * index → intended-more-recent). Real ids are resolved after reindex via
 * resolveIds(); the returned `id` is a placeholder until then.
 */
function seedNotesByRecency(
  vaultPath: string,
  count: number
): Array<{ id: string; title: string }> {
  const seeded: Array<{ id: string; title: string }> = []
  for (let i = 0; i < count; i += 1) {
    const title = `Recent Note ${i + 1}`
    writeNote(vaultPath, title, { title }, `# ${title}\n\nRecency seed.`)
    seeded.push({ id: '', title })
  }
  // Newest-first.
  return seeded.reverse()
}

/**
 * Fill each seeded row's `id` with the note's REAL id (the index assigns a fresh
 * id; the in-file frontmatter id is ignored post frontmatter-diet). Matches on
 * the filename-derived title. Call after the vault has been reindexed.
 */
async function resolveIds(page, rows: Array<{ id: string; title: string }>): Promise<void> {
  const byTitle = await page.evaluate(async () => {
    const res = await window.api.notes.list({
      sortBy: 'modified',
      sortOrder: 'desc',
      limit: 500,
      offset: 0
    })
    return Object.fromEntries(res.notes.map((n: { id: string; title: string }) => [n.title, n.id]))
  })
  for (const row of rows) row.id = byTitle[row.title] ?? row.id
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
 * test body writes any files, and the chokidar watcher does not reliably pick up
 * a burst of post-launch writes. `window.api.vault.reindex()` runs a full
 * main-process scan; we poll the notes RPC until the expected count is present.
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

  // FIXME: recency ORDER can't be seeded deterministically in this harness. A
  // note's modified time is its file mtime (dates come from fs stats, not an
  // in-file key), and sub-ms sync writes tie at ms resolution. Every way to force
  // distinct mtimes — utimes, spaced file writes, or per-note API creates while
  // the Home widgets are mounted — stalls the vault watcher's reindex. F3/F4/F1
  // still cover the widget; ordering needs a harness-level fix (e.g. a test-only
  // API to set modified) before this can be re-enabled.
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
    const seeded = seedNotesByRecency(testVaultPath, 3)
    await bootstrap(page)
    await reindexVault(page, 3)
    await resolveIds(page, seeded)
    await reload(page)

    // Match a seeded note's row by its real id (position-independent).
    const target = seeded[0]
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

  // FIXME: same harness limitation as F2 — this asserts a strict recency order
  // (oldest starts last, jumps to top after an edit), which the seed can't make
  // deterministic without stalling the watcher. See the F2 note above.
  test.fixme('F5: editing an older note with a newer modified moves it to the top', async ({
    page,
    testVaultPath
  }) => {
    const newestFirst = seedNotesByRecency(testVaultPath, 5)
    await bootstrap(page)
    await reindexVault(page, 5)
    await resolveIds(page, newestFirst)
    await reload(page)

    // Sanity: oldest note is currently last (not the top row).
    const oldest = newestFirst[newestFirst.length - 1]
    await expect(recentRows(page).first()).not.toHaveAttribute('data-note-id', oldest.id)

    // Editing the oldest note bumps its `modified` to now — newer than every
    // other note — so it should jump to the top.
    await page.evaluate((id) => window.api.notes.update({ id, content: 'Bumped.' }), oldest.id)
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
