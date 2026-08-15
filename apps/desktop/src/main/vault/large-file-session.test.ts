import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LineIndex } from './large-file-index'

const mocks = vi.hoisted(() => ({
  vaultDir: '',
  cache: null as { id: string; path: string } | null,
  broadcast: vi.fn(),
  /** Resolves the in-flight index build, so progress can be driven by hand. */
  buildLineIndex: vi.fn(),
  /** Stands in for the search worker, so a search can be driven by hand. */
  runFileSearch: vi.fn()
}))

vi.mock('../database', () => ({
  getIndexDatabase: () => ({}) as never,
  getDatabase: () => ({}) as never
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) =>
    mocks.cache && mocks.cache.id === id ? mocks.cache : undefined
}))

vi.mock('./notes-io', () => ({
  toAbsolutePath: (relativePath: string) => join(mocks.vaultDir, relativePath),
  getVaultRoot: () => mocks.vaultDir
}))

vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => mocks.broadcast(channel, payload)
}))

vi.mock('./large-file-index-bridge', () => ({
  buildLineIndex: (...args: unknown[]) => mocks.buildLineIndex(...args)
}))

vi.mock('./large-file-search-bridge', () => ({
  runFileSearch: (...args: unknown[]) => mocks.runFileSearch(...args)
}))

import {
  openLargeFileSession,
  readLargeFileLines,
  searchLargeFileSession,
  closeLargeFileSession,
  closeAllLargeFileSessions,
  VIEWER_MAX_BYTES,
  MAX_OPEN_SESSIONS
} from './large-file-session'
import { NotesChannels } from '@memry/contracts/notes-api'

/** Whatever the real scan would have produced for `text`, computed inline. */
function indexFor(text: string): LineIndex {
  const bytes = Buffer.from(text, 'utf8')
  const checkpoints: number[] = [0]
  let newlines = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue
    newlines += 1
    checkpoints.push(i + 1)
  }
  const lineCount =
    bytes.length === 0 ? 0 : bytes[bytes.length - 1] === 0x0a ? newlines : newlines + 1
  return {
    checkpoints: Float64Array.from(checkpoints.slice(0, lineCount)),
    stride: 1,
    lineCount,
    fileBytes: bytes.length
  }
}

async function writeVaultFile(name: string, contents: string | Buffer): Promise<void> {
  await writeFile(join(mocks.vaultDir, name), contents)
  mocks.cache = { id: 'note-1', path: name }
}

/** The search-progress payloads broadcast so far. */
function searchEvents(): Array<Record<string, unknown>> {
  return mocks.broadcast.mock.calls
    .filter(([channel]) => channel === NotesChannels.events.LARGE_FILE_SEARCH_PROGRESS)
    .map(([, payload]) => payload as Record<string, unknown>)
}

/** The index-progress payloads broadcast so far. */
function indexEvents(): Array<Record<string, unknown>> {
  return mocks.broadcast.mock.calls
    .filter(([channel]) => channel === NotesChannels.events.LARGE_FILE_INDEX)
    .map(([, payload]) => payload as Record<string, unknown>)
}

/** Opens `body` as a vault file and returns the id of its ready session. */
async function openReadySession(body: string): Promise<string> {
  await writeVaultFile('log.md', body)
  mocks.buildLineIndex.mockResolvedValue(indexFor(body))
  const opened = await openLargeFileSession('note-1')
  const sessionId = opened.status === 'indexing' ? opened.sessionId : ''
  await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))
  return sessionId
}

/**
 * A search run the test controls: `pending` never finishes by itself, so only
 * `cancel` can settle it — which is what a superseded query does.
 */
function fakeSearch(
  found: { hits: Array<{ line: number; ordinal: number }>; total: number; limited: boolean },
  options: { pending?: boolean } = {}
): { result: Promise<unknown>; cancel: ReturnType<typeof vi.fn> } {
  let settle: ((value: unknown) => void) | null = null
  const result = options.pending
    ? new Promise<unknown>((resolve) => {
        settle = resolve
      })
    : Promise.resolve({ ...found, cancelled: false, bytesSearched: 0 })
  const cancel = vi.fn(() => {
    settle?.({ hits: [], total: 0, limited: false, cancelled: true, bytesSearched: 0 })
  })
  return { result, cancel }
}

