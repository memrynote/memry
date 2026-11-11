// An embedded PDF's width and alignment, ported from Electron's `pdf-embed-resize.e2e.ts`
// (#3531 14f-3d): both round-trip to the note's markdown. Electron embedded the PDF by dropping a
// sidebar PDF on the note; here the resize and align cases embed an uploaded PDF, and the drop
// case is skipped until #4209, because the app never lists a PDF in the vault as a sidebar item.
// The drop resolves the item through `notes_get_file`. Electron imported the PDF through
// `notes.importFiles`, which Step 32 (#3549) ports; the drop case writes it into the vault.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  minimalPdfBytes,
  PDF_FILE,
  seedNoteWithFileBlock,
  seedVaultFile
} from '../../harness/attachments'
import { noteBody, openNewNote } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

// `renderer/src/lib/drag-mime.ts`, as a literal: the wire contract the sidebar and editor share.
const MEMRY_NOTE_DRAG_MIME = 'application/x-memry-note'

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** The first file marker's JSON in the note's saved markdown. */
const fileMarker = async (page: Page, noteId: string): Promise<string> =>
  /<!-- file:(\{[^}]+\}) -->/.exec((await noteBody(page, noteId)) ?? '')?.[1] ?? ''

/**
 * Waits until an unsized embed has its final geometry: the first page is painted, and the card
 * fills the column it measured. The controls show as soon as pdf.js has the file, a few frames
 * before that. The page's height can add the editor's scrollbar, which narrows the column, and the
 * card follows a render later: the align buttons at its end edge move by the scrollbar's width,
 * so a click aimed before that lands on whatever moved under it (#3967).
 */
async function embedSettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const wrap = document.querySelector('.pdf-preview-wrap')
          const card = wrap?.querySelector<HTMLElement>('.pdf-preview')
          const painted = wrap?.querySelector<HTMLCanvasElement>('.react-pdf__Page__canvas')
          return !!card && !!painted && painted.width > 0 && card.offsetWidth === wrap?.clientWidth
        }),
      { timeout: 20_000 }
    )
    .toBe(true)
}

test('drops a sidebar PDF as an embed by path, not as an attachment copy', async ({
  page,
  testVaultPath
}) => {
  test.skip(true, 'non-markdown vault files are not indexed (#4209)')
  await vaultOpen(page)
  const pdf = await seedVaultFile(
    page,
    testVaultPath,
    `e2e-embed-${stamp()}.pdf`,
    minimalPdfBytes()
  )
  const note = await openNewNote(page, `Embed Target ${stamp()}`, 'drop here')
  // A text caret gives the block an insertion point.
  await page.locator(NOTE_EDITOR).first().click()
  await page.evaluate(
    ({ mime, id, selector }: { mime: string; id: string; selector: string }) => {
      const editor = document.querySelector(selector)
      if (!editor) throw new Error('editor element not found')
      const transfer = new DataTransfer()
      transfer.setData(mime, id)
      for (const type of ['dragover', 'drop']) {
        editor.dispatchEvent(
          new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true })
        )
      }
    },
    { mime: MEMRY_NOTE_DRAG_MIME, id: pdf.id, selector: NOTE_EDITOR }
  )

  await expect(page.locator('.pdf-preview')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => fileMarker(page, note.id), { timeout: 20_000 }).toContain(pdf.path)
  expect(await fileMarker(page, note.id)).not.toContain('attachments')
  expect(existsSync(join(testVaultPath, 'attachments', note.id))).toBe(false)
})

test('shows a resize handle and persists the new width', async ({ page }) => {
  await vaultOpen(page)
  const { note } = await seedNoteWithFileBlock(page, `Resize Target ${stamp()}`, PDF_FILE)

  // The handle renders once pdf.js has loaded the file.
  const slider = page.getByRole('slider')
  await expect(slider).toBeVisible({ timeout: 20_000 })
  await embedSettled(page)
  const before = Number(await slider.getAttribute('aria-valuenow'))
  expect(before).toBeGreaterThan(0)

  await slider.focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => before - Number(await page.getByRole('slider').getAttribute('aria-valuenow')))
    .toBeGreaterThan(0)
  await expect.poll(() => fileMarker(page, note.id), { timeout: 20_000 }).toMatch(/"width":\d+/)
})

test('aligns the embed and persists the alignment', async ({ page }) => {
  await vaultOpen(page)
  const { note } = await seedNoteWithFileBlock(page, `Align Target ${stamp()}`, PDF_FILE)

  await embedSettled(page)
  await page.locator('.pdf-preview').scrollIntoViewIfNeeded()
  // The control is revealed on hover and clickable at rest.
  const center = page.getByRole('button', { name: 'Align center' })
  await center.click()
  await expect(center).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => fileMarker(page, note.id), { timeout: 20_000 })
    .toContain('"align":"center"')
})
