// The folder view (Step 30b, #3547), ported case by case from Electron's `folder-view.e2e.ts`
// (T124 to T135 and the #2073 PDF case). Electron guarded almost every assertion behind an
// `isVisible` check; each case here asserts what the user sees and what lands in `.folder.md`.
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  DEFAULT_COLUMNS,
  DEFAULT_VIEW,
  PROJECT_FOLDER,
  PROJECT_NOTES,
  folderConfigPath,
  folderHeader,
  folderViews,
  openFolderView,
  readFolderConfig,
  seedBulkNotes,
  seedProjectNotes,
  tableRow,
  toggleColumn,
  writeFolderConfig,
  writeNoteFile
} from '../../harness/folder-view'
import type { Page } from '../../harness/pw-compat/page'
import { ACTIVE_TAB } from '../../harness/tags'
import { test as base, expect } from '../../harness/test'

const TABS = '[role="tab"][data-group-id]'
const ALPHA = PROJECT_NOTES[0].title

/** The vault holds the three project notes before the app opens it. */
const test = base.extend<{ testVaultPath: string }>({
  testVaultPath: async ({ testVaultPath }, use) => {
    seedProjectNotes(testVaultPath)
    await use(testVaultPath)
  }
})

const viewSwitcher = (page: Page, name: string) =>
  page.locator('header').getByRole('button', { name, exact: true })

