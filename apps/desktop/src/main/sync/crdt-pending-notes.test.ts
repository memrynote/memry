import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

const storeFile = (): string => path.join(mocks.userDataDir, 'crdt-pending-notes.json')

describe('crdt pending note store', () => {
  beforeEach(() => {
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crdt-pending-'))
  })

  afterEach(() => {
    fs.rmSync(mocks.userDataDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('records note ids across restarts and unions repeated shutdowns', async () => {
    const { readPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')

    recordPendingCrdtNotes(['note-a', 'note-b'])
    recordPendingCrdtNotes(['note-b', 'note-c'])

    expect(readPendingCrdtNotes()).toEqual(['note-a', 'note-b', 'note-c'])
  })

  it('returns an empty list when nothing was ever recorded or the file is corrupt', async () => {
    const { readPendingCrdtNotes } = await import('./crdt-pending-notes')

    expect(readPendingCrdtNotes()).toEqual([])

    fs.writeFileSync(storeFile(), '{ not json', 'utf8')
    expect(readPendingCrdtNotes()).toEqual([])
  })

  it('clears only the notes whose state actually reached the server', async () => {
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')

    recordPendingCrdtNotes(['note-ok', 'note-offline', 'note-throws'])

    const result = await drainPendingCrdtNotes({
      isSyncable: () => true,
      pushSnapshot: async (noteId) => {
        if (noteId === 'note-throws') throw new Error('offline')
        return noteId === 'note-ok'
      }
    })

    expect(result).toEqual({ cleared: 1, retained: 2 })
    expect(readPendingCrdtNotes()).toEqual(['note-offline', 'note-throws'])
  })

  it('drops notes that no longer exist instead of retrying them forever', async () => {
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-deleted'])

    const pushSnapshot = vi.fn(async () => true)
    await drainPendingCrdtNotes({ isSyncable: () => false, pushSnapshot })

    expect(pushSnapshot).not.toHaveBeenCalled()
    expect(readPendingCrdtNotes()).toEqual([])
    expect(fs.existsSync(storeFile())).toBe(false)
  })
})