describe('large-file session', () => {
  beforeEach(async () => {
    mocks.vaultDir = await mkdtemp(join(tmpdir(), 'memry-large-file-session-'))
    mocks.cache = null
    mocks.broadcast.mockClear()
    // Default: the scan completes immediately with a real index for the file.
    mocks.buildLineIndex.mockReset()
    mocks.runFileSearch.mockReset()
  })

  afterEach(async () => {
    await closeAllLargeFileSessions()
    await rm(mocks.vaultDir, { recursive: true, force: true })
  })

  it('refuses a file past the viewer ceiling and says how far past it is', async () => {
    // #given a file claiming to be over the ceiling. It is sparse, so the test
    // asserts the real ceiling against a real `stat` without writing 2 GB.
    const body = Buffer.alloc(0)
    await writeVaultFile('huge.md', body)
    const { truncate } = await import('fs/promises')
    await truncate(join(mocks.vaultDir, 'huge.md'), VIEWER_MAX_BYTES + 1)

    // #when
    const result = await openLargeFileSession('note-1')

    // #then — the row was clickable and the click has to explain itself, not
    // report a bare failure. The ceiling travels with the answer so the
    // renderer never restates a number the main process owns.
    expect(result).toEqual({
      status: 'too-large',
      fileBytes: VIEWER_MAX_BYTES + 1,
      maxBytes: VIEWER_MAX_BYTES
    })
    // nothing was read, and no scan was started for a file that cannot open
    expect(mocks.buildLineIndex).not.toHaveBeenCalled()
  })

  it('opens a file exactly at the ceiling', async () => {
    // #given the boundary itself, which must be inclusive
    await writeVaultFile('edge.md', '')
    const { truncate } = await import('fs/promises')
    await truncate(join(mocks.vaultDir, 'edge.md'), VIEWER_MAX_BYTES)
    mocks.buildLineIndex.mockResolvedValue(indexFor(''))

    // #when
    const result = await openLargeFileSession('note-1')

    // #then
    expect(result.status).toBe('indexing')
  })

  it('reports a missing file rather than throwing at the renderer', async () => {
    // #given a cache row whose file is gone
    mocks.cache = { id: 'note-1', path: 'ghost.md' }

    // #when
    const result = await openLargeFileSession('note-1')

    // #then
    expect(result).toEqual({ status: 'missing' })
  })

  it('streams scan progress to the renderer and ends with the line count', async () => {
    // #given a scan the test can advance step by step
    const body = 'alpha\nbeta\ngamma\n'
    await writeVaultFile('log.md', body)
    let emit: ((bytesScanned: number) => void) | null = null
    mocks.buildLineIndex.mockImplementation(
      (_path: string, _bytes: number, _read: unknown, onProgress: (n: number) => void) => {
        emit = onProgress
        return new Promise<LineIndex>((resolve) => {
          queueMicrotask(() => {
            onProgress(8)
            resolve(indexFor(body))
          })
        })
      }
    )

    // #when
    const opened = await openLargeFileSession('note-1')
    await vi.waitFor(() => expect(indexEvents().some((e) => e.status === 'ready')).toBe(true))

    // #then — the wait is visible while it happens...
    expect(opened.status).toBe('indexing')
    expect(emit).not.toBeNull()
    const scanning = indexEvents().filter((e) => e.status === 'scanning')
    expect(scanning).toContainEqual(
      expect.objectContaining({ bytesScanned: 8, fileBytes: body.length })
    )
    // ...and ends by naming the size of the thing the viewer now has to render
    expect(indexEvents().at(-1)).toEqual(expect.objectContaining({ status: 'ready', lineCount: 3 }))
  })

  it('serves line windows once the scan is done', async () => {
    // #given
    const body = Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n') + '\n'
    await writeVaultFile('log.md', body)
    mocks.buildLineIndex.mockResolvedValue(indexFor(body))

    // #when
    const opened = await openLargeFileSession('note-1')
    expect(opened.status).toBe('indexing')
    const sessionId = opened.status === 'indexing' ? opened.sessionId : ''
    await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))
    const page = await readLargeFileLines({ sessionId, startLine: 397, count: 5 })

    // #then — the window comes back and stops at the end of the file
    expect(page?.lines).toEqual(['row 397', 'row 398', 'row 399'])
    expect(page?.startLine).toBe(397)
    expect(page?.lineCount).toBe(400)
  })

  it('answers a read for an unknown session with null instead of throwing', async () => {
    // #given no session at all — what the renderer sees after a main restart

    // #when
    const page = await readLargeFileLines({ sessionId: 'gone', startLine: 0, count: 10 })

    // #then
    expect(page).toBeNull()
  })

  it('never reads the whole file, even when whole-file reads are impossible', async () => {
    // #given a vault where `readFile` cannot work at all — the standing
    // condition above 512 MB, where V8 refuses the string outright
    const body = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n') + '\n'
    await writeVaultFile('log.md', body)
    mocks.buildLineIndex.mockResolvedValue(indexFor(body))
    const fsp = await import('fs/promises')
    const originalReadFile = fsp.default.readFile
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fsp.default as any).readFile = () => {
      throw new Error('ERR_STRING_TOO_LONG')
    }

    try {
      // #when
      const opened = await openLargeFileSession('note-1')
      const sessionId = opened.status === 'indexing' ? opened.sessionId : ''
      await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))
      const page = await readLargeFileLines({ sessionId, startLine: 10, count: 2 })

      // #then — opening and reading both still work, because neither path ever
      // asks for the file as one string
      expect(page?.lines).toEqual(['row 10', 'row 11'])
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(fsp.default as any).readFile = originalReadFile
    }
  })

  it('reuses a ready session for the same file instead of rescanning', async () => {
    // #given a file already scanned once
    const body = 'one\ntwo\n'
    await writeVaultFile('log.md', body)
    mocks.buildLineIndex.mockResolvedValue(indexFor(body))
    const first = await openLargeFileSession('note-1')
    await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))

    // #when the same note is opened again, as a tab switch does
    const second = await openLargeFileSession('note-1')

    // #then — no second scan; a 2 GB rescan on every tab switch is the whole
    // cost this feature exists to avoid
    expect(second).toEqual({
      status: 'ready',
      sessionId: first.status === 'indexing' ? first.sessionId : '',
      fileBytes: body.length,
      lineCount: 2
    })
    expect(mocks.buildLineIndex).toHaveBeenCalledTimes(1)
  })

  it('still reports ready when the consumer that started the scan lets go', async () => {
    // #given a scan the test settles by hand, so the close can be placed
    // between the second open and the scan finishing
    const body = 'one\ntwo\nthree\n'
    await writeVaultFile('log.md', body)
    let finishScan: ((index: LineIndex) => void) | null = null
    mocks.buildLineIndex.mockImplementation(
      () =>
        new Promise<LineIndex>((resolve) => {
          finishScan = resolve
        })
    )

    // #when the note is opened twice and the first opener then closes. React
    // StrictMode does exactly this on every mount in dev, and so does a tab
    // switch away and straight back, or a second window on the same note.
    const first = await openLargeFileSession('note-1')
    const second = await openLargeFileSession('note-1')
    const sessionId = second.status === 'indexing' ? second.sessionId : ''
    await closeLargeFileSession(first.status === 'indexing' ? first.sessionId : '')
    finishScan!(indexFor(body))
    await new Promise((resolve) => setImmediate(resolve))

    // #then the consumer still holding the session gets its answer. Without
    // this it waits on "Preparing… " forever: the scan finished into a session
    // the other consumer's close had already removed.
    expect(indexEvents().at(-1)).toMatchObject({ sessionId, status: 'ready', lineCount: 3 })
    expect((await readLargeFileLines({ sessionId, startLine: 0, count: 1 }))?.lines).toEqual([
      'one'
    ])
  })

  it('keeps a ready session open for the window that is still on it', async () => {
    // #given two consumers on the same note — two windows, or a remount
    const sessionId = await openReadySession('one\ntwo\n')
    await openLargeFileSession('note-1')

    // #when the first one closes
    await closeLargeFileSession(sessionId)

    // #then the other can still read through it
    expect((await readLargeFileLines({ sessionId, startLine: 0, count: 1 }))?.lines).toEqual([
      'one'
    ])
  })

  it('lets the file handle go once the last consumer closes', async () => {
    // #given two consumers on the same session
    const sessionId = await openReadySession('one\ntwo\n')
    await openLargeFileSession('note-1')

    // #when both close
    await closeLargeFileSession(sessionId)
    await closeLargeFileSession(sessionId)

    // #then the session is gone — a count that never reaches zero pins an OS
    // file handle for as long as the app runs
    expect(await readLargeFileLines({ sessionId, startLine: 0, count: 1 })).toBeNull()
  })

  it('rescans when the file changed underneath a ready session', async () => {
    // #given a scanned file that then grows on disk
    await writeVaultFile('log.md', 'one\ntwo\n')
    mocks.buildLineIndex.mockResolvedValue(indexFor('one\ntwo\n'))
    await openLargeFileSession('note-1')
    await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))

    await writeVaultFile('log.md', 'one\ntwo\nthree\nfour\n')
    mocks.buildLineIndex.mockResolvedValue(indexFor('one\ntwo\nthree\nfour\n'))

    // #when
    const reopened = await openLargeFileSession('note-1')

    // #then — a stale line index would seek to offsets that no longer exist
    expect(reopened.status).toBe('indexing')
    expect(mocks.buildLineIndex).toHaveBeenCalledTimes(2)
  })

  it('closes the oldest session rather than leaking file handles', async () => {
    // #given more open files than the cap allows
    mocks.buildLineIndex.mockResolvedValue(indexFor('x\n'))
    const ids: string[] = []
    for (let i = 0; i <= MAX_OPEN_SESSIONS; i++) {
      await writeFile(join(mocks.vaultDir, `f${i}.md`), 'x\n')
      mocks.cache = { id: `note-${i}`, path: `f${i}.md` }
      const opened = await openLargeFileSession(`note-${i}`)
      if (opened.status === 'indexing') ids.push(opened.sessionId)
    }
    await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))

    // #when the first session is read from
    const evicted = await readLargeFileLines({ sessionId: ids[0], startLine: 0, count: 1 })
    const newest = await readLargeFileLines({ sessionId: ids.at(-1)!, startLine: 0, count: 1 })

    // #then — the oldest was let go, the newest is still live. A viewer that
    // never evicts holds one OS file handle per file the user ever opened.
    expect(evicted).toBeNull()
    expect(newest?.lines).toEqual(['x'])
  })

  it('reports a failed scan instead of leaving the viewer waiting forever', async () => {
    // #given a scan that cannot finish
    await writeVaultFile('log.md', 'one\n')
    mocks.buildLineIndex.mockRejectedValue(new Error('worker gone'))

    // #when
    await openLargeFileSession('note-1')

    // #then
    await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('error'))
  })

  it('refuses a cache path that resolves outside the vault', async () => {
    // #given a note row whose path climbs out of the vault. The renderer only
    // ever names a note id, so this is the index DB being wrong or tampered
    // with — but `path.join` resolves `../` without complaint.
    const outside = join(mocks.vaultDir, '..', 'escaped.md')
    await writeFile(outside, 'secrets\n')
    mocks.cache = { id: 'note-1', path: '../escaped.md' }

    try {
      // #when
      const result = await openLargeFileSession('note-1')

      // #then — no handle, no session, nothing read
      expect(result).toEqual({ status: 'missing' })
      expect(mocks.buildLineIndex).not.toHaveBeenCalled()
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('clamps a line window past the end of the file', async () => {
    // #given a small file and a renderer asking well past it
    const body = 'one\ntwo\n'
    await writeVaultFile('log.md', body)
    mocks.buildLineIndex.mockResolvedValue(indexFor(body))
    const opened = await openLargeFileSession('note-1')
    const sessionId = opened.status === 'indexing' ? opened.sessionId : ''
    await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))

    // #when
    const page = await readLargeFileLines({
      sessionId,
      startLine: Number.MAX_SAFE_INTEGER,
      count: 2000
    })

    // #then — an empty window, not a read past the end and not a throw. The
    // line number is the only thing the renderer controls here; byte offsets
    // come from the index, never from the message.
    expect(page).toEqual({
      startLine: Number.MAX_SAFE_INTEGER,
      lines: [],
      truncated: [],
      lineCount: 2
    })
  })

  it('stops serving a session once it is closed', async () => {
    // #given a ready session
    await writeVaultFile('log.md', 'one\ntwo\n')
    mocks.buildLineIndex.mockResolvedValue(indexFor('one\ntwo\n'))
    const opened = await openLargeFileSession('note-1')
    const sessionId = opened.status === 'indexing' ? opened.sessionId : ''
    await vi.waitFor(() => expect(indexEvents().at(-1)?.status).toBe('ready'))

    // #when
    await closeLargeFileSession(sessionId)

    // #then
    expect(await readLargeFileLines({ sessionId, startLine: 0, count: 1 })).toBeNull()
  })

  it('searches the file the session holds open, not a path the caller named', async () => {
    // #given a ready session and a worker that finds two hits
    const body = 'alpha\nbeta here\ngamma beta\n'
    const sessionId = await openReadySession(body)
    mocks.runFileSearch.mockReturnValue(
      fakeSearch({ hits: [{ line: 1, ordinal: 0 }], total: 1, limited: false })
    )

    // #when
    const found = await searchLargeFileSession({ sessionId, query: 'beta' })

    // #then — the renderer names a session, never a path. The path behind it is
    // the one already open inside the vault.
    expect(mocks.runFileSearch.mock.calls[0][0]).toBe(join(mocks.vaultDir, 'log.md'))
    expect(mocks.runFileSearch.mock.calls[0][1]).toBe('beta')
    expect(found).toEqual({
      status: 'complete',
      query: 'beta',
      hits: [{ line: 1, ordinal: 0 }],
      total: 1,
      limited: false
    })
  })

  it('streams the count while the pass is still crossing the file', async () => {
    // #given a search the test can advance step by step
    const body = 'beta\n'.repeat(20)
    const sessionId = await openReadySession(body)
    // A holder, not a `let`: control-flow analysis would narrow a `let`
    // assigned only inside the callback back to `null` at the call below.
    const search: { emit?: (bytesSearched: number, total: number) => void } = {}
    mocks.runFileSearch.mockImplementation(
      (
        _path: string,
        _query: string,
        _read: unknown,
        onProgress: (bytesSearched: number, total: number) => void
      ) => {
        search.emit = onProgress
        return fakeSearch({ hits: [], total: 20, limited: false })
      }
    )

    // #when
    const pending = searchLargeFileSession({ sessionId, query: 'beta' })
    search.emit?.(40, 8)
    await pending

    // #then — a 2 GB pass takes seconds, so the count arrives as it grows and
    // is marked as growing. Waiting in silence would read as "no matches".
    expect(searchEvents()).toContainEqual(
      expect.objectContaining({
        sessionId,
        query: 'beta',
        bytesSearched: 40,
        total: 8,
        fileBytes: body.length
      })
    )
  })

  it('answers a search for an unknown session with null instead of throwing', async () => {
    // #given no session at all — what the renderer sees after a main restart

    // #when
    const found = await searchLargeFileSession({ sessionId: 'gone', query: 'beta' })

    // #then
    expect(found).toBeNull()
    expect(mocks.runFileSearch).not.toHaveBeenCalled()
  })

  it('cancels the query the user has already typed past', async () => {
    // #given a search that never finishes on its own
    const sessionId = await openReadySession('beta\n')
    const first = fakeSearch({ hits: [], total: 0, limited: false }, { pending: true })
    const second = fakeSearch({ hits: [{ line: 0, ordinal: 0 }], total: 1, limited: false })
    mocks.runFileSearch.mockReturnValueOnce(first).mockReturnValueOnce(second)

    // #when a second query arrives before the first has answered
    const firstResult = searchLargeFileSession({ sessionId, query: 'bet' })
    const secondResult = await searchLargeFileSession({ sessionId, query: 'beta' })

    // #then — one pass per session. The abandoned one stops rather than
    // finishing a crossing of the file nobody is waiting for.
    expect(first.cancel).toHaveBeenCalled()
    expect(await firstResult).toEqual({ status: 'cancelled', query: 'bet' })
    expect(secondResult).toEqual(
      expect.objectContaining({ status: 'complete', query: 'beta', total: 1 })
    )
  })

  it('ignores the partial count of a query that has been superseded', async () => {
    // #given a first search still running when a second starts
    const sessionId = await openReadySession('beta\n')
    const superseded: { emit?: (bytesSearched: number, total: number) => void } = {}
    mocks.runFileSearch
      .mockImplementationOnce(
        (
          _path: string,
          _query: string,
          _read: unknown,
          onProgress: (bytesSearched: number, total: number) => void
        ) => {
          superseded.emit = onProgress
          return fakeSearch({ hits: [], total: 0, limited: false }, { pending: true })
        }
      )
      .mockReturnValueOnce(fakeSearch({ hits: [], total: 0, limited: false }))

    // #when the older pass reports after the newer one started
    void searchLargeFileSession({ sessionId, query: 'bet' })
    await searchLargeFileSession({ sessionId, query: 'beta' })
    superseded.emit?.(4, 99)

    // #then — a count from the query before last would overwrite the current
    // one in the find bar
    expect(searchEvents().some((event) => event.query === 'bet')).toBe(false)
  })

  it('stops a running search when the session closes', async () => {
    // #given a search still crossing the file
    const sessionId = await openReadySession('beta\n')
    const run = fakeSearch({ hits: [], total: 0, limited: false }, { pending: true })
    mocks.runFileSearch.mockReturnValue(run)
    void searchLargeFileSession({ sessionId, query: 'beta' })

    // #when the viewer goes away
    await closeLargeFileSession(sessionId)

    // #then — the worker would otherwise outlive the handle it reads through
    expect(run.cancel).toHaveBeenCalled()
  })
})
