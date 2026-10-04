import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestIndexDb } from '@tests/utils/test-db'

const index = vi.hoisted(() => ({ db: null as unknown }))
const published = vi.hoisted(() => [] as unknown[])
const helpers = vi.hoisted(() => ({ ocrStopped: 0, hostClosed: 0 }))

vi.mock('../database', () => ({ getIndexDatabase: () => index.db }))
vi.mock('../projections', () => ({
  publishProjectionEvent: (event: unknown) => published.push(event)
}))
vi.mock('./ocr-engine', () => ({
  recognizeText: async () => 'Quarterly plan',
  stopOcr: () => {
    helpers.ocrStopped++
  }
}))
vi.mock('./pdf-host', () => ({
  openPdfDocument: async () => {
    throw new Error('no PDFs in this test')
  },
  closePdfHost: () => {
    helpers.hostClosed++
  }
}))

import { fileTextNoteChanged, startFileTextExtraction, stopFileTextExtraction } from './index'

describe('file text extraction', () => {
  afterEach(async () => {
    await stopFileTextExtraction()
  })

  it('reads a filed image after start, publishes the change, and stops its helpers on stop', async () => {
    const test = createTestIndexDb()
    index.db = test.db
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-file-text-index-'))
    try {
      startFileTextExtraction(vaultPath)
      fs.writeFileSync(path.join(vaultPath, 'board.png'), 'png bytes')
      test.db.run(sql`
        INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
        VALUES ('img-1', 'board.png', 'board', 'image',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `)
      fileTextNoteChanged('img-1')

      await vi.waitFor(() =>
        expect(published).toContainEqual({ type: 'note.text-extracted', noteId: 'img-1' })
      )
      await stopFileTextExtraction()

      expect(helpers).toEqual({ ocrStopped: 1, hostClosed: 1 })
    } finally {
      test.close()
      fs.rmSync(vaultPath, { recursive: true, force: true })
    }
  })
})
