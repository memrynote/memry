/**
 * A new note has to show up in the sidebar where it landed.
 *
 * The reported case: two folders, `movies` set as the default location for new
 * notes, "create in selected folder" off, `movies` shut. ⌘N — or any of the "+"
 * surfaces — put the note inside `movies` and opened it in a tab, but the
 * sidebar never opened the folder, so the note was nowhere on screen.
 *
 * This runs against the real app because every unit-level check of the reveal
 * passed while the app stayed shut: the fixtures spelled note paths with a
 * vault-root prefix (`notes/Work/Alpha.md` next to a folder at `Work`) that
 * real vault-relative paths do not have, so a reveal that dropped the first
 * path segment looked correct in a test and expanded nothing in the app.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, SHORTCUTS } from './utils/electron-helpers'

const DEFAULT_FOLDER = 'movies'
const NESTED_DEFAULT_FOLDER = 'movies/2026'

interface SeededNote {
  id: string
  path: string
}

/**
 * Point new notes at `folder` and take the selection out of the equation, the
 * way the report describes it. Changing the default folder rebuilds the index,
 * so the tree is only trustworthy once that settles.
 */
async function useDefaultNoteFolder(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (target) => {
    const preload = (window as unknown as { api: Record<string, any> }).api
    await preload.vault.updateConfig({ defaultNoteFolder: target })
    await preload.settings.setGeneralSettings({ createInSelectedFolder: false })
  }, folder)

  await page.waitForFunction(
    async () => {
      const preload = (window as unknown as { api: Record<string, any> }).api
      const status = await preload.vault.getStatus()
      return status?.isOpen === true && status?.isIndexing !== true
    },
    undefined,
    { timeout: 30_000, polling: 250 }
  )
}

/**
 * A note already living in the folder. Its row is the proof the folder opened:
 * a shut folder renders no children at all, so this row existing means the
 * folder is open — independent of where the new note's own row ends up.
 */
async function seedNoteInFolder(page: Page, folder: string, title: string): Promise<SeededNote> {
  const seeded = await page.evaluate(
    async ({ target, noteTitle }) => {
      const preload = (window as unknown as { api: Record<string, any> }).api
      const result = await preload.notes.create({
        title: noteTitle,
        content: 'Seeded by the reveal test.',
        folder: target
      })
      return result?.note ? { id: result.note.id, path: result.note.path } : null
    },
    { target: folder, noteTitle: title }
  )

  if (!seeded) throw new Error(`seedNoteInFolder: notes.create returned no note for "${title}"`)
  // Guards the premise: if creation stopped honouring `folder`, every assertion
  // below would be about the wrong tree.
  expect(seeded.path.startsWith(`${folder}/`)).toBe(true)
  return seeded as SeededNote
}

/** The id of the newest note under `folder` that is not already known. */
async function waitForNoteIn(page: Page, folder: string, known: string[]): Promise<string> {
  const handle = await page.waitForFunction(
    async ({ target, seen }) => {
      const preload = (window as unknown as { api: Record<string, any> }).api
      const result = await preload.notes.list({})
      const match = (result?.notes ?? []).find(
        (note: { id: string; path: string }) =>
          note.path.startsWith(`${target}/`) && !seen.includes(note.id)
      )
      return match ? match.id : null
    },
    { target: folder, seen: known },
    { timeout: 20_000, polling: 250 }
  )

  return (await handle.jsonValue()) as string
}

const collectionsHeader = (page: Page) => page.getByRole('button', { name: /^Collections section/ })

const treeRow = (page: Page, nodeId: string) => page.locator(`[data-tree-node-id="${nodeId}"]`)

/** The Collections section ships collapsed on a fresh profile (#625 tour). */
async function openCollections(page: Page): Promise<void> {
  const header = collectionsHeader(page)
  await header.waitFor({ state: 'visible', timeout: 20_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

/** Click the folder row to shut it again, so the next case starts from closed. */
async function collapseFolder(page: Page, folderPath: string, childRowId: string): Promise<void> {
  await treeRow(page, `folder-${folderPath}`).click()
  await expect(treeRow(page, childRowId)).toHaveCount(0)
}

test.describe('New note reveals itself in the sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('⌘N opens the default folder and shows the note it just put there', async ({ page }) => {
    await useDefaultNoteFolder(page, DEFAULT_FOLDER)
    const seed = await seedNoteInFolder(page, DEFAULT_FOLDER, 'Existing')
    await openCollections(page)

    // Precondition: the folder is on screen and shut, so nothing inside it is.
    await expect(treeRow(page, `folder-${DEFAULT_FOLDER}`)).toBeVisible()
    await expect(treeRow(page, seed.id)).toHaveCount(0)

    await page.keyboard.press(SHORTCUTS.newNote)

    const createdId = await waitForNoteIn(page, DEFAULT_FOLDER, [seed.id])
    await expect(treeRow(page, seed.id)).toBeVisible()
    await expect(treeRow(page, createdId)).toBeVisible()
  })

  test('the sidebar "+" surfaces reveal the note too', async ({ page }) => {
    await useDefaultNoteFolder(page, DEFAULT_FOLDER)
    const seed = await seedNoteInFolder(page, DEFAULT_FOLDER, 'Existing')
    await openCollections(page)
    await expect(treeRow(page, seed.id)).toHaveCount(0)

    // 1. The persistent "New" button in the sidebar header.
    await page.locator('[data-tour="new-note"]').click()
    const fromHeader = await waitForNoteIn(page, DEFAULT_FOLDER, [seed.id])
    await expect(treeRow(page, seed.id)).toBeVisible()
    await expect(treeRow(page, fromHeader)).toBeVisible()

    await collapseFolder(page, DEFAULT_FOLDER, seed.id)

    // 2. The "New note" icon on the Collections header, which creates through
    //    the tree's own action rather than the sidebar's.
    await collectionsHeader(page).hover()
    await page.getByRole('button', { name: 'New note', exact: true }).first().click()
    const fromTreeIcon = await waitForNoteIn(page, DEFAULT_FOLDER, [seed.id, fromHeader])
    await expect(treeRow(page, seed.id)).toBeVisible()
    await expect(treeRow(page, fromTreeIcon)).toBeVisible()
  })

  test('a nested default folder opens every level down to the note', async ({ page }) => {
    await useDefaultNoteFolder(page, NESTED_DEFAULT_FOLDER)
    const seed = await seedNoteInFolder(page, NESTED_DEFAULT_FOLDER, 'Existing')
    await openCollections(page)

    await expect(treeRow(page, `folder-${DEFAULT_FOLDER}`)).toBeVisible()
    await expect(treeRow(page, `folder-${NESTED_DEFAULT_FOLDER}`)).toHaveCount(0)
    await expect(treeRow(page, seed.id)).toHaveCount(0)

    await page.keyboard.press(SHORTCUTS.newNote)

    const createdId = await waitForNoteIn(page, NESTED_DEFAULT_FOLDER, [seed.id])
    await expect(treeRow(page, `folder-${NESTED_DEFAULT_FOLDER}`)).toBeVisible()
    await expect(treeRow(page, seed.id)).toBeVisible()
    await expect(treeRow(page, createdId)).toBeVisible()
  })
})
