import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const handles = vi.hoisted(() => ({
  data: null as unknown,
  index: null as unknown,
  vault: ''
}))

vi.mock('../../database/client', () => ({
  getDatabase: () => handles.data,
  getIndexDatabase: () => handles.index
}))

vi.mock('../../vault/notes', () => ({
  toAbsolutePath: (relativePath: string) => path.join(handles.vault, relativePath)
}))

import { buildNotePushPayload } from './note-handler-sync-helpers'

const EXTRACTED = 'Heron count at dawn'

describe('note push payloads and extracted text', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    handles.data = data.db
    handles.index = index.db
    handles.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-push-extracted-'))
    fs.mkdirSync(path.join(handles.vault, 'notes'))
    fs.writeFileSync(path.join(handles.vault, 'notes/plan.md'), '# Plan\n\nPlan body\n')

    for (const [id, notePath, fileType, mimeType] of [
      ['pdf-1', 'files/scan.pdf', 'pdf', 'application/pdf'],
      ['md-1', 'notes/plan.md', 'markdown', null]
    ] as const) {
      data.db.run(sql`
        INSERT INTO note_metadata (id, path, title, file_type, mime_type, created_at, modified_at)
        VALUES (${id}, ${notePath}, ${id}, ${fileType}, ${mimeType},
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `)
      index.db.run(sql`
        INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
        VALUES (${id}, ${notePath}, ${id}, ${fileType},
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `)
      index.db.run(sql`
        INSERT INTO extracted_text (note_id, part, method, text)
        VALUES (${id}, 1, 'ocr', ${EXTRACTED})
      `)
    }
  })

  afterEach(() => {
    data.close()
    index.close()
    fs.rmSync(handles.vault, { recursive: true, force: true })
  })

  it('never sends text extracted on this device, for a filed file or a note', () => {
    const pdf = buildNotePushPayload('pdf-1', 'create')
    const note = buildNotePushPayload('md-1', 'create')

    expect(pdf).not.toContain(EXTRACTED)
    expect(note).not.toContain(EXTRACTED)
    expect(Object.keys(JSON.parse(pdf ?? '{}')).sort()).toEqual([
      'attachmentId',
      'clock',
      'createdAt',
      'emoji',
      'fileType',
      'folderPath',
      'mimeType',
      'modifiedAt',
      'title'
    ])
    expect(JSON.parse(note ?? '{}').content).toBe('# Plan\n\nPlan body\n')
  })
})
