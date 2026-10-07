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
import { FileTextRunner, HTML_TEXT_MAX_BYTES, type FileTextDeps } from './runner'

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
        appVersion: '1.0.0',
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

/** The job of a filed file's own text. */
function jobOf(db: IndexDb, id: string): ReturnType<typeof getFileTextJob> {
  return getFileTextJob(db, { noteId: id, source: '' })
}

async function settled(db: IndexDb, id: string, status: 'done' | 'failed'): Promise<void> {
  await vi.waitFor(() => expect(jobOf(db, id)?.status).toBe(status))
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
    expect(jobOf(harness.db, 'pdf-1')?.pageCount).toBe(2)
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
    expect(jobOf(harness.db, 'img-1')?.pageCount).toBe(1)
  })

  it('leaves audio files alone', async () => {
    seedFile(harness, 'audio-1', 'memo.mp3', 'audio')
    seedFile(harness, 'img-1', 'photo.png', 'image')
    harness.imageText = 'text'

    start()
    await settled(harness.db, 'img-1', 'done')

    expect(jobOf(harness.db, 'audio-1')).toBeUndefined()
  })

  it('resumes after the last stored page when stopped mid-file', async () => {
    seedFile(harness, 'pdf-1', 'book.pdf', 'pdf')
    harness.pages = [{ layer: 'chapter one' }, { hangs: true }, { layer: 'chapter three' }]

    const first = start()
    await vi.waitFor(() => expect(pagesOf(harness.db, 'pdf-1')).toHaveLength(1))
    await vi.waitFor(() => expect(harness.inFlight.size).toBe(1))
    await first.stop()

    expect(pagesOf(harness.db, 'pdf-1').map((page) => page.part)).toEqual([1])
    expect(jobOf(harness.db, 'pdf-1')?.status).toBe('pending')

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
    expect(jobOf(harness.db, 'pdf-1')?.error).toBe('Pages up to 3 could not be read')
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

    expect(jobOf(harness.db, 'pdf-1')).toMatchObject({
      status: 'failed',
      error: 'Password required'
    })
  })

  it('fails a file that is gone by its turn instead of retrying it forever', async () => {
    seedFile(harness, 'a-img', 'first.png', 'image')
    seedFile(harness, 'b-img', 'second.png', 'image')

    start({
      recognize: async () => {
        fs.rmSync(path.join(vaultDir, 'second.png'), { force: true })
        return 'first file'
      }
    })
    await settled(harness.db, 'b-img', 'failed')

    expect(jobOf(harness.db, 'b-img')?.error).toBe('File not found')
    expect(getExtractedText(harness.db, 'a-img')).toBe('first file')
  })

  it('reads a file rewritten before its turn once, under the bytes it ended with', async () => {
    seedFile(harness, 'a-img', 'first.png', 'image')
    seedFile(harness, 'b-img', 'second.png', 'image')
    let secondReads = 0

    const runner = start({
      recognize: async (source) => {
        if (source.kind === 'file' && source.path.endsWith('first.png')) {
          fs.writeFileSync(path.join(vaultDir, 'second.png'), 'rewritten with more bytes')
          return 'first file'
        }
        if (source.kind === 'file' && source.path.endsWith('second.png')) secondReads++
        return 'new words'
      }
    })
    await vi.waitFor(() => expect(jobOf(harness.db, 'b-img')?.status).toBe('done'), {
      timeout: 5_000
    })
    seedFile(harness, 'c-img', 'third.png', 'image')
    runner.noteChanged('b-img')
    runner.noteChanged('c-img')
    await settled(harness.db, 'c-img', 'done')

    expect(getExtractedText(harness.db, 'b-img')).toBe('new words')
    expect(secondReads).toBe(1)
  })

  it('reads a failed file again once a day has passed since it failed', async () => {
    seedFile(harness, 'img-1', 'scan.png', 'image')
    const first = start({
      recognize: async () => {
        throw new Error('OCR worker exited before it was ready (code 1)')
      }
    })
    await settled(harness.db, 'img-1', 'failed')
    await first.stop()

    harness.db.run(sql`
      UPDATE file_text_jobs SET updated_at = ${new Date(Date.now() - 2 * 86_400_000).toISOString()}
      WHERE note_id = 'img-1'
    `)
    harness.imageText = 'read at last'
    start()
    await settled(harness.db, 'img-1', 'done')

    expect(pagesOf(harness.db, 'img-1')).toEqual([{ part: 1, method: 'ocr', text: 'read at last' }])
  })

  it('reads a failed file again under a new app version, keeping the pages it did read', async () => {
    seedFile(harness, 'pdf-1', 'scan.pdf', 'pdf')
    harness.pages = [{ layer: 'cover' }, { fails: true }, { fails: true }, { fails: true }]
    const first = start()
    await settled(harness.db, 'pdf-1', 'failed')
    await first.stop()

    harness.pages = [
      { layer: 'read again' },
      { scanned: 'two' },
      { scanned: 'three' },
      { scanned: 'four' }
    ]
    const sameVersion = start()
    seedFile(harness, 'img-1', 'later.png', 'image')
    sameVersion.noteChanged('img-1')
    await settled(harness.db, 'img-1', 'done')
    expect(jobOf(harness.db, 'pdf-1')?.status).toBe('failed')
    await sameVersion.stop()

    start({ appVersion: '1.0.1' })
    await settled(harness.db, 'pdf-1', 'done')

    expect(pagesOf(harness.db, 'pdf-1').map((page) => page.text)).toEqual([
      'cover',
      'two',
      'three',
      'four'
    ])
  })

  it('reads the unreadable pages of a finished PDF again under a new app version', async () => {
    seedFile(harness, 'pdf-1', 'scan.pdf', 'pdf')
    harness.pages = [{ fails: true }, { fails: true }, { layer: 'three' }]
    const first = start()
    await settled(harness.db, 'pdf-1', 'done')
    await first.stop()

    harness.pages = [{ scanned: 'one' }, { scanned: 'two' }, { layer: 'not read again' }]
    const sameVersion = start()
    seedFile(harness, 'img-1', 'later.png', 'image')
    sameVersion.noteChanged('img-1')
    await settled(harness.db, 'img-1', 'done')
    expect(pagesOf(harness.db, 'pdf-1').map((page) => page.method)).toEqual([
      'unreadable',
      'unreadable',
      'pdf-text'
    ])
    await sameVersion.stop()

    start({ appVersion: '1.0.1' })
    await vi.waitFor(() =>
      expect(pagesOf(harness.db, 'pdf-1').map((page) => page.text)).toEqual(['one', 'two', 'three'])
    )
    expect(jobOf(harness.db, 'pdf-1')?.status).toBe('done')
  })

  it('re-reads every unreadable page of a retried PDF, including one before a good page', async () => {
    seedFile(harness, 'pdf-1', 'scan.pdf', 'pdf')
    harness.pages = [
      { layer: 'one' },
      { fails: true },
      { layer: 'three' },
      { fails: true },
      { fails: true },
      { fails: true }
    ]
    const first = start()
    await settled(harness.db, 'pdf-1', 'failed')
    await first.stop()

    harness.pages = [
      { layer: 'not read again' },
      { scanned: 'two' },
      { layer: 'not read again' },
      { scanned: 'four' },
      { scanned: 'five' },
      { scanned: 'six' }
    ]
    start({ appVersion: '1.0.1' })
    await settled(harness.db, 'pdf-1', 'done')

    expect(pagesOf(harness.db, 'pdf-1').map((page) => page.text)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
      'six'
    ])
  })

  it('reads the PDFs and images a note embeds from its attachments folder into that note', async () => {
    const attachments = path.join(vaultDir, 'attachments', 'md-1')
    fs.mkdirSync(attachments, { recursive: true })
    fs.writeFileSync(path.join(attachments, 'shot.png'), 'png bytes')
    fs.writeFileSync(path.join(attachments, 'scan.pdf'), 'pdf bytes')
    fs.writeFileSync(path.join(attachments, 'removed.png'), 'png bytes')
    fs.writeFileSync(path.join(attachments, 'notes.txt'), 'not read')
    const notePath = path.join(vaultDir, 'notes', 'plan.md')
    fs.mkdirSync(path.dirname(notePath), { recursive: true })
    fs.writeFileSync(
      notePath,
      '![](../attachments/md-1/shot.png)\n\n<!-- file:{"url":"../attachments/md-1/scan.pdf"} -->\n'
    )
    harness.db.run(sql`
      INSERT INTO note_cache (id, path, title, created_at, modified_at)
      VALUES ('md-1', 'notes/plan.md', 'Plan', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    harness.imageText = 'Pasted screenshot text'
    harness.pages = [{ scanned: 'Scanned receipt' }]

    const runner = start()
    await vi.waitFor(() =>
      expect(getExtractedText(harness.db, 'md-1')).toBe('Scanned receipt\n\nPasted screenshot text')
    )
    expect(harness.changed).toContain('md-1')
    expect(
      harness.db.all(sql`SELECT source FROM file_text_jobs WHERE note_id = 'md-1' ORDER BY source`)
    ).toEqual([{ source: 'scan.pdf' }, { source: 'shot.png' }])

    // The image block is gone from the note; its file stays on disk.
    fs.writeFileSync(notePath, '<!-- file:{"url":"../attachments/md-1/scan.pdf"} -->\n')
    runner.noteChanged('md-1')
    await vi.waitFor(() => expect(getExtractedText(harness.db, 'md-1')).toBe('Scanned receipt'))
    expect(fs.existsSync(path.join(attachments, 'shot.png'))).toBe(true)
  })

  it('reads the visible text of an HTML block a note embeds into that note', async () => {
    const attachments = path.join(vaultDir, 'attachments', 'md-1')
    fs.mkdirSync(attachments, { recursive: true })
    const html =
      '<!doctype html><html><head><title>Head title</title><style>.tide { color: red }</style></head>' +
      '<body><h1>Tidal&nbsp;chart</h1><p>Spring <b>tides</b> peak</p>' +
      '<script>const label = "</div>never indexed"</script>' +
      '<div>See [[Harbor Log]]</div><!-- hidden remark --></body></html>'
    fs.writeFileSync(path.join(attachments, 'chart.html'), html)
    fs.writeFileSync(path.join(attachments, 'unused.html'), '<p>Not embedded</p>')
    const notePath = path.join(vaultDir, 'plan.md')
    fs.writeFileSync(
      notePath,
      '<!-- file:{"url":"../attachments/md-1/chart.html","mimeType":"text/html"} -->\n'
    )
    harness.db.run(sql`
      INSERT INTO note_cache (id, path, title, created_at, modified_at)
      VALUES ('md-1', 'plan.md', 'Plan', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    const recognize = vi.fn(async () => 'never called')

    const runner = start({ recognize })
    await vi.waitFor(() =>
      expect(getExtractedText(harness.db, 'md-1')).toBe(
        'Tidal chart\n\nSpring tides peak\n\nSee [[Harbor Log]]'
      )
    )
    expect(
      harness.db.all(sql`SELECT source, part, method FROM extracted_text WHERE note_id = 'md-1'`)
    ).toEqual([{ source: 'chart.html', part: 1, method: 'html' }])
    expect(recognize).not.toHaveBeenCalled()
    expect(harness.changed).toContain('md-1')
    expect(fs.readFileSync(path.join(attachments, 'chart.html'), 'utf8')).toBe(html)

    // The block's file gets new bytes: its text is read again.
    fs.writeFileSync(path.join(attachments, 'chart.html'), '<p>Neap tides</p>')
    fs.utimesSync(path.join(attachments, 'chart.html'), new Date(), new Date(Date.now() + 5_000))
    runner.noteChanged('md-1')
    await vi.waitFor(() => expect(getExtractedText(harness.db, 'md-1')).toBe('Neap tides'))
  })

  it('never parses an HTML block file over the size cap, now or on a later retry', async () => {
    const attachments = path.join(vaultDir, 'attachments', 'md-1')
    fs.mkdirSync(attachments, { recursive: true })
    const htmlPath = path.join(attachments, 'huge.html')
    fs.writeFileSync(htmlPath, '<p>Oversized words</p>')
    // Sparse: the size is past the cap without writing the bytes.
    fs.truncateSync(htmlPath, HTML_TEXT_MAX_BYTES + 1)
    const notePath = path.join(vaultDir, 'plan.md')
    fs.writeFileSync(
      notePath,
      '<!-- file:{"url":"../attachments/md-1/huge.html","mimeType":"text/html"} -->\n'
    )
    harness.db.run(sql`
      INSERT INTO note_cache (id, path, title, created_at, modified_at)
      VALUES ('md-1', 'plan.md', 'Plan', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    const htmlJob = () => getFileTextJob(harness.db, { noteId: 'md-1', source: 'huge.html' })

    const first = start()
    await vi.waitFor(() => expect(htmlJob()?.status).toBe('failed'))
    expect(htmlJob()?.error).toMatch(/too large/i)
    expect(
      harness.db.all(
        sql`SELECT source, part, method, text FROM extracted_text WHERE note_id = 'md-1'`
      )
    ).toEqual([{ source: 'huge.html', part: 1, method: 'unreadable', text: '' }])
    const failedAt = htmlJob()?.updatedAt
    await first.stop()

    // A new app version retries failed jobs; an oversized HTML file is not one of them.
    fs.writeFileSync(path.join(attachments, 'shot.png'), 'png bytes')
    fs.appendFileSync(notePath, '![](attachments/md-1/shot.png)\n')
    harness.imageText = 'Pasted screenshot text'
    start({ appVersion: '2.0.0' })
    await vi.waitFor(() =>
      expect(getFileTextJob(harness.db, { noteId: 'md-1', source: 'shot.png' })?.status).toBe(
        'done'
      )
    )
    expect(htmlJob()?.status).toBe('failed')
    expect(htmlJob()?.updatedAt).toBe(failedAt)
  })

  it('compares the files of more changed notes than SQLite binds in one statement', async () => {
    const notePath = path.join(vaultDir, 'plan.md')
    fs.mkdirSync(path.join(vaultDir, 'attachments', 'md-1'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, 'attachments', 'md-1', 'shot.png'), 'png bytes')
    fs.writeFileSync(notePath, '![](attachments/md-1/shot.png)\n')
    harness.db.run(sql`
      INSERT INTO note_cache (id, path, title, created_at, modified_at)
      VALUES ('md-1', 'plan.md', 'Plan', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    harness.imageText = 'Pasted screenshot text'
    const runner = start()
    await vi.waitFor(() =>
      expect(getExtractedText(harness.db, 'md-1')).toBe('Pasted screenshot text')
    )

    fs.writeFileSync(notePath, 'The screenshot is gone.\n')
    seedFile(harness, 'img-1', 'scan.png', 'image')
    harness.imageText = 'Filed scan text'
    for (let i = 0; i < 40_000; i++) runner.noteChanged(`note-${i}`)
    runner.noteChanged('md-1')
    runner.noteChanged('img-1')
    await vi.waitFor(() => expect(jobOf(harness.db, 'img-1')?.status).toBe('done'), {
      timeout: 5_000
    })

    expect(getExtractedText(harness.db, 'img-1')).toBe('Filed scan text')
    expect(getExtractedText(harness.db, 'md-1')).toBe('')
  })

  it('compares a changed note again on the next pass when its pass fails', async () => {
    let failNextRead = false
    let failedReads = 0
    seedFile(harness, 'img-1', 'first.png', 'image')
    harness.imageText = 'Whiteboard text'
    const runner = start({
      getDb: () => {
        if (failNextRead) {
          failNextRead = false
          failedReads++
          throw new Error('Index database not initialized')
        }
        return harness.db
      }
    })
    await settled(harness.db, 'img-1', 'done')

    seedFile(harness, 'img-2', 'second.png', 'image')
    failNextRead = true
    runner.noteChanged('img-2')
    await vi.waitFor(() => expect(failedReads).toBe(1))
    seedFile(harness, 'img-3', 'third.png', 'image')
    runner.noteChanged('img-3')
    await settled(harness.db, 'img-3', 'done')
    await settled(harness.db, 'img-2', 'done')

    expect(getExtractedText(harness.db, 'img-2')).toBe('Whiteboard text')
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
