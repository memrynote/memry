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
  buildLineIndex: vi.fn()
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

import {
  openLargeFileSession,
  readLargeFileLines,
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

/** The index-progress payloads broadcast so far. */
function indexEvents(): Array<Record<string, unknown>> {
  return mocks.broadcast.mock.calls
    .filter(([channel]) => channel === NotesChannels.events.LARGE_FILE_INDEX)
    .map(([, payload]) => payload as Record<string, unknown>)
}

describe('large-file session', () => {
  beforeEach(async () => {
    mocks.vaultDir = await mkdtemp(join(tmpdir(), 'memry-large-file-session-'))
    mocks.cache = null
    mocks.broadcast.mockClear()
    // Default: the scan completes immediately with a real index for the file.
    mocks.buildLineIndex.mockReset()
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
})
