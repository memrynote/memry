// Search and the command palette (Electron `tests/e2e/search-command-palette.e2e.ts`, #3540): a
// note is found by the `search_*` commands and the palette, a result opened from search lists in
// the recents, and the palette's ⌘3 Tasks scope hides the note and finds a task. Electron's inbox
// leg is skipped below until `inbox_capture_text` is ported. The attachment-text cases are new in
// Tauri (#3542 lane I): a note is found by the words of a PDF or an image attached to it, which the
// `memry-ml-worker` sidecar reads (pdfium for the text layer, Tesseract for the picture).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { appReady } from '../../harness/app-ready'
import { uploadAttachment } from '../../harness/attachments'
import { fileTextSkipReason } from '../../harness/file-text'
import type { Page } from '../../harness/pw-compat/page'
import { createNote, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface Found {
  groups: Array<{ results: Array<{ id: string; title: string }> }>
}

interface Reason {
  itemId: string
  itemIcon: string | null
}

test('a note is found by search and the palette, and listed once opened', async ({ page }) => {
  await appReady(page)
  await vaultOpen(page)
  const suffix = Math.random().toString(36).slice(2, 8)
  const tag = `e2esearch${suffix}`
  const title = `Search Note ${suffix}`
  const note = await createNote(page, {
    title,
    content: 'Note body for search coverage.',
    tags: [tag],
    emoji: '🔎'
  })

  await expect
    .poll(
      async () => {
        const found = await invoke<Found>(page, 'search_query', {
          input: { text: title, types: ['note'], tags: [tag], limit: 10 }
        })
        return found.groups.flatMap((group) => group.results).map((item) => item.title)
      },
      { timeout: 20_000 }
    )
    .toContain(title)

  await invoke(page, 'search_add_reason', {
    input: { itemId: note.id, itemType: 'note', itemTitle: title, searchQuery: 'search note' }
  })
  const reasons = await invoke<Reason[]>(page, 'search_get_reasons')
  expect(reasons.find((reason) => reason.itemId === note.id)?.itemIcon).toBe('🔎')

  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.keyboard.press(`${MOD}+k`)
  const input = page.locator('[cmdk-input]')
  await expect(input).toBeVisible()
  await input.fill(title)
  const dialog = page.locator('[cmdk-root]')
  await expect(dialog.getByText(title, { exact: true }).first()).toBeVisible()
  // The palette scopes types from the keyboard since #2823; ⌘3 is Tasks.
  await page.keyboard.press(`${MOD}+3`)
  await expect(dialog.getByRole('button', { name: /^Remove Tasks?$/ })).toBeVisible()
  await expect(dialog.getByText(title, { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('a task is found by search and by the palette in the Tasks scope', async ({ page }) => {
  await appReady(page)
  await vaultOpen(page)
  const suffix = Math.random().toString(36).slice(2, 8)
  const tag = `e2esearch${suffix}`
  const noteTitle = `Search Note ${suffix}`
  const taskTitle = `Search Task ${suffix}`
  await createNote(page, {
    title: noteTitle,
    content: 'Note body for search coverage.',
    tags: [tag]
  })
  const { projects } = await invoke<{ projects: Array<{ id: string }> }>(page, 'tasks_project_list')
  const projectId = projects[0]?.id
  if (!projectId) throw new Error('default task project missing')
  const created = await invoke<{
    success: boolean
    task: { title: string } | null
    error?: string
  }>(page, 'tasks_create', { input: { projectId, title: taskTitle, priority: 3, tags: [tag] } })
  if (!created.success || !created.task) throw new Error(created.error ?? 'failed to seed task')

  await expect
    .poll(
      async () => {
        const found = await invoke<Found>(page, 'search_query', {
          input: { text: taskTitle, types: ['task'], limit: 10 }
        })
        return found.groups.flatMap((group) => group.results).map((item) => item.title)
      },
      { timeout: 20_000 }
    )
    .toContain(taskTitle)

  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.keyboard.press(`${MOD}+k`)
  const input = page.locator('[cmdk-input]')
  await expect(input).toBeVisible()
  await input.fill(noteTitle)
  const dialog = page.locator('[cmdk-root]')
  await expect(dialog.getByText(noteTitle, { exact: true }).first()).toBeVisible()
  await page.keyboard.press(`${MOD}+3`)
  await expect(dialog.getByRole('button', { name: /^Remove Tasks?$/ })).toBeVisible()
  await expect(dialog.getByText(noteTitle, { exact: true })).toHaveCount(0)
  await input.fill(taskTitle)
  await expect(dialog.getByText(taskTitle, { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')
})

test.skip('an inbox item is found by search: needs `inbox_capture_text` (Electron `inbox:captureText`), not ported yet', async () => {})

// The worker's own fixtures: a two-page text PDF ("Alpha harbor lantern", "Beta orchard compass")
// and a rendered line of text ("Heron count at dawn").
const fixture = (name: string): Uint8Array =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../crates/memry-ml-worker/tests/fixtures/${name}`, import.meta.url)
    )
  )

/**
 * A note whose body links `bytes` as an attachment named `fileName`. The runner reads only the
 * attachments a note's body names (`attachments/<noteId>/<file>`), and reads a note's folder when
 * the note is indexed, so the body is written after the upload, as the editor's attach does.
 */
async function noteWithAttachment(
  page: Page,
  fileName: string,
  bytes: Uint8Array
): Promise<{ id: string; title: string }> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const title = `Attachment Search ${suffix}`
  const note = await createNote(page, { title, content: 'Body without the words.' })
  const saved = await uploadAttachment(page, note.id, fileName, bytes)
  await invoke(page, 'notes_update', {
    input: { id: note.id, content: `Body without the words.\n\n[${fileName}](${saved.path})` }
  })
  return { id: note.id, title }
}

const foundNoteIds = async (page: Page, text: string): Promise<string[]> => {
  const found = await invoke<Found>(page, 'search_query', {
    input: { text, types: ['note'], limit: 10 }
  })
  return found.groups.flatMap((group) => group.results).map((item) => item.id)
}

async function expectPaletteFinds(page: Page, text: string, title: string): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.keyboard.press(`${MOD}+k`)
  const input = page.locator('[cmdk-input]')
  await expect(input).toBeVisible()
  await input.fill(text)
  await expect(page.locator('[cmdk-root]').getByText(title, { exact: true }).first()).toBeVisible({
    timeout: 20_000
  })
  await page.keyboard.press('Escape')
}

test('a note is found by the text layer of a PDF attached to it', async ({ page }) => {
  const unavailable = fileTextSkipReason()
  test.skip(unavailable !== null, unavailable ?? '')
  test.slow()
  await appReady(page)
  await vaultOpen(page)
  const note = await noteWithAttachment(page, 'two-pages.pdf', fixture('two-pages.pdf'))

  // "compass" is on the second page, so the whole file is read, not only its first page.
  await expect.poll(() => foundNoteIds(page, 'compass'), { timeout: 60_000 }).toContain(note.id)
  expect(await foundNoteIds(page, 'lantern')).toContain(note.id)
  await expectPaletteFinds(page, 'compass', note.title)
})

test('a note is found by the words OCR reads from an image attached to it', async ({ page }) => {
  const unavailable = fileTextSkipReason()
  test.skip(unavailable !== null, unavailable ?? '')
  test.slow()
  await appReady(page)
  await vaultOpen(page)
  const note = await noteWithAttachment(page, 'heron.png', fixture('ocr-reader.fixture.png'))

  await expect.poll(() => foundNoteIds(page, 'heron'), { timeout: 90_000 }).toContain(note.id)
  await expectPaletteFinds(page, 'heron', note.title)
})
