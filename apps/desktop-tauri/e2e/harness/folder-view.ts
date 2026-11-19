// The folder view surfaces the folder-view spec drives (Step 30b, #3547), ported from Electron's
// `folder-view.e2e.ts` helpers: notes and `.folder.md` seeded as files on disk, the config read
// back from disk, and the folder view opened from the Collections tree as a user opens it. Tauri's
// notes root is the vault root (`notes/` is an ordinary folder there), so Electron's
// `notes/Projects` is `Projects` here.
import * as fs from 'node:fs'
import * as path from 'node:path'

import matter from 'gray-matter'

import { expandCollections, treeRow, vaultOpen } from './notes'
import { expect } from './pw-compat/expect'
import type { Page } from './pw-compat/page'

export const DEFAULT_COLUMNS = [
  { id: 'title', width: 250 },
  { id: 'folder', width: 120 },
  { id: 'tags', width: 150 },
  { id: 'modified', width: 130 }
]

export const DEFAULT_VIEW = {
  name: 'Default',
  type: 'table',
  default: true,
  columns: DEFAULT_COLUMNS,
  order: [{ property: 'modified', direction: 'desc' }],
  showSummaries: true
}

export const PROJECT_FOLDER = 'Projects'

export const PROJECT_NOTES = [
  {
    id: 'proj-alpha',
    title: 'Project Alpha',
    tags: ['alpha', 'active'],
    status: 'active',
    priority: 4,
    done: false,
    due: '2025-01-02',
    url: 'https://example.com/alpha',
    labels: ['alpha', 'roadmap']
  },
  {
    id: 'proj-beta',
    title: 'Project Beta',
    tags: ['beta'],
    status: 'done',
    priority: 1,
    done: true,
    due: '2025-02-01',
    url: 'https://example.com/beta',
    labels: ['beta']
  },
  {
    id: 'proj-gamma',
    title: 'Project Gamma',
    tags: ['gamma', 'blocked'],
    status: 'archived',
    priority: 2,
    done: false,
    due: '2025-03-01',
    url: 'https://example.com/gamma',
    labels: ['blocked']
  }
]

export interface FolderView {
  name: string
  type?: string
  columns?: Array<{ id: string }>
  order?: Array<{ property: string; direction?: string }>
}

export function writeNoteFile(
  vaultPath: string,
  folderPath: string,
  fileName: string,
  frontmatter: Record<string, unknown>,
  body = ''
): string {
  const dir = path.join(vaultPath, folderPath)
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  const data = {
    title: fileName.replace(/\.md$/, ''),
    created: now,
    modified: now,
    tags: [],
    ...frontmatter
  }
  const notePath = path.join(dir, fileName)
  fs.writeFileSync(notePath, matter.stringify(body, data))
  return notePath
}

export function seedProjectNotes(vaultPath: string): void {
  for (const note of PROJECT_NOTES) {
    writeNoteFile(
      vaultPath,
      PROJECT_FOLDER,
      // The file name is the title: Tauri and Electron read a note's title from its path.
      `${note.title}.md`,
      note,
      `# ${note.title}\n\nFolder view test note.`
    )
  }
}

export function seedBulkNotes(vaultPath: string, folderPath: string, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    writeNoteFile(
      vaultPath,
      folderPath,
      `Bulk Note ${i}.md`,
      { id: `bulk-${i}`, title: `Bulk Note ${i}`, tags: ['bulk'], priority: (i % 5) + 1 },
      `# Bulk Note ${i}\n\nPerformance test note.`
    )
  }
}

export const folderConfigPath = (vaultPath: string, folderPath: string): string =>
  path.join(vaultPath, folderPath, '.folder.md')

export function writeFolderConfig(
  vaultPath: string,
  folderPath: string,
  config: Record<string, unknown>
): void {
  fs.mkdirSync(path.join(vaultPath, folderPath), { recursive: true })
  fs.writeFileSync(folderConfigPath(vaultPath, folderPath), matter.stringify('', config))
}

export function readFolderConfig(
  vaultPath: string,
  folderPath: string
): Record<string, unknown> | null {
  const file = folderConfigPath(vaultPath, folderPath)
  if (!fs.existsSync(file)) return null
  // A fresh object: gray-matter caches a parse by its input string.
  return { ...matter(fs.readFileSync(file, 'utf-8')).data }
}

/** The views `.folder.md` holds on disk; empty while the file is absent. */
export const folderViews = (vaultPath: string, folderPath: string): FolderView[] =>
  (readFolderConfig(vaultPath, folderPath)?.views as FolderView[] | undefined) ?? []

/** The folder page's header: the breadcrumb, the note count and the toolbar. */
export const folderHeader = (page: Page, folderName: string) =>
  page.locator('header').filter({ hasText: folderName }).first()

/**
 * Opens the folder's view from the Collections tree. A plain click on a folder row only expands
 * it; the view has its own button on the row, transparent until hover. WKWebView sets no `:hover`
 * for a WebDriver pointer and the row's key handler takes Enter, so the button is clicked through
 * its transparency, as Electron's spec did.
 */
export async function openFolderView(page: Page, folderPath: string): Promise<void> {
  await vaultOpen(page)
  await expandCollections(page)
  const row = treeRow(page, `folder-${folderPath}`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: 'Open folder view' }).click({ force: true })
  await expect(folderHeader(page, folderPath.split('/').pop()!)).toBeVisible({ timeout: 20_000 })
}

/** Opens the Properties popover and toggles the column `id`, as a user ticks its box. */
export async function toggleColumn(page: Page, id: string): Promise<void> {
  await page.getByRole('button', { name: 'Properties' }).click()
  const search = page.getByPlaceholder('Search columns...')
  await expect(search).toBeVisible()
  await search.fill(id)
  await page.locator(`#col-${id}`).click()
  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()
}

/** The table body row that shows `title`. */
export const tableRow = (page: Page, title: string) =>
  page.locator('tbody tr').filter({ hasText: title }).first()
