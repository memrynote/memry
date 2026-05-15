import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect } from './fixtures'
import { PNG_BYTES, ready, uniqueLabel } from './utils/desktop-test-helpers'

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
      expect(fs.existsSync(path.join(testVaultPath, 'notes', importFileName))).toBe(true)

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

      const protocolResponse = await page.evaluate(async (fileId) => {
        const file = await window.api.notes.getFile(fileId)
        if (!file) return null

        const response = await fetch(`memry-file://local${file.absolutePath}`)
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          byteLength: (await response.arrayBuffer()).byteLength
        }
      }, importedFile!.id)
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
})
