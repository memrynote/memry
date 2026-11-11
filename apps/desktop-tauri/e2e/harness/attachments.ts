import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError } from './errors'
import { createNote, listedNotes, openFromSidebar, type ListedNote, type NoteView } from './notes'
import type { Page } from './pw-compat/page'
import { expect } from './pw-compat/expect'
import { invoke } from './vault-commands'
import { pollUntil } from './wait'

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

export interface Saved {
  /** The ref a note in the host's folder writes, `../attachments/<host>/<stored>`. */
  path: string
  size: number
}

interface Listed {
  filename: string
}

/** A file a seeded block names, and the element the block renders it as. */
export interface SeedFile {
  name: string
  bytes: Uint8Array
  mimeType: string
  rendered: string
}

const TEXT_FILE: SeedFile = {
  name: ORIGINAL_NAME,
  bytes: new TextEncoder().encode('attachment e2e'),
  mimeType: 'text/plain',
  rendered: '.file-attachment'
}

/** A PDF, which a file block renders as the inline pdf.js preview. */
export const PDF_FILE: SeedFile = {
  name: 'report.pdf',
  bytes: minimalPdfBytes(),
  mimeType: 'application/pdf',
  rendered: '.pdf-preview'
}

/**
 * Uploads a file (a text file unless `file` names another) to a host note, makes a note whose
 * body is a file block naming it (both in `notes/`, so the host's ref resolves from either) and
 * opens that note. The stored name comes from `notes_list_attachments`, as the attachments
 * dialog reads it.
 */
export async function seedNoteWithFileBlock(
  page: Page,
  title: string,
  file: SeedFile = TEXT_FILE
): Promise<SeededAttachment> {
  const host = await createNote(page, { title: `${title} host`, content: 'host', folder: 'notes' })
  const saved = await uploadAttachment(page, host.id, file.name, file.bytes)
  const listed = await invoke<Listed[]>(page, 'notes_list_attachments', { noteId: host.id })
  expect(listed.length).toBe(1)
  const marker = `<!-- file:${JSON.stringify({
    url: saved.path,
    name: file.name,
    size: saved.size,
    mimeType: file.mimeType
  })} -->`
  const note = await createNote(page, { title, content: marker, folder: 'notes' })
  await openFromSidebar(page, note)
  await page.locator(file.rendered).first().waitFor({ state: 'visible', timeout: 20_000 })
  return { note, hostId: host.id, storedFilename: listed[0].filename, url: saved.path }
}

/** Uploads `bytes` as `fileName` to the note, as the editor's upload does. */
export function uploadAttachment(
  page: Page,
  noteId: string,
  fileName: string,
  bytes: Uint8Array
): Promise<Saved> {
  // base64, so a multi-megabyte file crosses the driver in one short string.
  return page.evaluate(
    ([id, base64, name]: [string, string, string]) => {
      const binary = atob(base64)
      const body = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) body[i] = binary.charCodeAt(i)
      return window.__TAURI__.core.invoke('notes_upload_attachment', body, {
        headers: {
          'x-memry-meta': JSON.stringify({ noteId: id, fileName: name, size: body.length })
        }
      }) as Promise<Saved>
    },
    [noteId, Buffer.from(bytes).toString('base64'), fileName] as [string, string, string]
  )
}

/** A 1x1 PNG. */
export const PNG_BYTES = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 96, 0, 0, 0, 6, 0, 2, 48, 129,
  208, 47, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
])

/**
 * A blank single-page PDF with a byte-correct xref table, so pdf.js loads it. ASCII only, so the
 * string length is the byte offset.
 */
export function minimalPdfBytes(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((dict, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${dict}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/**
 * Writes a file at the vault root and waits for the app to list it as a sidebar item. Stands in
 * for Electron's `notes.importFiles`, which Step 32 (#3549) ports: the import copies the file to
 * the same place, and the watcher lists it the same way.
 */
export async function seedVaultFile(
  page: Page,
  vaultPath: string,
  name: string,
  bytes: Uint8Array
): Promise<ListedNote> {
  writeFileSync(join(vaultPath, name), bytes)
  const found = await pollUntil(
    async () => (await listedNotes(page)).find((note) => note.path === name),
    { timeoutMs: 30_000 }
  )
  if (!found) {
    const listed = (await listedNotes(page)).map((note) => note.path)
    throw new HarnessError(`${name} was not listed within 30 s; listed ${JSON.stringify(listed)}`)
  }
  return found
}