test.describe('Folder View', () => {
  test('T124: should open folder view when clicking folder', async ({ page }) => {
    await openFolderView(page, PROJECT_FOLDER)

    await expect(folderHeader(page, PROJECT_FOLDER)).toContainText('3 notes')
    await expect(page.getByRole('table')).toBeVisible()
    for (const note of PROJECT_NOTES) await expect(tableRow(page, note.title)).toBeVisible()
  })

  test('T125: should show notes with properties in the table', async ({ page }) => {
    await openFolderView(page, PROJECT_FOLDER)
    await toggleColumn(page, 'status')
    await toggleColumn(page, 'priority')

    const alpha = tableRow(page, ALPHA)
    await expect(alpha).toContainText('active')
    await expect(alpha).toContainText('4')
  })

  test('T126: should persist column add/remove in .folder.md', async ({ page, testVaultPath }) => {
    const columnIds = () =>
      (folderViews(testVaultPath, PROJECT_FOLDER)[0]?.columns ?? []).map((c) => c.id)
    await openFolderView(page, PROJECT_FOLDER)

    await toggleColumn(page, 'status')
    await expect.poll(columnIds).toContain('status')

    await toggleColumn(page, 'status')
    await expect.poll(() => columnIds().includes('status')).toBe(false)
  })

  // The reorder half of T126. A WebDriver pointer drag (stepped, with pauses past the 5 px
  // activation distance) does not start dnd-kit's PointerSensor in WKWebView, and the keyboard
  // sensor is unreachable: the handle's onKeyDown stops Space and Enter after spreading dnd-kit's
  // listeners (main the same). Owner: Step 30 (#3547), Low on #4278.
  test.fixme('T126: should persist column reorder in .folder.md', async () => {})

  test('T127: should persist sorting configuration', async ({ page, testVaultPath }) => {
    await openFolderView(page, PROJECT_FOLDER)

    await page.locator('th').filter({ hasText: 'Title' }).first().click()
    await expect
      .poll(() =>
        (folderViews(testVaultPath, PROJECT_FOLDER)[0]?.order ?? []).map((entry) => entry.property)
      )
      .toContain('title')
  })

  test('T128: should apply AND/OR/NOT filters from config', async ({ page, testVaultPath }) => {
    writeFolderConfig(testVaultPath, PROJECT_FOLDER, {
      views: [
        {
          ...DEFAULT_VIEW,
          filters: {
            and: [{ not: 'status == "archived"' }, { or: ['priority >= 3', 'done isChecked'] }]
          }
        }
      ]
    })
    await openFolderView(page, PROJECT_FOLDER)

    // Alpha passes on priority, Beta on done; Gamma is archived.
    await expect(folderHeader(page, PROJECT_FOLDER)).toContainText('2 of 3 notes')
    await expect(tableRow(page, ALPHA)).toBeVisible()
    await expect(tableRow(page, 'Project Beta')).toBeVisible()
    await expect(page.locator('tbody tr').filter({ hasText: 'Project Gamma' })).toHaveCount(0)
  })

  // The first view made on a folder without `.folder.md` replaces the implicit Default on disk,
  // so its name editor renames index 1 of a one-view list and the name never sticks. Main does
  // the same (shared renderer and SET_VIEW semantics). Owner: Step 30 (#3547), Low on #4278.
  test.fixme('T129: should support multiple named views', async ({ page, testVaultPath }) => {
    await openFolderView(page, PROJECT_FOLDER)

    // A new view opens its name editor; the user names it there.
    await viewSwitcher(page, 'Default').click()
    await page.getByRole('button', { name: 'New view', exact: true }).click()
    await page.getByPlaceholder('My Custom View').fill('Review View')
    await page.keyboard.press('Enter')
    await expect(viewSwitcher(page, 'Review View')).toBeVisible()
    await page.keyboard.press('Escape')

    // The implicit Default is not on disk until a view is saved, so the named view is the file's
    // first (main's SET_VIEW does the same); a second one makes the folder's views plural.
    await viewSwitcher(page, 'Review View').click()
    await page.getByRole('button', { name: 'New view', exact: true }).click()
    await expect(viewSwitcher(page, 'New view')).toBeVisible()
    await expect
      .poll(() => folderViews(testVaultPath, PROJECT_FOLDER).map((view) => view.name))
      .toEqual(['Review View', 'New view'])
  })

  test('T130: should open note in a new tab on double click', async ({ page }) => {
    await openFolderView(page, PROJECT_FOLDER)

    await tableRow(page, ALPHA).dblclick()
    await expect(page.locator(TABS).filter({ hasText: ALPHA }).first()).toBeVisible()
    await expect(page.locator(ACTIVE_TAB).first()).toContainText(ALPHA)
  })

  test('T131: should react to manual .folder.md edits', async ({ page, testVaultPath }) => {
    await openFolderView(page, PROJECT_FOLDER)

    const existing = readFolderConfig(testVaultPath, PROJECT_FOLDER) ?? {}
    const views = (existing.views as unknown[] | undefined) ?? [DEFAULT_VIEW]
    writeFolderConfig(testVaultPath, PROJECT_FOLDER, {
      ...existing,
      views: [
        ...views,
        {
          name: 'Manual View',
          type: 'table',
          columns: DEFAULT_COLUMNS,
          order: [{ property: 'modified', direction: 'desc' }]
        }
      ]
    })

    // As in Electron, an external edit reaches an open page through the views query's window
    // focus refetch (T122) once its 30 s staleTime has passed: the user comes back to the app.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
          await viewSwitcher(page, 'Default').click()
          const listed = await page
            .getByRole('button', { name: 'Manual View', exact: true })
            .count()
          await page.keyboard.press('Escape')
          return listed
        },
        { timeout: 60_000, intervals: [2000] }
      )
      .toBe(1)
  })

  test('T133: should load .folder.md from a synced folder copy', async ({
    page,
    testVaultPath
  }) => {
    const synced = 'Synced'
    await openFolderView(page, PROJECT_FOLDER)

    // A sync brings a folder whose `.folder.md` is a copy of another folder's.
    writeFolderConfig(testVaultPath, PROJECT_FOLDER, {
      views: [
        {
          name: 'Synced View',
          type: 'table',
          default: true,
          columns: DEFAULT_COLUMNS,
          order: [{ property: 'modified', direction: 'desc' }]
        }
      ]
    })
    fs.mkdirSync(path.join(testVaultPath, synced), { recursive: true })
    fs.copyFileSync(
      folderConfigPath(testVaultPath, PROJECT_FOLDER),
      folderConfigPath(testVaultPath, synced)
    )
    writeNoteFile(
      testVaultPath,
      synced,
      'Synced Note.md',
      { id: 'synced-1', title: 'Synced Note', tags: ['sync'] },
      '# Synced Note'
    )

    await openFolderView(page, synced)
    await expect(viewSwitcher(page, 'Synced View')).toBeVisible()
    await expect(tableRow(page, 'Synced Note')).toBeVisible()
  })

  test('T134: should switch view type (table/list/gallery) and persist to .folder.md', async ({
    page,
    testVaultPath
  }) => {
    await openFolderView(page, PROJECT_FOLDER)

    // Electron's Board case is gone from the product: the layout toggle offers table, list,
    // gallery and chart on both apps, and its spec skipped the missing button.
    const cases = [
      { label: 'List', type: 'list', table: false },
      { label: 'Gallery', type: 'grid', table: false },
      { label: 'Table', type: 'table', table: true }
    ] as const
    for (const { label, type, table } of cases) {
      const button = page.locator(`header button[title="${label}"]`)
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => folderViews(testVaultPath, PROJECT_FOLDER)[0]?.type).toBe(type)
      await expect(page.getByRole('table')).toHaveCount(table ? 1 : 0)
      await expect(page.getByText(ALPHA).first()).toBeVisible()
    }
  })

  test('T135: should show the no-results empty state when search matches nothing', async ({
    page
  }) => {
    await openFolderView(page, PROJECT_FOLDER)

    await page.locator('header').getByRole('button', { name: 'Search notes...' }).click()
    await page.getByPlaceholder('Search notes...').fill('zzz-no-such-note-xyz')
    await expect(page.getByText('No matching notes')).toBeVisible()

    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(page.getByText('No matching notes')).toBeHidden()
    await expect(page.locator('tbody tr')).toHaveCount(PROJECT_NOTES.length)
  })
})

