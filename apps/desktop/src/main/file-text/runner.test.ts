import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { IndexDb } from '../database/types'
import {
  getExtractedText,
  getFileTextJob,
  readExtractedPages
} from '../database/queries/extracted-text'
import type { OcrImageSource } from './ocr-protocol'
import type { PdfDocument } from './pdf-host'
import { FileTextRunner, type FileTextDeps } from './runner'

/** One fake PDF page: a text layer, or what OCR reads off the rendered page. */
type FakePage = { layer: string } | { scanned: string } | { fails: true } | { hangs: true }

interface Harness {
  db: IndexDb
  vaultDir: string
  pages: FakePage[]
  imageText: string
  changed: string[]
  inFlight: Set<(error: Error) => void>
  runner: (overrides?: Partial<FileTextDeps>) => FileTextRunner
}

function createHarness(index: TestDatabaseResult, vaultDir: string): Harness {
  const db = index.db as unknown as IndexDb
  const harness: Harness = {
    db,
    vaultDir,
    pages: [],
    imageText: '',
    changed: [],
    inFlight: new Set(),
    runner: (overrides) =>
      new FileTextRunner({
        vaultPath: vaultDir,
        getDb: () => db,
        recognize: async (source: OcrImageSource) => {
          if (source.kind === 'file') return harness.imageText
          const page = harness.pages[source.data[0] - 1]
          if ('scanned' in page) return page.scanned
          throw new Error('OCR failed')
        },
        openPdf: async () => openFakePdf(harness),
        release: () => {
          for (const fail of harness.inFlight) fail(new Error('released'))
          harness.inFlight.clear()
        },
        textChanged: (noteId) => harness.changed.push(noteId),
        ...overrides
      })
  }
  return harness
}

function openFakePdf(harness: Harness): PdfDocument {
  return {
    pageCount: harness.pages.length,
    async pageText(pageNumber) {
      const page = harness.pages[pageNumber - 1]
      if ('hangs' in page) {
        return new Promise<string>((_resolve, reject) => harness.inFlight.add(reject))
      }
      if ('fails' in page) throw new Error('page failed')
      return 'layer' in page ? page.layer : '   \n '
    },
    async renderPage(pageNumber) {
      return { png: Uint8Array.of(pageNumber), width: 10, height: 10 }
    },
    async close() {}
  }
}

function seedFile(harness: Harness, id: string, relativePath: string, fileType: string): void {
  const absolutePath = path.join(harness.vaultDir, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, `bytes of ${relativePath}`)
  harness.db.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
    VALUES (${id}, ${relativePath}, ${path.parse(relativePath).name}, ${fileType},
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)
}

function pagesOf(db: IndexDb, id: string): Array<{ part: number; method: string; text: string }> {
  return db.all(
    sql`SELECT part, method, text FROM extracted_text WHERE note_id = ${id} ORDER BY part`
  )
}

async function settled(db: IndexDb, id: string, status: 'done' | 'failed'): Promise<void> {
  await vi.waitFor(() => expect(getFileTextJob(db, id)?.status).toBe(status))
}

