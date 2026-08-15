import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, open, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileHandleReader, type ByteReader } from './large-file-index'

const mocks = vi.hoisted(() => ({
  /** null = constructing a Worker throws, standing in for a missing bundle. */
  spawn: null as ((path: string) => EventEmitter) | null,
  spawned: [] as string[]
}))

vi.mock('worker_threads', () => ({
  Worker: class {
    constructor(path: string) {
      mocks.spawned.push(path)
      if (!mocks.spawn) throw new Error('Cannot find module large-file-index-worker.js')
      const emitter = mocks.spawn(path)
      // The bridge attaches its listeners synchronously after construction.
      Object.assign(this, emitter, {
        on: emitter.on.bind(emitter),
        once: emitter.once.bind(emitter),
        off: emitter.off.bind(emitter),
        removeAllListeners: emitter.removeAllListeners.bind(emitter),
        terminate: () => Promise.resolve(0)
      })
    }
  }
}))

import { buildLineIndex } from './large-file-index-bridge'

/**
 * A file the caller already holds open, which is how the session calls this:
 * the path is only ever handed to the worker, and the in-process fallback reads
 * through the handle rather than resolving the name again.
 */
async function withOpenVaultFile<T>(
  body: string,
  run: (path: string, read: ByteReader) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'memry-large-file-bridge-'))
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

describe('buildLineIndex', () => {
  beforeEach(() => {
    mocks.spawn = null
    mocks.spawned = []
  })

  it('scans on a worker thread, not on the main thread', async () => {
    // #given a worker that answers with progress and then a finished index
    const emitter = new EventEmitter()
    mocks.spawn = () => {
      queueMicrotask(() => {
        emitter.emit('message', { type: 'progress', bytesScanned: 4 })
        emitter.emit('message', {
          type: 'done',
          checkpoints: Float64Array.from([0, 5]),
          stride: 1,
          lineCount: 2,
          fileBytes: 9
        })
      })
      return emitter
    }
    const progress: number[] = []

    // #when
    const index = await withOpenVaultFile('alpha\nbet\n', (path, read) =>
      buildLineIndex(path, 10, read, (n) => progress.push(n))
    )

    // #then — the answer is the worker's, so the whole-file pass never ran here.
    // A 2 GB scan on the main process is a stall however it is chunked.
    expect(mocks.spawned).toHaveLength(1)
    expect(mocks.spawned[0]).toMatch(/large-file-index-worker\.js$/)
    expect(index.lineCount).toBe(2)
    expect(progress).toEqual([4])
  })

  it('still produces an index when the worker cannot start', async () => {
    // #given no worker at all — a build that shipped without the entry, or a
    // platform where the thread will not spawn
    const body = Array.from({ length: 120 }, (_, i) => `row ${i}`).join('\n') + '\n'
    const progress: number[] = []

    // #when
    const index = await withOpenVaultFile(body, (path, read) =>
      buildLineIndex(path, body.length, read, (n) => progress.push(n))
    )

    // #then — the viewer still opens, and still shows a moving bar. Falling back
    // to an unusable viewer would be worse than the placeholder it replaced.
    expect(index.lineCount).toBe(120)
    expect(progress.at(-1)).toBe(body.length)
  })

  it('falls back when the worker fails partway rather than failing the open', async () => {
    // #given a worker that dies mid-scan
    const body = 'one\ntwo\nthree\n'
    const emitter = new EventEmitter()
    mocks.spawn = () => {
      queueMicrotask(() => emitter.emit('error', new Error('worker died')))
      return emitter
    }

    // #when
    const index = await withOpenVaultFile(body, (path, read) =>
      buildLineIndex(path, body.length, read, () => {})
    )

    // #then
    expect(index.lineCount).toBe(3)
  })

  it('surfaces a read failure the fallback cannot fix', async () => {
    // #given a handle that has gone away underneath the session
    const read: ByteReader = () => Promise.reject(new Error('EBADF'))

    // #when/#then — an unreadable file is a real error, not something to retry
    await expect(buildLineIndex('/vault/log.md', 10, read, () => {})).rejects.toThrow('EBADF')
  })

  it('is built as its own bundle entry, or nothing ever runs off the main thread', async () => {
    // #given the build config
    const { readFile } = await import('fs/promises')
    const config = await readFile(join(__dirname, '../../../electron.vite.config.ts'), 'utf8')

    // #then — without this entry the worker file is never emitted, `new Worker`
    // fails on every scan, and the bridge degrades to the in-process fallback
    // for the life of the build. Silently: the fallback is correct, only slower
    // and on the wrong thread, so nothing else would catch it.
    expect(config).toContain('src/main/vault/large-file-index-worker.ts')
  })
})
