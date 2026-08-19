import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, open, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileHandleReader, type ByteReader } from './large-file-index'
import type { LargeFileWorkerInput } from './large-file-index-worker-protocol'

const mocks = vi.hoisted(() => ({
  /** null = constructing a Worker throws, standing in for a missing bundle. */
  spawn: null as ((path: string) => EventEmitter) | null,
  spawned: [] as Array<{ path: string; input: LargeFileWorkerInput }>,
  terminated: 0,
  warned: [] as unknown[]
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (_message: string, context?: unknown) => mocks.warned.push(context),
    error: vi.fn()
  })
}))

vi.mock('worker_threads', () => ({
  Worker: class {
    constructor(path: string, options: { workerData: LargeFileWorkerInput }) {
      mocks.spawned.push({ path, input: options.workerData })
      if (!mocks.spawn) throw new Error('Cannot find module large-file-index-worker.js')
      const emitter = mocks.spawn(path)
      // The bridge attaches its listeners synchronously after construction.
      Object.assign(this, emitter, {
        on: emitter.on.bind(emitter),
        once: emitter.once.bind(emitter),
        off: emitter.off.bind(emitter),
        removeAllListeners: emitter.removeAllListeners.bind(emitter),
        terminate: () => {
          mocks.terminated += 1
          return Promise.resolve(0)
        }
      })
    }
  }
}))

import { runFileSearch } from './large-file-search-bridge'

/**
 * A file the caller already holds open, which is how the session calls this:
 * the path is only ever handed to the worker, and the in-process fallback reads
 * through the handle rather than resolving the name again.
 */
async function withOpenVaultFile<T>(
  body: string,
  run: (path: string, read: ByteReader) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'memry-large-file-search-'))
  const path = join(dir, 'log.md')
  await writeFile(path, body)
  const handle = await open(path, 'r')
  try {
    return await run(path, fileHandleReader(handle))
  } finally {
    await handle.close()
    await rm(dir, { recursive: true, force: true })
  }
}

describe('runFileSearch', () => {
  beforeEach(() => {
    mocks.spawn = null
    mocks.spawned = []
    mocks.terminated = 0
    mocks.warned = []
  })

  it('searches on a worker thread, not on the thread that draws the UI', async () => {
    // #given a worker that answers with progress and then the hits
    const emitter = new EventEmitter()
    mocks.spawn = () => {
      queueMicrotask(() => {
        emitter.emit('message', { type: 'search-progress', bytesSearched: 4, total: 1 })
        emitter.emit('message', {
          type: 'search-done',
          hits: [{ line: 0, ordinal: 0 }],
          total: 1,
          limited: false,
          bytesSearched: 10
        })
      })
      return emitter
    }
    const progress: Array<[number, number]> = []

    // #when
    const found = await withOpenVaultFile(
      'alpha\nbeta\n',
      (path, read) =>
        runFileSearch(path, 'beta', read, (bytes, total) => progress.push([bytes, total])).result
    )

    // #then — the answer is the worker's, so no whole-file pass ran here
    expect(mocks.spawned).toHaveLength(1)
    expect(mocks.spawned[0].path).toMatch(/large-file-index-worker\.js$/)
    expect(mocks.spawned[0].input).toMatchObject({ kind: 'search', query: 'beta' })
    expect(found.hits).toEqual([{ line: 0, ordinal: 0 }])
    expect(progress).toEqual([[4, 1]])
  })

  it('still finds the matches when the worker cannot start', async () => {
    // #given no worker at all — a build that shipped without the entry, or a
    // platform where the thread will not spawn
    const body = Array.from({ length: 40 }, (_, i) => `row ${i} hit`).join('\n')

    // #when
    const found = await withOpenVaultFile(
      body,
      (path, read) => runFileSearch(path, 'hit', read, () => {}).result
    )

    // #then — searching slowly beats a find bar that answers nothing
    expect(found.total).toBe(40)
  })

  it('stops the worker when the query is superseded', async () => {
    // #given a worker that never answers, because the file is enormous
    const emitter = new EventEmitter()
    mocks.spawn = () => emitter

    // #when the caller cancels
    const found = await withOpenVaultFile('alpha\nbeta\n', async (path, read) => {
      const run = runFileSearch(path, 'beta', read, () => {})
      run.cancel()
      return run.result
    })

    // #then — a superseded query must not keep a thread crossing 2 GB
    expect(found.cancelled).toBe(true)
    expect(mocks.terminated).toBe(1)
  })

  it('stops the in-process fallback part-way through the file', async () => {
    // #given no worker, and a reader that hands out one small window per call
    const bytes = Buffer.from(
      Array.from({ length: 500 }, (_, i) => `row ${i} hit`).join('\n'),
      'utf8'
    )
    let cancel = (): void => {}
    let windows = 0
    const read: ByteReader = async (buffer, position) => {
      windows += 1
      // Two windows in, the user has typed another character.
      if (windows > 2) cancel()
      if (position >= bytes.length) return 0
      const end = Math.min(position + 16, bytes.length)
      bytes.copy(buffer, 0, position, end)
      return end - position
    }

    // #when
    const run = runFileSearch('/vault/log.md', 'hit', read, () => {})
    cancel = run.cancel
    const found = await run.result

    // #then — the fallback yields between windows, so a superseded query stops
    // there too rather than reading to the end of a 2 GB file
    expect(found.cancelled).toBe(true)
    expect(found.bytesSearched).toBeLessThan(bytes.length)
  })

  it('falls back when the worker fails partway rather than answering nothing', async () => {
    // #given a worker that dies mid-search
    const emitter = new EventEmitter()
    mocks.spawn = () => {
      queueMicrotask(() => emitter.emit('error', new Error('worker died')))
      return emitter
    }

    // #when
    const found = await withOpenVaultFile(
      'alpha\nbeta\n',
      (path, read) => runFileSearch(path, 'beta', read, () => {}).result
    )

    // #then
    expect(found.total).toBe(1)
  })

  it('keeps a non-Error worker failure debuggable', async () => {
    // #given a thread that fails with something that is not an Error — a bare
    // value is what a thrown string looks like once it has crossed the boundary
    const emitter = new EventEmitter()
    mocks.spawn = () => {
      queueMicrotask(() => emitter.emit('error', 'ENOMEM'))
      return emitter
    }

    // #when — the search still answers, on the fallback, so the worker failure
    // only ever exists in the log
    const found = await withOpenVaultFile(
      'alpha\nbeta\n',
      (path, read) => runFileSearch(path, 'beta', read, () => {}).result
    )

    // #then — the find bar is unaffected...
    expect(found.total).toBe(1)
    // ...and what was logged carries a stack, which is the one thing anyone
    // reading a worker failure out of a user's log actually needs
    const logged = mocks.warned.at(-1) as { err?: unknown } | undefined
    expect(logged?.err).toBeInstanceOf(Error)
    expect((logged?.err as Error).message).toContain('ENOMEM')
    expect((logged?.err as Error).cause).toBe('ENOMEM')
  })
})
