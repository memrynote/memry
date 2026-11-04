// A new note shows up in the sidebar where it landed (Step 13f, #3530), ported from Electron's
// `sidebar-reveal-new-note.e2e.ts`. The report: `movies` is the vault's default folder for new
// notes and is shut; Cmd-N, or any "+" surface, put the note inside it and opened it in a tab,
// but the sidebar never opened the folder, so the note was nowhere on screen. Unit checks of the
// reveal passed while the app stayed shut, because their fixtures spelled paths with a prefix
// real vault-relative paths lack, so this runs against the real app.
//
// The default folder is the vault config's `defaultNoteFolder`, which `notes_create` reads at
// each create; the spec writes it to `.memry/config.json` as the settings page saves it.
// Electron also turned "create in selected folder" off. The Tauri renderer does not read the
// general settings yet (Step 09, #3526), so that setting keeps its default, on, and nothing is
// selected before the first create.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SHORTCUTS } from '../../harness/app-helpers'
import {
  type NoteView,
  createNote,
  expandCollections,
  listedIds,
  treeRow,
  vaultOpen
} from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const DEFAULT_FOLDER = 'movies'
const NESTED_DEFAULT_FOLDER = 'movies/2026'

function useDefaultNoteFolder(vault: string, folder: string): void {
  const file = join(vault, '.memry', 'config.json')
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...config, defaultNoteFolder: folder }, null, 2))
}

/**
 * A note already in the folder. Its row proves the folder opened: a shut folder renders no
 * children, whatever happens to the new note's own row.
 */
async function seedNoteInFolder(page: Page, folder: string): Promise<NoteView> {
  const seeded = await createNote(page, {
    title: 'Existing',
    content: 'Seeded by the reveal test.',
    folder
  })
  // If the create stopped honouring `folder`, every assertion below would be about the wrong
  // tree.
  expect(seeded.path.startsWith(`${folder}/`)).toBe(true)
  return seeded
}

/** The id of the note that is new since `known`, once it is listed; its path is under `folder`. */
async function createdIn(page: Page, folder: string, known: string[]): Promise<string> {
  let created: string | undefined
  await expect
    .poll(async () => {
      created = (await listedIds(page)).find((id) => !known.includes(id))
      return created
    })
    .not.toBe(undefined)
  const note = await invoke<NoteView>(page, 'notes_get', { id: created })
  expect(note.path.startsWith(`${folder}/`)).toBe(true)
  return created as string
}

async function collapseFolder(page: Page, folder: string, childId: string): Promise<void> {
  await treeRow(page, `folder-${folder}`).getByRole('button', { name: 'Collapse folder' }).click()
  await expect(treeRow(page, childId)).toHaveCount(0)
}

test('Cmd-N opens the default folder and shows the note it just put there', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  useDefaultNoteFolder(testVaultPath, DEFAULT_FOLDER)
  const seed = await seedNoteInFolder(page, DEFAULT_FOLDER)
  const known = await listedIds(page)
  await expandCollections(page)

  // The folder is on screen and shut, so nothing inside it is.
  await expect(treeRow(page, `folder-${DEFAULT_FOLDER}`)).toBeVisible()
  await expect(treeRow(page, seed.id)).toHaveCount(0)

  await page.keyboard.press(SHORTCUTS.newNote)

  const created = await createdIn(page, DEFAULT_FOLDER, known)
  await expect(treeRow(page, seed.id)).toBeVisible()
  await expect(treeRow(page, created)).toBeVisible()
})

test('the sidebar "+" surfaces reveal the note too', async ({ page, testVaultPath }) => {
  await vaultOpen(page)
  useDefaultNoteFolder(testVaultPath, DEFAULT_FOLDER)
  const seed = await seedNoteInFolder(page, DEFAULT_FOLDER)
  await expandCollections(page)
  await expect(treeRow(page, seed.id)).toHaveCount(0)

  // 1. The "New" button in the sidebar header.
  const beforeHeader = await listedIds(page)
  await page.locator('[data-tour="new-note"]').click()
  const fromHeader = await createdIn(page, DEFAULT_FOLDER, beforeHeader)
  await expect(treeRow(page, seed.id)).toBeVisible()
  await expect(treeRow(page, fromHeader)).toBeVisible()

  await collapseFolder(page, DEFAULT_FOLDER, seed.id)

  // 2. The "New note" icon on the Collections header, which creates through the tree's own
  //    action rather than the sidebar's.
  const beforeTreeIcon = await listedIds(page)
  await page.locator('#section-header-collections').hover()
  await page.getByRole('button', { name: 'New note', exact: true }).first().click()
  const fromTreeIcon = await createdIn(page, DEFAULT_FOLDER, beforeTreeIcon)
  await expect(treeRow(page, seed.id)).toBeVisible()
  await expect(treeRow(page, fromTreeIcon)).toBeVisible()
})

test('a nested default folder opens every level down to the note', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  useDefaultNoteFolder(testVaultPath, NESTED_DEFAULT_FOLDER)
  const seed = await seedNoteInFolder(page, NESTED_DEFAULT_FOLDER)
  const known = await listedIds(page)
  await expandCollections(page)

  await expect(treeRow(page, `folder-${DEFAULT_FOLDER}`)).toBeVisible()
  await expect(treeRow(page, `folder-${NESTED_DEFAULT_FOLDER}`)).toHaveCount(0)
  await expect(treeRow(page, seed.id)).toHaveCount(0)

  await page.keyboard.press(SHORTCUTS.newNote)

  const created = await createdIn(page, NESTED_DEFAULT_FOLDER, known)
  await expect(treeRow(page, `folder-${NESTED_DEFAULT_FOLDER}`)).toBeVisible()
  await expect(treeRow(page, seed.id)).toBeVisible()
  await expect(treeRow(page, created)).toBeVisible()
})
