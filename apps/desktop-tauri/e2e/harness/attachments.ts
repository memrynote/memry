import { createNote, openFromSidebar, type NoteView } from './notes'
import type { Page } from './pw-compat/page'
import { expect } from './pw-compat/expect'
import { invoke } from './vault-commands'

export const ORIGINAL_NAME = 'original-report.txt'

/** The reveal item is named for the host's file manager. */
export const REVEAL_LABEL =
  process.platform === 'darwin'
    ? 'Reveal in Finder'
    : process.platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in file manager'

export interface SeededAttachment {
  /** The open note, whose body is the file block. */
  note: NoteView
  /** The note the file was uploaded to: its `attachments/<id>/` folder holds the file. */
  hostId: string
  storedFilename: string
  /** The note-relative ref in the block. */
  url: string
}

interface Saved {
  path: string
  size: number
}

interface Listed {
  filename: string
}

/**
 * Uploads a text file to a host note, makes a note whose body is a file block naming it (both in
 * `notes/`, so the host's ref resolves from either) and opens that note. The stored name comes
 * from `notes_list_attachments`, as the attachments dialog reads it.
 */
export async function seedNoteWithFileBlock(page: Page, title: string): Promise<SeededAttachment> {
  const host = await createNote(page, { title: `${title} host`, content: 'host', folder: 'notes' })
  const bytes = [...new TextEncoder().encode('attachment e2e')]
  const saved = await page.evaluate(
    ([noteId, body, fileName]: [string, number[], string]) =>
      window.__TAURI__.core.invoke('notes_upload_attachment', new Uint8Array(body), {
        headers: { 'x-memry-meta': JSON.stringify({ noteId, fileName, size: body.length }) }
      }) as Promise<Saved>,
    [host.id, bytes, ORIGINAL_NAME] as [string, number[], string]
  )
  const listed = await invoke<Listed[]>(page, 'notes_list_attachments', { noteId: host.id })
  expect(listed.length).toBe(1)
  const marker = `<!-- file:${JSON.stringify({
    url: saved.path,
    name: ORIGINAL_NAME,
    size: saved.size,
    mimeType: 'text/plain'
  })} -->`
  const note = await createNote(page, { title, content: marker, folder: 'notes' })
  await openFromSidebar(page, note)
  await page.locator('.file-attachment').first().waitFor({ state: 'visible', timeout: 20_000 })
  return { note, hostId: host.id, storedFilename: listed[0].filename, url: saved.path }
}
