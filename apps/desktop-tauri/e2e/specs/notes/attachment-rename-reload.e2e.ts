// Attachment actions a page asks for, through the commands the renderer calls (#3531 14f-2b):
// - `notes_attachment_rename`, as the block menu's rename dialog calls it. The file on disk takes
//   the new name with its prefix and extension, and a url out of the vault moves nothing.
// - The wiring of `guards/process_gone.rs`: an upload the page began ends with nothing when that
//   page reloads (`attachments::release_page` on a page load). The part file goes, and the
//   reloaded page cannot continue the upload.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const MIB = 1024 * 1024
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]

interface NoteView {
  id: string
  path: string
}

interface Saved {
  path: string
}

interface Renamed {
  storedFilename: string
  url: string
  name: string
}

function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

async function newNote(page: Page, title: string): Promise<NoteView> {
  return invoke<NoteView>(page, 'notes_create', {
    input: { title: `${title} ${Date.now()}`, content: 'Body', folder: 'notes' }
  })
}

/**
 * Calls a command in the page and answers its result or its serialized rejection. Caught in the
 * page: a rejection that reaches the driver makes it retry the script.
 */
async function settle(
  page: Page,
  command: string,
  args: Record<string, unknown>
): Promise<{ ok: unknown } | { error: string }> {
  return page.evaluate(
    ([name, params]: [string, Record<string, unknown>]) =>
      window.__TAURI__.core.invoke(name, params).then(
        (ok: unknown) => ({ ok }),
        (error: unknown) => ({ error: JSON.stringify(error) })
      ),
    [command, args]
  )
}

test('a rename keeps the prefix and the extension, and a url out of the vault moves nothing', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await newNote(page, 'Rename Attachment')
  const saved = await page.evaluate(
    ([noteId, bytes]: [string, number[]]) =>
      window.__TAURI__.core.invoke('notes_upload_attachment', new Uint8Array(bytes), {
        headers: {
          'x-memry-meta': JSON.stringify({ noteId, fileName: 'scan 0031.pdf', size: bytes.length })
        }
      }) as Promise<Saved>,
    [note.id, PDF] as [string, number[]]
  )
  const folder = join(testVaultPath, 'attachments', note.id)
  const [stored] = filesIn(folder)

  const renamed = await invoke<Renamed>(page, 'notes_attachment_rename', {
    noteId: note.id,
    url: saved.path,
    newName: 'Invoice March'
  })
  expect(renamed.storedFilename).toBe(`${stored.slice(0, 7)}Invoice-March.pdf`)
  expect(renamed.name).toBe('Invoice March.pdf')
  expect(filesIn(folder)).toEqual([renamed.storedFilename])
  // The new url resolves from the note's file to the renamed bytes.
  const noteDir = dirname(join(testVaultPath, note.path))
  expect([...readFileSync(resolve(noteDir, renamed.url))]).toEqual(PDF)

  for (const url of ['../../../../etc/hosts', 'memry-file://local/etc/hosts', '/etc/hosts']) {
    const refused = await settle(page, 'notes_attachment_rename', {
      noteId: note.id,
      url,
      newName: 'x'
    })
    expect('error' in refused ? refused.error : 'resolved').toContain(
      '"code":"attachment_invalid_path"'
    )
  }
  expect(filesIn(folder)).toEqual([renamed.storedFilename])
})

test('an upload the page began ends with nothing when the page reloads', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await newNote(page, 'Reload Upload')
  const uploads = join(testVaultPath, '.memry', 'uploads')
  const id = await invoke<string>(page, 'notes_upload_attachment_begin', {
    noteId: note.id,
    fileName: 'clip.mp4',
    size: 20 * MIB
  })
  expect(filesIn(uploads)).toEqual([`${id}.part`])

  await page.reload()

  await expect.poll(() => filesIn(uploads), { timeout: 10_000 }).toEqual([])
  const cancelled = await page.evaluate(
    ([upload]: [string]) =>
      window.__TAURI__.core
        .invoke('notes_upload_attachment_chunk', new Uint8Array([1, 2, 3]), {
          headers: { 'x-memry-meta': JSON.stringify({ id: upload, offset: 0 }) }
        })
        .then(
          () => 'resolved',
          (error: unknown) => JSON.stringify(error)
        ),
    [id] as [string]
  )
  expect(cancelled).toContain('"code":"attachment_upload_refused"')
  expect(filesIn(join(testVaultPath, 'attachments', note.id))).toEqual([])
})