test.describe('Folder View Performance', () => {
  const bulkTest = base.extend<{ testVaultPath: string }>({
    testVaultPath: async ({ testVaultPath }, use) => {
      seedBulkNotes(testVaultPath, 'Bulk', 120)
      await use(testVaultPath)
    }
  })

  bulkTest('T132: should handle folders with 100+ notes', async ({ page }) => {
    await openFolderView(page, 'Bulk')
    await expect(folderHeader(page, 'Bulk')).toContainText('120 notes', { timeout: 30_000 })
    await expect(page.locator('tbody tr').first()).toBeVisible()
  })
})

/**
 * #2073: a real (tiny) PDF in the folder. The table renders it as a row next to the notes, and the
 * tag and property cells there used to run it through the markdown serializer and overwrite it.
 */
test.describe('Folder View — binary rows (#2073)', () => {
  const PDF_NAME = 'invoice-2073.pdf'
  const PDF_BYTES = Buffer.from(
    '255044462d312e340a25e2e3cfd30a312030206f626a0a3c3c2f547970652f436174616c6f673e3e0a' +
      '656e646f626a0a747261696c65720a3c3c2f526f6f742031203020523e3e0a2525454f460a',
    'hex'
  )
  const pdfTest = base.extend<{ testVaultPath: string }>({
    testVaultPath: async ({ testVaultPath }, use) => {
      seedProjectNotes(testVaultPath)
      fs.writeFileSync(path.join(testVaultPath, PROJECT_FOLDER, PDF_NAME), PDF_BYTES)
      await use(testVaultPath)
    }
  })

  // Tauri indexes no binary vault file: the PDF is in neither `notes_list`, the tree nor the
  // folder view, before or after launch. Owner: Step 13 (#3530), note_metadata file items.
  pdfTest.fixme(
    'a bulk tag add over a PDF row leaves the PDF byte-for-byte intact',
    async ({ page, testVaultPath }) => {
      const pdfPath = path.join(testVaultPath, PROJECT_FOLDER, PDF_NAME)
      const alphaPath = path.join(testVaultPath, PROJECT_FOLDER, `${ALPHA}.md`)
      await openFolderView(page, PROJECT_FOLDER)
      await expect(tableRow(page, PDF_NAME.replace(/\.pdf$/, ''))).toBeVisible()

      await page.getByRole('checkbox', { name: 'Select all notes' }).click({ force: true })
      await page.getByRole('button', { name: 'Add tag', exact: true }).click()
      await page.getByPlaceholder('Tag name').fill('audited')
      await page.keyboard.press('Enter')

      // The walk reached the notes, and the PDF beside them is untouched.
      await expect.poll(() => fs.readFileSync(alphaPath, 'utf8')).toMatch(/- audited/)
      expect(Buffer.compare(fs.readFileSync(pdfPath), PDF_BYTES)).toBe(0)
    }
  )
})
