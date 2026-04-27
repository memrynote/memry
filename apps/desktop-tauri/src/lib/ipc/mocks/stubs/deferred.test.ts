import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { mockRouter } from '../index'
import { attachmentsRoutes } from './attachments'
import { exportRoutes } from './export'
import { importRoutes } from './import'
import { versionsRoutes } from './versions'

describe('deferred editor-adjacent mock stubs', () => {
  it('attachments routes return M6 safe fallback shapes', async () => {
    await expect(attachmentsRoutes.notes_upload_attachment!(undefined)).resolves.toEqual({
      success: false,
      error: 'attachments-deferred-m6'
    })
    await expect(attachmentsRoutes.notes_list_attachments!(undefined)).resolves.toEqual([])
    await expect(attachmentsRoutes.notes_delete_attachment!(undefined)).resolves.toEqual({
      success: false,
      error: 'attachments-deferred-m6'
    })
  })

  it('export routes return M8 safe fallback shapes', async () => {
    await expect(exportRoutes.notes_export_pdf!(undefined)).resolves.toEqual({
      success: false,
      error: 'export-deferred-m8'
    })
    await expect(exportRoutes.notes_export_html!(undefined)).resolves.toEqual({
      success: false,
      error: 'export-deferred-m8'
    })
  })

  it('version routes return M8 safe fallback shapes', async () => {
    await expect(versionsRoutes.notes_get_versions!(undefined)).resolves.toEqual([])
    await expect(versionsRoutes.notes_get_version!(undefined)).resolves.toBeNull()
    await expect(versionsRoutes.notes_restore_version!(undefined)).resolves.toEqual({
      success: false,
      note: null,
      error: 'versions-deferred-m8'
    })
    await expect(versionsRoutes.notes_delete_version!(undefined)).resolves.toEqual({
      success: false,
      error: 'versions-deferred-m8'
    })
  })

  it('import routes return M8 safe fallback shapes', async () => {
    await expect(importRoutes.notes_import_files!(undefined)).resolves.toEqual({
      success: false,
      imported: 0,
      failed: 0,
      errors: ['import-deferred-m8'],
      importedFiles: []
    })
    await expect(importRoutes.notes_show_import_dialog!(undefined)).resolves.toEqual({
      canceled: true,
      filePaths: []
    })
  })

  it('wires deferred routes through the mock router', async () => {
    await expect(mockRouter('notes_list_attachments')).resolves.toEqual([])
    await expect(mockRouter('notes_export_pdf')).resolves.toEqual({
      success: false,
      error: 'export-deferred-m8'
    })
    await expect(mockRouter('notes_get_versions')).resolves.toEqual([])
    await expect(mockRouter('notes_show_import_dialog')).resolves.toEqual({
      canceled: true,
      filePaths: []
    })
  })

  it('keeps milestone markers in each stub source file', () => {
    expect(readStub('attachments.ts')).toContain('deferred:M6')
    expect(readStub('export.ts')).toContain('deferred:M8')
    expect(readStub('versions.ts')).toContain('deferred:M8')
    expect(readStub('import.ts')).toContain('deferred:M8')
  })
})

function readStub(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8')
}
