import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect } from './fixtures'
import { PNG_BYTES, minimalPdfBytes, ready, uniqueLabel } from './utils/desktop-test-helpers'
import { toMemryFileUrl } from '../../src/renderer/src/lib/memry-file-url'

test.describe('File attachments and viewer E2E', () => {
  test('uploads note attachments, imports image files, serves protocol files, and restores viewer tabs', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    const noteTitle = uniqueLabel('Attachment Note')
    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-import-'))
    const importFileName = `e2e-import-${Date.now()}.png`
    const importTitle = path.basename(importFileName, path.extname(importFileName))
    const importSourcePath = path.join(importDir, importFileName)
    fs.writeFileSync(importSourcePath, Buffer.from(PNG_BYTES))

    try {
      const result = await page.evaluate(
        async ({ noteTitle, importSourcePath, importFileName, pngBytes }) => {
          const api = window.api
          const note = await api.notes.create({
            title: noteTitle,
            content: 'Attachment host',
            tags: ['e2e-file-attachments']
          })
          if (!note.success || !note.note) throw new Error(note.error ?? 'note create failed')

          const file = new File([new Uint8Array(pngBytes)], 'note-attachment.png', {
            type: 'image/png'
          })
          const uploaded = await api.notes.uploadAttachment(note.note.id, file)
          if (!uploaded.success) throw new Error(uploaded.error ?? 'attachment upload failed')
          const attachments = await api.notes.listAttachments(note.note.id)

          const imported = await api.notes.importFiles([importSourcePath], '')
          if (!imported.success || imported.imported !== 1) {
            throw new Error(imported.errors.join('\n') || 'file import failed')
          }

          return {
            noteId: note.note.id,
            attachmentFilename: attachments[0]?.filename,
            importFileName,
            imported
          }
        },
        { noteTitle, importSourcePath, importFileName, pngBytes: PNG_BYTES }
      )

      expect(result.attachmentFilename).toBeTruthy()
      expect(result.imported.importedFiles[0]).toMatchObject({
        filename: importFileName,
        fileType: 'image'
      })

      const noteAttachmentsDir = path.join(testVaultPath, 'attachments', result.noteId)
      expect(fs.readdirSync(noteAttachmentsDir)).toContain(result.attachmentFilename)
      // An empty target folder means the vault's `defaultNoteFolder` (#1486),
      // which is the vault root in a fresh vault — not a literal `notes/`.
      expect(fs.existsSync(path.join(testVaultPath, importFileName))).toBe(true)

      await expect
        .poll(
          () =>
            page.evaluate(
              async ({ fileName, importTitle }) => {
                const list = await window.api.notes.list({ limit: 100 })
                return (
                  list.notes.find(
                    (note) =>
                      note.fileType === 'image' &&
                      (note.path === fileName || note.title === importTitle)
                  ) ?? null
                )
              },
              { fileName: importFileName, importTitle }
            ),
          { timeout: 20_000 }
        )
        .not.toBeNull()

      const importedFile = await page.evaluate(
        async ({ fileName, importTitle }) => {
          const list = await window.api.notes.list({ limit: 100 })
          return (
            list.notes.find(
              (note) =>
                note.fileType === 'image' && (note.path === fileName || note.title === importTitle)
            ) ?? null
          )
        },
        { fileName: importFileName, importTitle }
      )
      expect(importedFile).not.toBeNull()

      const importedAbsolutePath = await page.evaluate(async (fileId) => {
        const file = await window.api.notes.getFile(fileId)
        return file?.absolutePath ?? null
      }, importedFile!.id)
      expect(importedAbsolutePath).toBeTruthy()

      // Build the protocol URL the same way the app does. On Windows the raw
      // absolute path starts with a drive letter (C:\...) and no leading slash;
      // concatenating it directly onto `memry-file://local` absorbs the drive
      // letter into the URL host, so the handler sees a relative path and 403s.
      const protocolResponse = await page.evaluate(async (fileUrl) => {
        const response = await fetch(fileUrl)
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          byteLength: (await response.arrayBuffer()).byteLength
        }
      }, toMemryFileUrl(importedAbsolutePath!))
      expect(protocolResponse).toMatchObject({
        status: 200,
        contentType: 'image/png',
        byteLength: PNG_BYTES.length
      })

      const fileId = importedFile!.id
      await page.addInitScript(
        ({ fileId, importTitle }) => {
          localStorage.setItem(
            'memry_tab_state',
            JSON.stringify({
              version: 2,
              tabGroups: {
                g1: {
                  id: 'g1',
                  activeTabId: 'file-tab',
                  tabs: [
                    {
                      id: 'file-tab',
                      type: 'file',
                      title: importTitle,
                      icon: 'file',
                      path: `/file/${fileId}`,
                      entityId: fileId,
                      isPinned: false
                    }
                  ]
                }
              },
              layout: { type: 'leaf', tabGroupId: 'g1' },
              activeGroupId: 'g1',
              settings: {
                restoreSessionOnStart: true,
                tabCloseButton: 'hover'
              },
              savedAt: Date.now()
            })
          )
        },
        { fileId, importTitle }
      )
      await page.reload()
      await page.waitForLoadState('domcontentloaded')

      await expect(page.getByRole('heading', { name: importTitle })).toBeVisible()
      await expect(page.getByRole('img', { name: importTitle })).toBeVisible()
    } finally {
      fs.rmSync(importDir, { recursive: true, force: true })
    }
  })

  // E43 renderer proof: react-pdf fetches PDF bytes cross-origin over the
  // memry-file scheme (the corsEnabled path), decodes them in the pdfjs module
  // worker, and paints a <canvas> under Chromium 150 / V8 15. jsdom unit tests
  // mock react-pdf, so only this bundled-Electron run exercises the real stack.
  test('renders an embedded PDF through the pdf.js worker and canvas under Chromium 150', async ({
    page
  }) => {
    await ready(page)

    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-pdf-'))
    const pdfFileName = `e2e-pdf-${Date.now()}.pdf`
    const pdfTitle = path.basename(pdfFileName, path.extname(pdfFileName))
    const pdfSourcePath = path.join(importDir, pdfFileName)
    fs.writeFileSync(pdfSourcePath, minimalPdfBytes())

    try {
      const imported = await page.evaluate(async (sourcePath) => {
        const res = await window.api.notes.importFiles([sourcePath], '')
        if (!res.success || res.imported !== 1) {
          throw new Error(res.errors.join('\n') || 'pdf import failed')
        }
        return true
      }, pdfSourcePath)
      expect(imported).toBe(true)

      let fileId: string | null = null
      await expect
        .poll(
          async () => {
            fileId = await page.evaluate(
              async ({ pdfFileName, pdfTitle }) => {
                const list = await window.api.notes.list({ limit: 100 })
                return (
                  list.notes.find((note) => note.path === pdfFileName || note.title === pdfTitle)
                    ?.id ?? null
                )
              },
              { pdfFileName, pdfTitle }
            )
            return fileId
          },
          { timeout: 20_000 }
        )
        .not.toBeNull()

      await page.addInitScript(
        ({ fileId, pdfTitle }) => {
          localStorage.setItem(
            'memry_tab_state',
            JSON.stringify({
              version: 2,
              tabGroups: {
                g1: {
                  id: 'g1',
                  activeTabId: 'file-tab',
                  tabs: [
                    {
                      id: 'file-tab',
                      type: 'file',
                      title: pdfTitle,
                      icon: 'file',
                      path: `/file/${fileId}`,
                      entityId: fileId,
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
        { fileId, pdfTitle }
      )
      await page.reload()
      await page.waitForLoadState('domcontentloaded')

      // onLoadSuccess sets numPages=1; the toolbar then shows page 1 of 1 — the
      // current page is an editable input, the total is the text beside it — and
      // react-pdf paints the page to a <canvas>. Both prove the worker ran.
      const pageInput = page.getByTestId('pdf-page-input')
      await expect(pageInput).toHaveValue('1', { timeout: 30_000 })
      await expect(page.getByText('/ 1')).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
    } finally {
      fs.rmSync(importDir, { recursive: true, force: true })
    }
  })
})
