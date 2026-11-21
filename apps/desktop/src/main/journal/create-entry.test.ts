import { describe, it, expect, vi, beforeEach } from 'vitest'

const { broadcast, enqueueCreate, initCrdt, syncCache, flush, disk } = vi.hoisted(() => ({
  disk: { previousFile: null as string | null, baseline: undefined as string | undefined },
  broadcast: vi.fn(),
  enqueueCreate: vi.fn(),
  initCrdt: vi.fn().mockResolvedValue(undefined),
  syncCache: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: broadcast }))
vi.mock('../database', () => ({ getIndexDatabase: () => ({}), getDatabase: () => ({}) }))
vi.mock('../vault/journal', () => ({
  writeJournalEntryWithContent: vi.fn(async (date: string, content: string, tags?: string[]) => ({
    entry: {
      id: `journal-${date}`,
      date,
      content,
      wordCount: 1,
      characterCount: content.length,
      tags: tags ?? [],
      createdAt: '2026-08-12T00:00:00.000Z',
      modifiedAt: '2026-08-12T00:00:00.000Z'
    },
    fileContent: content,
    frontmatter: { date },
    previousFile: disk.previousFile
  })),
  getJournalRelativePath: (date: string) => `journal/${date}.md`
}))
vi.mock('../vault/journal-cache-sync', () => ({ syncJournalCache: syncCache }))
vi.mock('../projections', () => ({ flushProjectionEvents: flush }))
vi.mock('./runtime-effects', () => ({
  enqueueJournalCreate: enqueueCreate,
  initializeJournalCrdt: initCrdt
}))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: () => (disk.baseline ? { contentHash: disk.baseline } : undefined),
  updateNoteCache: vi.fn()
}))
vi.mock('@memry/domain-notes', () => ({ getCanonicalJournalByDate: () => undefined }))
// create-entry.ts imports both of these from './store'.
vi.mock('./store', () => ({
  getJournalEntryByDate: () => undefined,
  getNoteCacheByPath: () => undefined
}))

import { generateJournalId } from '@memry/contracts/journal-api'
import { createJournalEntry, resolveJournalEntryId } from './create-entry'
import { generateContentHash } from '../vault/frontmatter'

const DATE = '2026-08-12'

describe('resolveJournalEntryId', () => {
  it('falls back to the deterministic id when nothing is cached', () => {
    expect(resolveJournalEntryId(DATE)).toBe(generateJournalId(DATE))
  })
})

describe('createJournalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disk.previousFile = null
    disk.baseline = undefined
  })

  // A create can land on a day file that already exists (an ipc create over
  // it, a NotePlan import, a journal-day merge). Its new body is not in the
  // doc, so the baseline stays and the next write-back feeds the file first.
  it('keeps the baseline when it writes a new body over an existing day file', async () => {
    disk.previousFile = 'old body'
    disk.baseline = generateContentHash('old body')

    await createJournalEntry({ date: DATE, content: 'hello' })

    expect(syncCache).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contentHash: generateContentHash('old body') }),
      expect.anything()
    )
  })

  it('records the written bytes for a new day file', async () => {
    await createJournalEntry({ date: DATE, content: 'hello' })

    expect(syncCache).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contentHash: generateContentHash('hello') }),
      expect.anything()
    )
  })

  it('writes the entry and runs the full create pipeline', async () => {
    const entry = await createJournalEntry({ date: DATE, content: 'hello' })
    const id = generateJournalId(DATE)

    expect(entry.date).toBe(DATE)
    expect(entry.content).toBe('hello')
    // The entry carries the resolved id, not whatever the file write returned.
    expect(entry.id).toBe(id)
    expect(syncCache).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(enqueueCreate).toHaveBeenCalledWith(id, DATE)
    expect(initCrdt).toHaveBeenCalledWith(id, DATE, [])
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('marks the cache write as new when no cache row exists', async () => {
    await createJournalEntry({ date: DATE, content: 'hello' })
    expect(syncCache).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: `journal/${DATE}.md`, title: DATE }),
      { isNew: true }
    )
  })

  it('uses the same id createJournalEntry will settle on', async () => {
    const predicted = resolveJournalEntryId(DATE)
    const entry = await createJournalEntry({ date: DATE, content: 'hello' })
    expect(entry.id).toBe(predicted)
  })
})
