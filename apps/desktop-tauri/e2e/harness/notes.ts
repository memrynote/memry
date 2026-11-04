// The note surfaces the notes CRUD specs drive (Step 13f, #3530): notes made and read through the
// commands the renderer calls, and a note opened from the Collections tree as a user opens one.
import { expect } from './pw-compat/expect'
import type { Page } from './pw-compat/page'
import { invoke, vaultStatus } from './vault-commands'
import { pollUntil } from './wait'

export interface NoteView {
  id: string
  path: string
  title: string
  content: string
  tags: string[]
  headerTags: string[]
  properties: Record<string, unknown>
  emoji: string | null
}

export interface NoteInput {
  title: string
  content?: string
  folder?: string
  tags?: string[]
  properties?: Record<string, unknown>
  emoji?: string
}

export const NOTE_TITLE = 'textarea[aria-label="Note title"]'
export const NOTE_EDITOR = '[aria-label="Rich text editor"] [contenteditable="true"]'

export async function vaultOpen(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

export const createNote = (page: Page, input: NoteInput) =>
  invoke<NoteView>(page, 'notes_create', { input })

export const getNote = (page: Page, id: string) =>
  invoke<NoteView | null>(page, 'notes_get', { id })

export const getNoteByPath = (page: Page, path: string) =>
  invoke<NoteView | null>(page, 'notes_get_by_path', { path })

/** The ids of every note the vault lists. */
export async function listedIds(page: Page): Promise<string[]> {
  const list = await invoke<{ notes: { id: string }[] }>(page, 'notes_list', {
    options: { limit: 10_000 }
  })
  return list.notes.map((note) => note.id)
}

export async function expandCollections(page: Page): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

export const treeRow = (page: Page, nodeId: string) =>
  page.locator(`[data-tree-node-id="${nodeId}"]`)

/** Opens the note from the Collections tree, each folder above it opened first. */
export async function openFromSidebar(page: Page, note: NoteView): Promise<void> {
  await expandCollections(page)
  const folders = note.path.split('/').slice(0, -1)
  for (let depth = 1; depth <= folders.length; depth++) {
    const row = treeRow(page, `folder-${folders.slice(0, depth).join('/')}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    const expand = row.getByRole('button', { name: 'Expand folder' })
    if (await expand.isVisible()) await expand.click()
  }
  await treeRow(page, note.id).click()
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(note.title)
}

/** Picks `label` in the open note's "More actions" menu. */
export async function chooseFromNoteMenu(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
}
