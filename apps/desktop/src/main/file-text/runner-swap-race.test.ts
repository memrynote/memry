import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { IndexDb } from '../database/types'
import { getExtractedText, getFileTextJob } from '../database/queries/extracted-text'
import { FileTextRunner } from './runner'

// The seam: the runner resolves an attachment twice (compare, then extract).
// Right after the second vault check resolves the file, it is swapped for a
// link to a file outside the vault, before it is read.
const race = vi.hoisted(() => ({ target: '', seen: 0, swap: (): void => {} }))

function swapOnSecondCheck(probe: unknown): void {
  if (race.target === '' || probe !== race.target) return
  race.seen += 1
  if (race.seen < 2) return
  race.target = ''
  race.swap()
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    swapOnSecondCheck(probe)
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = (probe: string): string => {
    const real = actual.realpathSync.native(probe)
    swapOnSecondCheck(probe)
    return real
  }
  const realpathSync = Object.assign((probe: string) => actual.realpathSync(probe), { native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

const isWindows = process.platform === 'win32'
const EMBED = '<!-- file:{"url":"../attachments/md-1/chart.html","mimeType":"text/html"} -->\n'
const IMAGE_EMBED = '![](../attachments/md-1/shot.png)\n'

describe('the file text runner against files swapped for outside links (#3095)', () => {
  let index: TestDatabaseResult
  let db: IndexDb
  let vaultDir: string
  let outside: string
  let runner: FileTextRunner | null
  let changed: string[]

  const addNote = (): void => {
    db.run(sql`
      INSERT INTO note_cache (id, path, title, created_at, modified_at)
      VALUES ('md-1', 'notes/plan.md', 'Plan', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
  }

  const start = (): void => {
    runner = new FileTextRunner({
      vaultPath: vaultDir,
      appVersion: '1.0.0',
      getDb: () => db,
      // Whatever OCR would read: the bytes it was handed, or the file it opens.
      recognize: async (source) =>
        Buffer.from(
          'path' in source ? fs.readFileSync(source.path as string) : source.data
        ).toString('utf8'),
      ocrLanguages: () => ['eng'],
      openPdf: async () => {
        throw new Error('no pdf')
      },
      release: () => undefined,
      textChanged: (noteId) => changed.push(noteId)
    })
    runner.start()
  }

  const anyJob = (): unknown[] => db.all(sql`SELECT * FROM file_text_jobs WHERE note_id = 'md-1'`)

  beforeEach(() => {
    index = createTestIndexDb()
    db = index.db as unknown as IndexDb
    vaultDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-vault-')))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-outside-'))
    runner = null
    changed = []
    fs.mkdirSync(path.join(vaultDir, 'notes'))
    fs.mkdirSync(path.join(vaultDir, 'attachments', 'md-1'), { recursive: true })
  })

  afterEach(async () => {
    race.target = ''
    race.seen = 0
    await runner?.stop()
    index.close()
    fs.rmSync(vaultDir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it.skipIf(isWindows)('never reads a note body linked outside the vault', async () => {
    const secretNote = path.join(outside, 'private.md')
    fs.writeFileSync(secretNote, `outside secret\n${EMBED}`)
    fs.symlinkSync(secretNote, path.join(vaultDir, 'notes', 'plan.md'))
    fs.writeFileSync(path.join(vaultDir, 'attachments', 'md-1', 'chart.html'), '<p>vault html</p>')
    addNote()

    start()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(anyJob()).toEqual([])
    expect(getExtractedText(db, 'md-1')).toBe('')
  })

  it.skipIf(isWindows)(
    'never saves text from an HTML file swapped outside before it is read',
    async () => {
      const file = path.join(vaultDir, 'attachments', 'md-1', 'chart.html')
      const secret = path.join(outside, 'private.html')
      fs.writeFileSync(secret, '<p>outside secret</p>')
      fs.writeFileSync(file, '<p>vault html txt</p>')
      // Same size and mtime, so the signature check between resolve and read passes.
      const mtime = new Date('2026-01-01T00:00:00.000Z')
      fs.utimesSync(file, mtime, mtime)
      fs.utimesSync(secret, mtime, mtime)
      fs.writeFileSync(path.join(vaultDir, 'notes', 'plan.md'), EMBED)
      addNote()
      race.target = file
      race.swap = () => {
        fs.rmSync(file)
        fs.symlinkSync(secret, file)
      }

      start()
      await vi.waitFor(() =>
        expect(getFileTextJob(db, { noteId: 'md-1', source: 'chart.html' })?.status).toMatch(
          /done|failed/
        )
      )

      expect(race.target).toBe('')
      expect(getExtractedText(db, 'md-1')).not.toContain('outside secret')
      expect(JSON.stringify(db.all(sql`SELECT text FROM extracted_text`))).not.toContain(
        'outside secret'
      )
      expect(getFileTextJob(db, { noteId: 'md-1', source: 'chart.html' })?.status).toBe('failed')
    }
  )
  it.skipIf(isWindows)(
    'never reads text from an image swapped outside before it is read',
    async () => {
      const file = path.join(vaultDir, 'attachments', 'md-1', 'shot.png')
      const secret = path.join(outside, 'private.png')
      fs.writeFileSync(secret, 'outside secret')
      fs.writeFileSync(file, 'vault image txt')
      fs.truncateSync(file, 'outside secret'.length)
      const mtime = new Date('2026-01-01T00:00:00.000Z')
      fs.utimesSync(file, mtime, mtime)
      fs.utimesSync(secret, mtime, mtime)
      fs.writeFileSync(path.join(vaultDir, 'notes', 'plan.md'), IMAGE_EMBED)
      addNote()
      race.target = file
      race.swap = () => {
        fs.rmSync(file)
        fs.symlinkSync(secret, file)
      }

      start()
      await vi.waitFor(() =>
        expect(getFileTextJob(db, { noteId: 'md-1', source: 'shot.png' })?.status).toMatch(
          /done|failed/
        )
      )

      expect(race.target).toBe('')
      expect(JSON.stringify(db.all(sql`SELECT text FROM extracted_text`))).not.toContain(
        'outside secret'
      )
      expect(getFileTextJob(db, { noteId: 'md-1', source: 'shot.png' })?.status).toBe('failed')
    }
  )
})
