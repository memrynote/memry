// The note surfaces the notes CRUD specs drive (Step 13f, #3530): notes made and read through the
// commands the renderer calls, and a note opened from the Collections tree as a user opens one.
import { HarnessError } from './errors'
import { expect } from './pw-compat/expect'
import { rowState } from './flake-probe'
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

export interface ListedNote {
  id: string
  path: string
  title: string
  /** `markdown`, or the kind of a file item such as `image` or `pdf`. */
  fileType?: string
}

/** Every note the vault lists. */
export async function listedNotes(page: Page): Promise<ListedNote[]> {
  const list = await invoke<{ notes: ListedNote[] }>(page, 'notes_list', {
    options: { limit: 10_000 }
  })
  return list.notes
}

export const listedIds = async (page: Page): Promise<string[]> =>
  (await listedNotes(page)).map((note) => note.id)

/**
 * The note `where` picks once it is listed, among those not in `known`. The vault's own notes may
 * still be arriving from the open's walk, so a new note is told by what it is, not by being new.
 */
export async function newNote(
  page: Page,
  known: string[],
  where: (note: ListedNote) => boolean
): Promise<ListedNote> {
  const found = await pollUntil(
    async () => (await listedNotes(page)).find((note) => !known.includes(note.id) && where(note)),
    { timeoutMs: 30_000 }
  )
  if (found) return found
  // Where the note went instead: every listed note, and the folder a create without one reads.
  const notes = (await listedNotes(page)).map((note) => `${note.path} [${note.title}]`)
  const config = await invoke<unknown>(page, 'e2e_vault_config')
  throw new HarnessError(
    `no new note matched within 30 s; known ${JSON.stringify(known)}; ` +
      `listed ${JSON.stringify(notes)}; vault config ${JSON.stringify(config)}`
  )
}

/**
 * Opens the Collections section and waits for its open transition to end. The section opens
 * through a 100 ms transition inside an overflow-hidden box. The driver scrolls a row it clicks
 * into view, which scrolls that box mid-transition; the box springs back when the transition
 * ends and the click lands on the row above.
 */
export async function expandCollections(page: Page): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  // `getAnimations` flushes style first, so a transition the open just started is counted.
  await expect
    .poll(() =>
      page
        .locator('#section-content-collections')
        .evaluate(
          (section: HTMLElement) =>
            section.getAnimations().length === 0 && section.getBoundingClientRect().height > 0
        )
    )
    .toBe(true)
}

export const treeRow = (page: Page, nodeId: string) =>
  page.locator(`[data-tree-node-id="${nodeId}"]`)

/** Opens the note from the Collections tree, each folder above it opened first. */
export async function openFromSidebar(
  page: Page,
  note: Pick<NoteView, 'id' | 'path' | 'title'>
): Promise<void> {
  await expandCollections(page)
  const folders = note.path.split('/').slice(0, -1)
  for (let depth = 1; depth <= folders.length; depth++) {
    const row = treeRow(page, `folder-${folders.slice(0, depth).join('/')}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    const expand = row.getByRole('button', { name: 'Expand folder' })
    if (await expand.isVisible()) await expand.click()
  }
  try {
    await treeRow(page, note.id).click()
  } catch (error) {
    throw new Error(`${String(error)}\nPROBE row ${await rowState(page, note.id)}`, {
      cause: error
    })
  }
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(note.title)
}

/**
 * Opens the note header's "add details" menu. The chip takes pointer events only while the
 * header is hovered (CSS `group-hover`), and a WebDriver pointer move in WKWebView sets no
 * `:hover`, so the harness opens the menu from the keyboard; the chip is reachable by focus too.
 */
export async function openDetailsMenu(page: Page): Promise<void> {
  const details = page.getByTestId('ghost-add-details')
  await details.waitFor({ state: 'attached' })
  await details.focus()
  await page.keyboard.press('Enter')
}

/** Picks `label` in the open note's "More actions" menu. */
export async function chooseFromNoteMenu(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
}
