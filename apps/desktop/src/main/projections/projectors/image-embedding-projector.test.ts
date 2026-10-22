import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sqliteVec from 'sqlite-vec'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { FileType } from '@memry/shared/file-types'
import { extractedText, fileTextJobs } from '@memry/db-schema/schema/extracted-text'
import {
  cleanupTestDatabase,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

vi.mock('../../database', () => ({
  getIndexDatabase: vi.fn(),
  getRawIndexDatabase: vi.fn()
}))

const embedImage = vi.hoisted(() => vi.fn())
const enabled = vi.hoisted(() => ({ value: true }))
vi.mock('../../lib/image-embedding', () => ({
  embedImage,
  isImageEmbeddingEnabled: () => enabled.value
}))

import { getIndexDatabase, getRawIndexDatabase } from '../../database'
import { IMAGE_EMBEDDING_INPUT_VERSION } from '../../lib/embedding-input'
import { createImageEmbeddingProjector } from './image-embedding-projector'

const openPdf = vi.hoisted(() => vi.fn())
const NOW = '2026-05-09T00:00:00.000Z'

describe('image embedding projector', () => {
  let indexDb: TestDatabaseResult
  let vault: string

  const keys = (): string[] =>
    (
      indexDb.sqlite.prepare('SELECT image_key FROM vec_images ORDER BY image_key').all() as Array<{
        image_key: string
      }>
    ).map((row) => row.image_key)

  const addNote = (id: string, filePath: string, fileType: FileType): void => {
    indexDb.db
      .insert(noteCache)
      .values({ id, path: filePath, title: id, fileType, createdAt: NOW, modifiedAt: NOW })
      .run()
  }

  const addJob = (
    noteId: string,
    source: string,
    signature: string,
    status: 'pending' | 'done' | 'failed' = 'done'
  ): void => {
    indexDb.sqlite
      .prepare('DELETE FROM file_text_jobs WHERE note_id = ? AND source = ?')
      .run(noteId, source)
    indexDb.db
      .insert(fileTextJobs)
      .values({ noteId, source, signature, status, appVersion: '1', updatedAt: NOW })
      .run()
  }

  const addFile = (relative: string): void => {
    mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true })
    writeFileSync(path.join(vault, relative), 'bytes')
  }

  const projector = () => createImageEmbeddingProjector(() => vault, openPdf)

  const addText = (noteId: string, source: string, part: number, text: string): void => {
    indexDb.db.insert(extractedText).values({ noteId, source, part, method: 'ocr', text }).run()
  }

  const fakePdf = (pageCount: number) => {
    const document = {
      pageCount,
      pageText: vi.fn(),
      renderPage: vi.fn(async (page: number) => ({
        png: Uint8Array.from([page]),
        width: 1,
        height: 1
      })),
      close: vi.fn().mockResolvedValue(undefined)
    }
    openPdf.mockResolvedValue(document)
    return document
  }
  const extracted = (noteId: string) => ({ type: 'note.text-extracted', noteId }) as const

  beforeEach(() => {
    vault = mkdtempSync(path.join(os.tmpdir(), 'memry-image-embed-'))
    indexDb = createTestIndexDb()
    sqliteVec.load(indexDb.sqlite)
    indexDb.sqlite.exec(
      'CREATE VIRTUAL TABLE vec_images USING vec0(image_key TEXT PRIMARY KEY, embedding float[3] distance_metric=cosine)'
    )
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)
    vi.mocked(getRawIndexDatabase).mockReturnValue(indexDb.sqlite)
    embedImage.mockReset().mockResolvedValue(Float32Array.from([1, 0, 0]))
    openPdf.mockReset()
    enabled.value = true
  })

  afterEach(() => {
    cleanupTestDatabase(indexDb)
    rmSync(vault, { recursive: true, force: true })
  })

  it('embeds a filed image and an attached image once their text job is done', async () => {
    addNote('img', 'cat.png', 'image')
    addNote('note', 'note.md', 'markdown')
    addFile('cat.png')
    addFile('attachments/note/dog.jpg')
    addJob('img', '', '5:1')
    addJob('note', 'dog.jpg', '5:2')

    await projector().project(extracted('img'))
    await projector().project(extracted('note'))

    expect(keys()).toEqual(['img/', 'note/dog.jpg'])
  })

  it('does not embed an image whose text job is still pending, and keeps its old vector', async () => {
    addNote('img', 'cat.png', 'image')
    addFile('cat.png')
    addJob('img', '', '5:1')
    await projector().project(extracted('img'))
    embedImage.mockClear()

    addJob('img', '', '9:2', 'pending')
    await projector().project(extracted('img'))

    expect(embedImage).not.toHaveBeenCalled()
    expect(keys()).toEqual(['img/'])
  })

  it('embeds again when the bytes change and not when nothing did', async () => {
    addNote('img', 'cat.png', 'image')
    addFile('cat.png')
    addJob('img', '', '5:1')
    await projector().project(extracted('img'))
    await projector().project(extracted('img'))
    expect(embedImage).toHaveBeenCalledTimes(1)

    addJob('img', '', '9:2')
    await projector().project(extracted('img'))
    expect(embedImage).toHaveBeenCalledTimes(2)
  })

  it('drops the vector of an attachment the note no longer embeds', async () => {
    addNote('note', 'note.md', 'markdown')
    addFile('attachments/note/dog.jpg')
    addJob('note', 'dog.jpg', '5:2')
    await projector().project(extracted('note'))
    expect(keys()).toEqual(['note/dog.jpg'])

    indexDb.sqlite.prepare('DELETE FROM file_text_jobs').run()
    await projector().project(extracted('note'))

    expect(keys()).toEqual([])
    expect(indexDb.sqlite.prepare('SELECT * FROM image_embedding_state').all()).toEqual([])
  })

  it('drops the vector of a deleted note', async () => {
    addNote('img', 'cat.png', 'image')
    addFile('cat.png')
    addJob('img', '', '5:1')
    await projector().project(extracted('img'))

    // The indexer removes the note_cache row first, and the state rows cascade.
    indexDb.sqlite.prepare("DELETE FROM note_cache WHERE id = 'img'").run()
    await projector().project({ type: 'note.deleted', noteId: 'img' })

    expect(keys()).toEqual([])
  })

  it('keeps a vector across a rename, since the note id is its key', async () => {
    addNote('img', 'cat.png', 'image')
    addFile('cat.png')
    addJob('img', '', '5:1')
    await projector().project(extracted('img'))
    indexDb.sqlite.prepare("UPDATE note_cache SET path = 'pets/cat.png' WHERE id = 'img'").run()
    addFile('pets/cat.png')
    embedImage.mockClear()

    await projector().reconcile()

    expect(embedImage).not.toHaveBeenCalled()
    expect(keys()).toEqual(['img/'])
  })

  it('backfills images that existed before, and prunes vectors of vanished notes', async () => {
    addNote('a', 'a.png', 'image')
    addFile('a.png')
    addJob('a', '', '5:1')
    indexDb.sqlite
      .prepare('INSERT INTO vec_images (image_key, embedding) VALUES (?, ?)')
      .run('ghost/', Float32Array.from([0, 1, 0]))

    await projector().reconcile()

    expect(keys()).toEqual(['a/'])
  })

  it('re-embeds a vector written under an older input version, keeping it until then', async () => {
    addNote('a', 'a.png', 'image')
    addFile('a.png')
    addJob('a', '', '5:1')
    await projector().project(extracted('a'))
    indexDb.sqlite.prepare('UPDATE image_embedding_state SET input_version = 0').run()
    embedImage.mockClear()

    await projector().reconcile()

    expect(embedImage).toHaveBeenCalledTimes(1)
    expect(
      indexDb.sqlite.prepare('SELECT input_version AS v FROM image_embedding_state').get()
    ).toEqual({ v: IMAGE_EMBEDDING_INPUT_VERSION })
  })

  it('never calls the encoder when image embeddings are off', async () => {
    enabled.value = false
    addNote('a', 'a.png', 'image')
    addFile('a.png')
    addJob('a', '', '5:1')

    await projector().reconcile()
    await projector().project(extracted('a'))

    expect(embedImage).not.toHaveBeenCalled()
    expect(keys()).toEqual([])
  })

  it('stops a pass after repeated failures and stores nothing for them', async () => {
    embedImage.mockResolvedValue(null)
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      addNote(id, `${id}.png`, 'image')
      addFile(`${id}.png`)
      addJob(id, '', '5:1')
    }

    await projector().reconcile()

    expect(embedImage).toHaveBeenCalledTimes(3)
    expect(keys()).toEqual([])
  })

  it('skips SVG and files that are not images', async () => {
    addNote('note', 'note.md', 'markdown')
    addFile('attachments/note/logo.svg')
    addFile('attachments/note/report.pdf')
    addJob('note', 'logo.svg', '5:1')
    addJob('note', 'report.pdf', '5:1')

    await projector().reconcile()

    expect(embedImage).not.toHaveBeenCalled()
  })

  it('embeds an image alone when no text was read from it', async () => {
    addNote('img', 'cat.png', 'image')
    addFile('cat.png')
    addJob('img', '', '5:1')

    await projector().project(extracted('img'))

    expect(embedImage).toHaveBeenCalledWith(expect.any(Buffer), undefined)
  })

  it('interleaves an image with its OCR text at the page budget', async () => {
    addNote('img', 'shot.png', 'image')
    addFile('shot.png')
    addJob('img', '', '5:1')
    addText('img', '', 1, 'Quarterly invoice total 42 EUR')

    await projector().project(extracted('img'))

    expect(embedImage).toHaveBeenCalledWith(expect.any(Buffer), {
      text: 'title: none | text: Quarterly invoice total 42 EUR <|image|>',
      softTokens: 280
    })
  })

  it('embeds each page of a PDF with that page text, up to the page cap', async () => {
    addNote('doc', 'scan.pdf', 'pdf')
    addFile('scan.pdf')
    addJob('doc', '', '5:1')
    indexDb.sqlite.prepare("UPDATE file_text_jobs SET page_count = 12 WHERE note_id = 'doc'").run()
    addText('doc', '', 1, 'First page about budgets')
    addText('doc', '', 2, 'Second page about hiring')
    const pdf = fakePdf(12)

    await projector().project(extracted('doc'))

    expect(keys()).toEqual([
      'doc/#1',
      'doc/#2',
      'doc/#3',
      'doc/#4',
      'doc/#5',
      'doc/#6',
      'doc/#7',
      'doc/#8'
    ])
    expect(openPdf).toHaveBeenCalledTimes(1)
    expect(pdf.close).toHaveBeenCalledTimes(1)
    expect(embedImage).toHaveBeenNthCalledWith(2, Uint8Array.from([2]), {
      text: 'title: none | text: Second page about hiring <|image|>',
      softTokens: 280
    })
    // A page with no text is embedded as its image alone, still at the page budget.
    expect(embedImage).toHaveBeenNthCalledWith(3, Uint8Array.from([3]), {
      text: undefined,
      softTokens: 280
    })
  })

  it('drops page vectors that a shorter PDF no longer has', async () => {
    addNote('doc', 'scan.pdf', 'pdf')
    addFile('scan.pdf')
    addJob('doc', '', '5:1')
    indexDb.sqlite.prepare("UPDATE file_text_jobs SET page_count = 3 WHERE note_id = 'doc'").run()
    fakePdf(3)
    await projector().project(extracted('doc'))
    expect(keys()).toEqual(['doc/#1', 'doc/#2', 'doc/#3'])

    addJob('doc', '', '9:2')
    indexDb.sqlite.prepare("UPDATE file_text_jobs SET page_count = 1 WHERE note_id = 'doc'").run()
    fakePdf(1)
    await projector().project(extracted('doc'))

    expect(keys()).toEqual(['doc/#1'])
  })

  it('re-embeds when the text read from an image changes', async () => {
    addNote('img', 'shot.png', 'image')
    addFile('shot.png')
    addJob('img', '', '5:1')
    addText('img', '', 1, 'first reading of the text')
    await projector().project(extracted('img'))
    embedImage.mockClear()

    indexDb.sqlite.prepare("UPDATE extracted_text SET text = 'a longer second reading of it'").run()
    await projector().project(extracted('img'))

    expect(embedImage).toHaveBeenCalledTimes(1)
  })
})
