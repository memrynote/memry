import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataDir: '', trackMainError: vi.fn() }))

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

vi.mock('../telemetry/diagnostics', () => ({
  trackMainError: (...args: unknown[]) => mocks.trackMainError(...args)
}))

const storeFile = (): string => path.join(mocks.userDataDir, 'crdt-pending-notes.json')
const corruptFile = (): string => path.join(mocks.userDataDir, 'crdt-pending-notes.corrupt.json')

describe('crdt pending note store', () => {
  beforeEach(() => {
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crdt-pending-'))
    mocks.trackMainError.mockClear()
  })

  afterEach(() => {
    fs.rmSync(mocks.userDataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('records note ids across restarts and unions repeated shutdowns', async () => {
    const { readPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')

    recordPendingCrdtNotes(['note-a', 'note-b'])
    recordPendingCrdtNotes(['note-b', 'note-c'])

    expect(readPendingCrdtNotes()).toEqual(['note-a', 'note-b', 'note-c'])
  })

  it('returns an empty list when nothing was ever recorded', async () => {
    const { readPendingCrdtNotes } = await import('./crdt-pending-notes')

    expect(readPendingCrdtNotes()).toEqual([])
    expect(mocks.trackMainError).not.toHaveBeenCalled()
  })

  it('reads a store written by an older build byte for byte, and writes one it can read back', async () => {
    // Live beta: every install already has a plain crdt-pending-notes.json
    // written by the pre-atomic writer. The format is the contract in both
    // directions — an older build must still be able to read what this one
    // leaves behind after an update is rolled back.
    const { readPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')

    fs.writeFileSync(storeFile(), JSON.stringify(['note-a', 'note-b']), 'utf8')

    expect(readPendingCrdtNotes()).toEqual(['note-a', 'note-b'])
    expect(fs.existsSync(corruptFile())).toBe(false)
    expect(mocks.trackMainError).not.toHaveBeenCalled()

    recordPendingCrdtNotes(['note-c'])
    expect(JSON.parse(fs.readFileSync(storeFile(), 'utf8'))).toEqual(['note-a', 'note-b', 'note-c'])
  })

  it('salvages the ids a torn write left behind instead of reporting nothing pending', async () => {
    // This is what a crash mid-write used to leave: a prefix of the JSON array.
    // Every id before the cut is intact, and this file is the only record that
    // those notes are owed to the server — the edits themselves are safe in the
    // local CRDT store, but nothing else knows they were never pushed.
    //
    // The id the cut landed inside is genuinely gone: `"note-c` is a prefix, and
    // a prefix is not an id. Two of three beats none of three.
    const { readPendingCrdtNotes } = await import('./crdt-pending-notes')

    fs.writeFileSync(storeFile(), '["note-a","note-b","note-c', 'utf8')

    expect(readPendingCrdtNotes()).toEqual(['note-a', 'note-b'])
  })

  it('preserves an unreadable store and reports it, rather than dropping it with a warning', async () => {
    const { readPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')

    fs.writeFileSync(storeFile(), '["note-a","note-b","note-c', 'utf8')
    recordPendingCrdtNotes(['note-d'])

    // The damaged bytes are kept, not clobbered by the next write — the tail the
    // salvage could not use is still there to be read by a human.
    expect(fs.readFileSync(corruptFile(), 'utf8')).toBe('["note-a","note-b","note-c')
    // ...and the salvage is repaired into the live file, so the next reader —
    // clearPendingCrdtNotes at the tail of a drain — does not find it empty.
    expect(readPendingCrdtNotes()).toEqual(['note-a', 'note-b', 'note-d'])
    expect(mocks.trackMainError).toHaveBeenCalledWith(
      'sync',
      'crdt_pending_notes_corrupt',
      expect.anything()
    )
  })

  it('replays a salvaged store and still retains what it could not push', async () => {
    // The drain reads the store, works, then reads it AGAIN through
    // clearPendingCrdtNotes to remove only what reached the server. A salvage
    // that lived in memory would be gone by that second read — the file has been
    // moved aside — and the note that failed to push would be dropped, which is
    // the same silent loss with an extra step. The salvage is repaired to disk.
    const { drainPendingCrdtNotes, readPendingCrdtNotes } = await import('./crdt-pending-notes')

    fs.writeFileSync(storeFile(), '["note-ok","note-offline","note-t', 'utf8')

    const result = await drainPendingCrdtNotes({
      isSyncable: () => true,
      mergeRemote: async () => true,
      pushSnapshot: async (noteId) => noteId === 'note-ok'
    })

    expect(result).toEqual({ cleared: 1, retained: 1 })
    expect(readPendingCrdtNotes()).toEqual(['note-offline'])
  })

  it('keeps at most one preserved copy no matter how often the store is damaged', async () => {
    // The recovery path must not become its own leak: this file is written on
    // the edit path, so a timestamped copy per corruption would accumulate in
    // userData forever on a device with a failing disk.
    const { readPendingCrdtNotes } = await import('./crdt-pending-notes')

    fs.writeFileSync(storeFile(), '["note-a', 'utf8')
    readPendingCrdtNotes()
    fs.writeFileSync(storeFile(), '["note-a","note-b', 'utf8')
    readPendingCrdtNotes()

    expect(fs.readdirSync(mocks.userDataDir).filter((name) => name.includes('corrupt'))).toEqual([
      'crdt-pending-notes.corrupt.json'
    ])
    // The surviving copy is the newest, which is also the one that subsumes the
    // earlier one: the read that moved that copy aside salvaged its ids forward.
    expect(fs.readFileSync(corruptFile(), 'utf8')).toBe('["note-a","note-b')
  })

  it('leaves the previous list intact when a write is cut short', async () => {
    // A full disk or a power cut mid-write. The live path must never hold a
    // half-written list: the old bytes stand until a complete replacement is
    // staged and renamed over them, so there is no window in which the store
    // parses as "nothing pending".
    const { readPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-a', 'note-b'])

    const realWriteFileSync = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(((
      target: fs.PathOrFileDescriptor,
      data: string
    ) => {
      // Half the bytes land, then the write dies — wherever it was aimed.
      const half = data.slice(0, Math.floor(data.length / 2))
      if (typeof target === 'number') fs.writeSync(target, half)
      else realWriteFileSync(target, half, 'utf8')
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
      err.code = 'ENOSPC'
      throw err
    }) as unknown as typeof fs.writeFileSync)

    recordPendingCrdtNotes(['note-c'])
    spy.mockRestore()

    expect(readPendingCrdtNotes()).toEqual(['note-a', 'note-b'])
    // Nothing was corrupt, so nothing was moved aside, and the failed attempt
    // left no temp file behind.
    expect(fs.existsSync(corruptFile())).toBe(false)
    expect(fs.readdirSync(mocks.userDataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('clears only the notes whose state actually reached the server', async () => {
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')

    recordPendingCrdtNotes(['note-ok', 'note-offline', 'note-throws'])

    const result = await drainPendingCrdtNotes({
      isSyncable: () => true,
      mergeRemote: async () => true,
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
    const deps = { isSyncable: () => true, mergeRemote: async () => true, pushSnapshot }
    await drainPendingCrdtNotes(deps)
    expect(pushSnapshot.mock.calls).toHaveLength(2)

    await drainPendingCrdtNotes(deps)
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

    const deps = { isSyncable: () => true, mergeRemote: async () => true, pushSnapshot }
    const startup = drainPendingCrdtNotes(deps)
    const onReconnect = drainPendingCrdtNotes(deps)
    release!()
    await Promise.all([startup, onReconnect])

    expect(pushSnapshot.mock.calls.map((call) => call[0])).toEqual(['note-a', 'note-b'])
  })

  it('defers a trigger that arrives mid-drain instead of dropping it', async () => {
    // The startup replay can still be pulling note-a when the network monitor
    // reports online, and an edit made in between is recorded after the running
    // drain already read the store. Dropping that trigger left the new id
    // waiting for some later event; deferring replays it as soon as the running
    // drain is done.
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-a'])

    let release: (() => void) | undefined
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const pushed: string[] = []
    let concurrent = 0
    let maxConcurrent = 0
    const deps = {
      isSyncable: () => true,
      mergeRemote: async (_noteId: string) => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await Promise.resolve()
        concurrent--
        return true
      },
      pushSnapshot: async (noteId: string) => {
        if (noteId === 'note-a') await inFlight
        pushed.push(noteId)
        return true
      }
    }

    const startup = drainPendingCrdtNotes(deps)
    recordPendingCrdtNotes(['note-b'])
    const onReconnect = drainPendingCrdtNotes(deps)
    release!()
    const [startupResult, deferredResult] = await Promise.all([startup, onReconnect])

    expect(pushed).toEqual(['note-a', 'note-b'])
    expect(readPendingCrdtNotes()).toEqual([])
    // The deferred caller gets the numbers for the run it actually caused, not
    // the "nothing to do" a dropped trigger used to be told.
    expect(startupResult).toEqual({ cleared: 1, retained: 0 })
    expect(deferredResult).toEqual({ cleared: 1, retained: 0 })
    // Deferred, not parallel: two runs must never share the durable store.
    expect(maxConcurrent).toBe(1)
  })

  it('coalesces three overlapping triggers into one deferred run', async () => {
    // A third trigger asks for nothing the second has not already asked for, so
    // it joins that run. note-b stays unpushed here precisely so an extra pass
    // would be visible as a second attempt at it.
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-a'])

    let release: (() => void) | undefined
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const pushed: string[] = []
    const deps = {
      isSyncable: () => true,
      mergeRemote: async () => true,
      pushSnapshot: async (noteId: string) => {
        if (noteId === 'note-a') await inFlight
        pushed.push(noteId)
        return noteId === 'note-a'
      }
    }

    const startup = drainPendingCrdtNotes(deps)
    recordPendingCrdtNotes(['note-b'])
    const second = drainPendingCrdtNotes(deps)
    const third = drainPendingCrdtNotes(deps)
    release!()
    const [, secondResult, thirdResult] = await Promise.all([startup, second, third])

    expect(pushed).toEqual(['note-a', 'note-b'])
    expect(secondResult).toEqual({ cleared: 0, retained: 1 })
    expect(thirdResult).toEqual(secondResult)
    expect(readPendingCrdtNotes()).toEqual(['note-b'])
  })

  it('hands the deferred run the newest deps, not a torn-down session', async () => {
    // `deps` closes over one runtime's engine and crdtProvider, and neither
    // survives stopSyncRuntime. If a session is torn down and a new one starts
    // while a drain is still running, the deferred run must belong to the live
    // session — replaying the dead one's closure would pull and merge against a
    // destroyed provider.
    const { drainPendingCrdtNotes, recordPendingCrdtNotes } = await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-a'])

    let release: (() => void) | undefined
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = {
      isSyncable: () => true,
      mergeRemote: async () => true,
      pushSnapshot: async (noteId: string) => {
        if (noteId === 'note-a') await inFlight
        return true
      }
    }
    const tornDown = {
      isSyncable: () => true,
      mergeRemote: vi.fn(async (_noteId: string) => true),
      pushSnapshot: vi.fn(async (_noteId: string) => true)
    }
    const live = {
      isSyncable: () => true,
      mergeRemote: vi.fn(async (_noteId: string) => true),
      pushSnapshot: vi.fn(async (_noteId: string) => true)
    }

    const startup = drainPendingCrdtNotes(running)
    recordPendingCrdtNotes(['note-b'])
    const fromDeadSession = drainPendingCrdtNotes(tornDown)
    const fromNewSession = drainPendingCrdtNotes(live)
    release!()
    await Promise.all([startup, fromDeadSession, fromNewSession])

    expect(tornDown.mergeRemote).not.toHaveBeenCalled()
    expect(tornDown.pushSnapshot).not.toHaveBeenCalled()
    expect(live.pushSnapshot.mock.calls.map((call) => call[0])).toEqual(['note-b'])
  })

  it('leaves a note pending and unpushed when its pre-push pull fails', async () => {
    // Pushing a snapshot makes the server prune every crdt_updates row at or
    // below it. A device that could not pull first does not know what those
    // rows contain, so pushing would delete a peer's edits and ship a snapshot
    // that does not contain them. Being late is recoverable; that is not.
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-unmerged', 'note-merged'])

    const pushSnapshot = vi.fn(async (_noteId: string) => true)
    const result = await drainPendingCrdtNotes({
      isSyncable: () => true,
      mergeRemote: async (noteId) => noteId !== 'note-unmerged',
      pushSnapshot
    })

    expect(pushSnapshot.mock.calls.map((call) => call[0])).toEqual(['note-merged'])
    expect(result).toEqual({ cleared: 1, retained: 1 })
    expect(readPendingCrdtNotes()).toEqual(['note-unmerged'])
  })

  it('does not push when the pre-push pull throws', async () => {
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-a'])

    const pushSnapshot = vi.fn(async (_noteId: string) => true)
    await drainPendingCrdtNotes({
      isSyncable: () => true,
      mergeRemote: async () => {
        throw new Error('offline')
      },
      pushSnapshot
    })

    expect(pushSnapshot).not.toHaveBeenCalled()
    expect(readPendingCrdtNotes()).toEqual(['note-a'])
  })

  it('drops notes that no longer exist instead of retrying them forever', async () => {
    const { drainPendingCrdtNotes, readPendingCrdtNotes, recordPendingCrdtNotes } =
      await import('./crdt-pending-notes')
    recordPendingCrdtNotes(['note-deleted'])

    const pushSnapshot = vi.fn(async () => true)
    await drainPendingCrdtNotes({
      isSyncable: () => false,
      mergeRemote: async () => true,
      pushSnapshot
    })

    expect(pushSnapshot).not.toHaveBeenCalled()
    expect(readPendingCrdtNotes()).toEqual([])
    expect(fs.existsSync(storeFile())).toBe(false)
  })
})
