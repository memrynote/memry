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

  it('does not push a note again on the next replay', async () => {
    // A snapshot push is a full note body plus an R2 write. The startup replay
    // and the network-transition replay both run drainPendingCrdtNotes against
    // the same store, so an entry that already reached the server must not be
    // paid for twice.
    const { drainPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-a', 'note-b'])

    const pushSnapshot = vi.fn(async (_noteId: string) => true)
    await drainPendingCrdtNotes({ isSyncable: () => true, pushSnapshot })
    expect(pushSnapshot.mock.calls).toHaveLength(2)

    await drainPendingCrdtNotes({ isSyncable: () => true, pushSnapshot })
    expect(pushSnapshot.mock.calls).toHaveLength(2)
  })

  it('does not double-push when the startup replay and a network transition overlap', async () => {
    // startSyncRuntime fires one replay at the end of startup; the network
    // monitor fires another the moment it reports online. Coming back from
    // offline does both within the same second.
    const { drainPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-a', 'note-b'])

    let release: (() => void) | undefined
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const pushSnapshot = vi.fn(async (_noteId: string) => {
      await inFlight
      return true
    })

    const startup = drainPendingCrdtNotes({ isSyncable: () => true, pushSnapshot })
    const onReconnect = drainPendingCrdtNotes({ isSyncable: () => true, pushSnapshot })
    release!()
    await Promise.all([startup, onReconnect])

    expect(pushSnapshot.mock.calls.map((call) => call[0])).toEqual(['note-a', 'note-b'])
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
