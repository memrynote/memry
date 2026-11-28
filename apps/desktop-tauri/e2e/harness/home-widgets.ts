// The Home widget surfaces the `specs/home/home-widget-*` and `home-journal-widget-*` specs drive
// (Step 30c2, #3547), ported from the helpers of Electron's `tests/e2e/home-widget-*.e2e.ts` and
// `home-journal-widget-*.e2e.ts`. Electron ran those specs on an empty vault (`.memry`, `notes`,
// `journal`), so `test` here builds the same instead of copying `fixtures/test-vault`, whose two
// notes would show up in the Recently edited widget.
import * as fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import matter from 'gray-matter'

import { dismissFirstRunOnboarding } from './app-helpers'
import { appReady } from './app-ready'
import { listedNotes } from './notes'
import { expect } from './pw-compat/expect'
import type { Locator } from './pw-compat/locator'
import type { Page } from './pw-compat/page'
import { removeDir } from './remove-dir'
import { test as baseTest } from './test'
import { invoke } from './vault-commands'

export { expect }

/** The base `test` with `testVaultPath` an empty vault, as Electron's fixture made it. */
export const test = baseTest.extend<{ testVaultPath: string }>({
  testVaultPath: async (_deps, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'memry-e2e-home-'))
    const vault = path.join(root, 'vault')
    for (const dir of ['.memry', 'notes', 'journal'])
      fs.mkdirSync(path.join(vault, dir), { recursive: true })
    try {
      await use(vault)
    } finally {
      removeDir(root)
    }
  }
})

export const HOME_SEL = {
  homePage: '[data-testid="home-page"]',
  grid: '.home-grid',
  widget: '[data-testid="widget"]',
  journalWidget: '[data-testid="widget"][data-widget-type="journal"]',
  gallery: '[data-testid="widget-gallery"]',
  galleryItem: '[data-testid="widget-gallery-item"]',
  addWidgetTrigger: '[data-testid="add-widget-trigger"]',
  tab: '[role="tab"][data-group-id]'
}

export async function bootstrap(page: Page): Promise<void> {
  await appReady(page)
  await dismissFirstRunOnboarding(page)
}

/**
 * Writes a note into `notes/`, named after its title: the title is the file's basename
 * (frontmatter diet, #697), so lookups by title resolve it.
 */
export function writeNoteFile(
  vaultPath: string,
  fileName: string,
  frontmatter: Record<string, unknown>,
  body = ''
): void {
  const notesDir = path.join(vaultPath, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })

  const now = new Date().toISOString()
  // oxlint-disable-next-line typescript/no-base-to-string -- seeded titles are always strings; String() keeps the Electron helper's coercion
  const base = String(frontmatter.title ?? fileName).replace(/\.md$/, '')

  const data: Record<string, unknown> = {
    created: frontmatter.created ?? now,
    modified: frontmatter.modified ?? now,
    tags: frontmatter.tags ?? [],
    ...frontmatter
  }
  delete data.id
  delete data.title

  fs.writeFileSync(path.join(notesDir, `${base}.md`), matter.stringify(body, data))
}

/** Indexes notes seeded on disk after launch with a full scan, then waits for them to list. */
export async function reindexVault(page: Page, expectedCount: number): Promise<void> {
  await invoke(page, 'vault_reindex')
  await expect
    .poll(async () => (await listedNotes(page)).length >= expectedCount, { timeout: 20_000 })
    .toBe(true)
}

/** The real ids of the listed notes, keyed by title. */
export async function noteIdsByTitle(page: Page): Promise<Record<string, string>> {
  return Object.fromEntries((await listedNotes(page)).map((n) => [n.title, n.id]))
}

interface Board {
  id: string
  widgets: Array<{ type: string; h: number | null } & Record<string, unknown>>
}

/**
 * Sets the grid height of every widget of `type` on the board holding one. The board derives the
 * size tier from the row span (h <= 2 is S, h <= 4 is M, else L): height is the size.
 */
export async function setWidgetHeight(page: Page, type: string, h: number): Promise<void> {
  const boards = await invoke<Board[]>(page, 'home_pages_list')
  const board = boards.find((b) => b.widgets.some((w) => w.type === type))
  if (!board) throw new Error(`no board with a ${type} widget`)
  const widgets = board.widgets.map((w) => (w.type === type ? { ...w, h } : w))
  await invoke(page, 'home_pages_update', { input: { id: board.id, widgets } })
}

/** The Home board as it lands, with its two seeded widgets. */
export async function homeReady(page: Page): Promise<void> {
  await bootstrap(page)
  await expect(page.locator(HOME_SEL.homePage)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(`${HOME_SEL.grid} ${HOME_SEL.widget}`)).toHaveCount(2, {
    timeout: 20_000
  })
}

export async function addJournalWidget(page: Page): Promise<Locator> {
  const trigger = page.locator(HOME_SEL.addWidgetTrigger)
  await expect(trigger).toBeVisible({ timeout: 20_000 })
  await trigger.click()
  await expect(page.locator(HOME_SEL.gallery)).toBeVisible({ timeout: 20_000 })
  await page.locator(`${HOME_SEL.galleryItem}[data-widget-type="journal"]`).click()
  await expect(page.locator(HOME_SEL.gallery)).toBeHidden({ timeout: 20_000 })
  const widget = page.locator(HOME_SEL.journalWidget)
  await expect(widget).toBeVisible({ timeout: 20_000 })
  return widget
}

/** A local calendar date `offset` days from today, as the journal widget derives it. */
export function localIsoInDays(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

/** Writes a journal day through the command the journal editor's autosave calls. */
export async function writeJournalEntry(page: Page, date: string, content: string): Promise<void> {
  await invoke(page, 'journal_update_entry', { input: { date, content } })
}