describe('FileTextRunner', () => {
  let index: TestDatabaseResult
  let vaultDir: string
  let harness: Harness
  let running: FileTextRunner[]

  beforeEach(() => {
    index = createTestIndexDb()
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-file-text-'))
    harness = createHarness(index, vaultDir)
    running = []
  })

  afterEach(async () => {
    await Promise.all(running.map((runner) => runner.stop()))
    index.close()
    fs.rmSync(vaultDir, { recursive: true, force: true })
  })

  function start(overrides?: Partial<FileTextDeps>): FileTextRunner {
    const runner = harness.runner(overrides)
    running.push(runner)
    runner.start()
    return runner
  }

  it('reads a PDF page from its text layer and runs OCR only on a page without one', async () => {
    seedFile(harness, 'pdf-1', 'scans/logbook.pdf', 'pdf')
    harness.pages = [{ layer: 'Lighthouse  keepers\n\n\n\nlog' }, { scanned: 'Heron migration' }]

    start()
    await settled(harness.db, 'pdf-1', 'done')

    expect(pagesOf(harness.db, 'pdf-1')).toEqual([
      { part: 1, method: 'pdf-text', text: 'Lighthouse keepers\n\nlog' },
      { part: 2, method: 'ocr', text: 'Heron migration' }
    ])
    expect(getExtractedText(harness.db, 'pdf-1')).toBe(
      'Lighthouse keepers\n\nlog\n\nHeron migration'
    )
    expect(getFileTextJob(harness.db, 'pdf-1')?.pageCount).toBe(2)
    expect(harness.changed.at(-1)).toBe('pdf-1')
  })

  it('reads an image with OCR as its one page', async () => {
    seedFile(harness, 'img-1', 'photos/whiteboard.png', 'image')
    harness.imageText = 'Quarterly plan'

    start()
    await settled(harness.db, 'img-1', 'done')

    expect(pagesOf(harness.db, 'img-1')).toEqual([
      { part: 1, method: 'ocr', text: 'Quarterly plan' }
    ])
    expect(getFileTextJob(harness.db, 'img-1')?.pageCount).toBe(1)
  })

  it('leaves audio files alone', async () => {
    seedFile(harness, 'audio-1', 'memo.mp3', 'audio')
    seedFile(harness, 'img-1', 'photo.png', 'image')
    harness.imageText = 'text'

    start()
    await settled(harness.db, 'img-1', 'done')

    expect(getFileTextJob(harness.db, 'audio-1')).toBeUndefined()
  })

  it('resumes after the last stored page when stopped mid-file', async () => {
    seedFile(harness, 'pdf-1', 'book.pdf', 'pdf')
    harness.pages = [{ layer: 'chapter one' }, { hangs: true }, { layer: 'chapter three' }]

    const first = start()
    await vi.waitFor(() => expect(pagesOf(harness.db, 'pdf-1')).toHaveLength(1))
    await vi.waitFor(() => expect(harness.inFlight.size).toBe(1))
    await first.stop()

    expect(pagesOf(harness.db, 'pdf-1').map((page) => page.part)).toEqual([1])
    expect(getFileTextJob(harness.db, 'pdf-1')?.status).toBe('pending')

    harness.pages = [{ layer: 'read again' }, { layer: 'chapter two' }, { layer: 'chapter three' }]
    start()
    await settled(harness.db, 'pdf-1', 'done')

    expect(pagesOf(harness.db, 'pdf-1').map((page) => page.text)).toEqual([
      'chapter one',
      'chapter two',
      'chapter three'
    ])
  })

  it('starts a file over when its bytes change, and keeps its text when it only moves', async () => {
    seedFile(harness, 'img-1', 'scan.png', 'image')
    harness.imageText = 'first draft'
    const runner = start()
    await settled(harness.db, 'img-1', 'done')

    harness.db.run(sql`UPDATE note_cache SET path = 'moved/scan.png' WHERE id = 'img-1'`)
    fs.mkdirSync(path.join(vaultDir, 'moved'))
    fs.renameSync(path.join(vaultDir, 'scan.png'), path.join(vaultDir, 'moved/scan.png'))
    harness.imageText = 'not read for a move'
    runner.noteChanged('img-1')
    seedFile(harness, 'img-2', 'other.png', 'image')
    runner.noteChanged('img-2')
    await settled(harness.db, 'img-2', 'done')
    expect(getExtractedText(harness.db, 'img-1')).toBe('first draft')

    fs.writeFileSync(path.join(vaultDir, 'moved/scan.png'), 'different, longer bytes')
    harness.imageText = 'second draft'
    runner.noteChanged('img-1')
    await vi.waitFor(() => expect(getExtractedText(harness.db, 'img-1')).toBe('second draft'))
  })

  it('stores a page that fails twice as unreadable and goes on to the next', async () => {
    seedFile(harness, 'pdf-1', 'damaged.pdf', 'pdf')
    harness.pages = [{ layer: 'cover' }, { fails: true }, { layer: 'index' }]

    start()
    await settled(harness.db, 'pdf-1', 'done')

    expect(pagesOf(harness.db, 'pdf-1')).toEqual([
      { part: 1, method: 'pdf-text', text: 'cover' },
      { part: 2, method: 'unreadable', text: '' },
      { part: 3, method: 'pdf-text', text: 'index' }
    ])
  })

  it('gives up on a file after three unreadable pages in a row', async () => {
    seedFile(harness, 'pdf-1', 'corrupt.pdf', 'pdf')
    harness.pages = [{ fails: true }, { fails: true }, { fails: true }, { layer: 'never read' }]

    start()
    await settled(harness.db, 'pdf-1', 'failed')

    expect(pagesOf(harness.db, 'pdf-1').map((page) => page.method)).toEqual([
      'unreadable',
      'unreadable',
      'unreadable'
    ])
    expect(getFileTextJob(harness.db, 'pdf-1')?.error).toBe('Pages up to 3 could not be read')
  })

  it('fails a PDF that cannot be opened and moves on to the next file', async () => {
    seedFile(harness, 'pdf-1', 'locked.pdf', 'pdf')
    seedFile(harness, 'img-1', 'after.png', 'image')
    harness.imageText = 'still read'

    start({
      openPdf: async () => {
        throw new Error('Password required')
      }
    })
    await settled(harness.db, 'img-1', 'done')

    expect(getFileTextJob(harness.db, 'pdf-1')).toMatchObject({
      status: 'failed',
      error: 'Password required'
    })
  })

  it('pages a long text out in chunks a reader can continue from', async () => {
    seedFile(harness, 'pdf-1', 'long.pdf', 'pdf')
    harness.pages = [
      { layer: 'a'.repeat(60) },
      { layer: 'b'.repeat(60) },
      { layer: 'c'.repeat(10) }
    ]

    start()
    await settled(harness.db, 'pdf-1', 'done')

    const first = readExtractedPages(harness.db, 'pdf-1', 1, 100)
    expect(first.pages.map((page) => page.page)).toEqual([1])
    expect(first.nextPage).toBe(2)
    const rest = readExtractedPages(harness.db, 'pdf-1', 2, 100)
    expect(rest.pages.map((page) => page.page)).toEqual([2, 3])
    expect(rest.nextPage).toBeNull()
  })
})
