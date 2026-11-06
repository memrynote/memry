// The cover picker's sources besides an upload (#3531 14f-2b), each through its tab:
// - "From note" lists the images the vault already stores (`notes_list_vault_attachments`) and
//   embeds one by a path relative to this note (`notes_insert_existing_attachment`); nothing is
//   copied.
// - "Link" fetches the image at a URL into the note's own attachments folder
//   (`notes_download_attachment_from_url`), from a local HTTP server the spec starts. A link to a
//   page is refused with its reason, and nothing is written.
// The claim is about the file: the `cover:` line holds a note-relative ref that names the bytes.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'

import { openDetailsMenu, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

// A 1x1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

interface NoteView {
  id: string
  path: string
}

function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

async function newNote(page: Page, title: string): Promise<NoteView> {
  return invoke<NoteView>(page, 'notes_create', {
    input: { title: `${title} ${Date.now()}`, content: 'Body' }
  })
}

async function openPicker(page: Page, note: NoteView): Promise<void> {
  await openFromSidebar(page, note)
  await openDetailsMenu(page)
  await page.getByTestId('ghost-add-cover').click()
  await expect(page.getByTestId('cover-picker-dialog')).toBeVisible()
}

/** The `cover:` line of the note's file, once it has one. */
async function coverRef(noteFile: string): Promise<string> {
  await expect.poll(() => readFileSync(noteFile, 'utf8'), { timeout: 20_000 }).toMatch(/^cover: /m)
  return (readFileSync(noteFile, 'utf8').match(/^cover: (.*?)\r?$/m) ?? [])[1] ?? ''
}

test('From note embeds an image another note stores, by a path relative to this note', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const owner = await newNote(page, 'Image Owner')
  await page.evaluate(
    ([noteId, base64]: [string, string]) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      return window.__TAURI__.core.invoke('notes_upload_attachment', bytes, {
        headers: {
          'x-memry-meta': JSON.stringify({ noteId, fileName: 'shared.png', size: bytes.length })
        }
      })
    },
    [owner.id, PNG_BYTES.toString('base64')] as [string, string]
  )
  const [stored] = filesIn(join(testVaultPath, 'attachments', owner.id))

  const note = await newNote(page, 'Cover From Note')
  await openPicker(page, note)
  await page.getByTestId('cover-picker-dialog').getByRole('tab', { name: 'From note' }).click()
  await page.getByTestId('cover-picker-row').first().click()
  await expect(page.getByTestId('cover-picker-dialog')).toBeHidden()

  const noteFile = join(testVaultPath, note.path)
  const ref = await coverRef(noteFile)
  expect(ref).toBe(`attachments/${owner.id}/${stored}`)
  expect(readFileSync(join(dirname(noteFile), ref))).toEqual(PNG_BYTES)
  // Embedded, not copied.
  expect(filesIn(join(testVaultPath, 'attachments', note.id))).toEqual([])
})

test('Link saves the image at a URL into the note, and a link to a page writes nothing', async ({
  page,
  testVaultPath
}) => {
  const server: Server = createServer((request, response) => {
    // A request may name its target in absolute form.
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname === '/photos/cover.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(PNG_BYTES)
    } else {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><body>a page</body></html>')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await vaultOpen(page)
    const note = await newNote(page, 'Cover From Link')
    const folder = join(testVaultPath, 'attachments', note.id)
    await openPicker(page, note)
    await page.getByTestId('cover-picker-dialog').getByRole('tab', { name: 'Link' }).click()

    await page.getByTestId('cover-picker-search').fill(`http://127.0.0.1:${port}/page`)
    await page.getByTestId('cover-picker-link').click()
    await expect(page.getByTestId('cover-picker-link-error')).toHaveAttribute(
      'data-reason',
      'not-an-image'
    )
    expect(filesIn(folder)).toEqual([])

    await page.getByTestId('cover-picker-search').fill(`http://127.0.0.1:${port}/photos/cover.png`)
    await page.getByTestId('cover-picker-link').click()
    await expect(page.getByTestId('cover-picker-dialog')).toBeHidden()

    const noteFile = join(testVaultPath, note.path)
    const ref = await coverRef(noteFile)
    expect(ref).toMatch(new RegExp(`^attachments/${note.id}/[0-9a-z]{6}-cover\\.png$`))
    expect(readFileSync(join(dirname(noteFile), ref))).toEqual(PNG_BYTES)
    expect(filesIn(folder)).toHaveLength(1)
  } finally {
    server.close()
  }
})
