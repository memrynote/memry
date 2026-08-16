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
