import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { SELECTORS, seedNote, tabSessionStorageKey } from './utils/electron-helpers'

// Keep in sync with src/renderer/src/lib/drag-mime.ts. Duplicated as a literal
// so the test asserts the exact wire contract the sidebar and editor share.
const MEMRY_NOTE_DRAG_MIME = 'application/x-memry-note'

/**
 * Build a valid single-page PDF with a byte-correct xref table so pdfjs (react-pdf)
 * loads it and the inline preview reaches its non-loading state (which is when the
 * resize handle renders). A blank page is enough — we only need a successful load.
 */
function makeMinimalPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefStart = Buffer.byteLength(body, 'latin1')
  const size = objects.length + 1
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(body + xref + trailer, 'latin1')
}

/** Import a PDF into the vault (becomes a file-type sidebar item) and return its id. */
async function importPdf(page: Page): Promise<string> {
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-pdf-'))
  const pdfName = `e2e-embed-${Date.now()}.pdf`
  const pdfTitle = path.basename(pdfName, '.pdf')
  fs.writeFileSync(path.join(importDir, pdfName), makeMinimalPdf())

  const imported = await page.evaluate(
    async (src) => window.api.notes.importFiles([src], ''),
    path.join(importDir, pdfName)
  )
  expect(imported.success).toBe(true)

  // Imported file notes surface in the list only after indexing — poll by
  // filename/title rather than assuming a fileType value.
  let pdfId: string | null = null
  await expect
    .poll(
      async () => {
        pdfId = await page.evaluate(
          async ({ name, title }) => {
            const list = await window.api.notes.list({ limit: 200 })
            return list.notes.find((n) => n.path === name || n.title === title)?.id ?? null
          },
          { name: pdfName, title: pdfTitle }
        )
        return pdfId
      },
      { timeout: 20_000 }
    )
    .not.toBeNull()

  return pdfId as string
}

/** Open a seeded markdown note in the editor deterministically via restored tab state. */
async function openNoteInEditor(page: Page, noteId: string, title: string): Promise<void> {
  const storageKey = await tabSessionStorageKey(page)
  await page.addInitScript(
    ({ id, t, storageKey }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          tabGroups: {
            g1: {
              id: 'g1',
              activeTabId: 'note-tab',
              tabs: [
                {
                  id: 'note-tab',
                  type: 'note',
                  title: t,
                  icon: 'file',
                  path: `/notes/${id}`,
                  entityId: id,
                  isPinned: false
                }
              ]
            }
          },
          layout: { type: 'leaf', tabGroupId: 'g1' },
          activeGroupId: 'g1',
          settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
          savedAt: Date.now()
        })
      )
    },
    { id: noteId, t: title, storageKey }
  )
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

/** Simulate a file-type sidebar item being dropped onto the note editor. */
async function dropSidebarItem(page: Page, itemId: string): Promise<void> {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.click() // place a text cursor so the block has an insertion anchor
  await page.evaluate(
    ({ mime, id, sel }) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error('editor element not found')
      const dt = new DataTransfer()
      dt.setData(mime, id)
      el.dispatchEvent(
        new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
      )
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    { mime: MEMRY_NOTE_DRAG_MIME, id: itemId, sel: SELECTORS.noteEditor }
  )
}

/** Read a note's saved markdown through the app data layer (survives autosave debounce). */
async function noteMarkdown(page: Page, id: string): Promise<string> {
  return page.evaluate(async (noteId) => {
    const res = (await window.api.notes.get(noteId)) as Record<string, unknown>
    const note = (res?.note ?? res) as Record<string, unknown> | undefined
    return String(note?.content ?? note?.contentMarkdown ?? '')
  }, id)
}

test.describe('PDF embed via sidebar drag + resize', () => {
  test('drops a sidebar PDF as an embed by path, not as an attachment copy', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    const pdfId = await importPdf(page)
    const targetId = await seedNote(page, uniqueLabel('Embed Target'), 'drop here')
    await openNoteInEditor(page, targetId, 'Embed Target')

    await dropSidebarItem(page, pdfId)

    // The inline PDF preview card renders in the editor (visible before pdfjs load).
    await expect(page.locator('.pdf-preview')).toBeVisible({ timeout: 10_000 })

    // Crucially: the bytes were NOT copied into attachments/ — the embed references
    // the sidebar item's own vault path.
    const targetAttachmentsDir = path.join(testVaultPath, 'attachments', targetId)
    expect(fs.existsSync(targetAttachmentsDir)).toBe(false)

    // The persisted marker points at the imported PDF path, not attachments/.
    await expect
      .poll(
        async () => {
          const match = (await noteMarkdown(page, targetId)).match(/<!-- file:(\{[^}]+\}) -->/)
          return !!match && match[1].includes('.pdf') && !match[1].includes('attachments')
        },
        { timeout: 20_000 }
      )
      .toBe(true)
  })

  test('shows a resize handle and persists the new width', async ({ page }) => {
    await ready(page)

    const pdfId = await importPdf(page)
    const targetId = await seedNote(page, uniqueLabel('Resize Target'), 'drop here')
    await openNoteInEditor(page, targetId, 'Resize Target')
    await dropSidebarItem(page, pdfId)

    // Resize indicator exists once the PDF has loaded.
    const slider = page.getByRole('slider')
    await expect(slider).toBeVisible({ timeout: 20_000 })

    const before = Number(await slider.getAttribute('aria-valuenow'))
    expect(before).toBeGreaterThan(0)

    // Shrink via the keyboard (deterministic regardless of column width).
    await slider.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')

    await expect
      .poll(async () => Number(await page.getByRole('slider').getAttribute('aria-valuenow')))
      .toBeLessThan(before)

    // The width round-trips to the persisted note markdown.
    await expect
      .poll(async () => /<!-- file:\{[^}]*"width":\d+/.test(await noteMarkdown(page, targetId)), {
        timeout: 20_000
      })
      .toBe(true)
  })

  test('aligns the embed and persists the alignment', async ({ page }) => {
    await ready(page)

    const pdfId = await importPdf(page)
    const targetId = await seedNote(page, uniqueLabel('Align Target'), 'drop here')
    await openNoteInEditor(page, targetId, 'Align Target')
    await dropSidebarItem(page, pdfId)

    await expect(page.locator('.pdf-preview')).toBeVisible({ timeout: 10_000 })
    // Scroll the embed clear of the sticky note header before clicking.
    await page.locator('.pdf-preview').scrollIntoViewIfNeeded()

    // Click the center-align control (hover-revealed, still clickable at rest).
    await page.getByRole('button', { name: 'Align center' }).click()

    // The alignment round-trips to the persisted note markdown.
    await expect
      .poll(
        async () => /<!-- file:\{[^}]*"align":"center"/.test(await noteMarkdown(page, targetId)),
        { timeout: 20_000 }
      )
      .toBe(true)
  })
})
