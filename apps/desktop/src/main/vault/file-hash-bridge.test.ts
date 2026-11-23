import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { mkdtemp, rm, truncate, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  /** null = constructing a Worker throws, standing in for a missing bundle. */
  spawn: null as ((workerData: unknown) => EventEmitter) | null
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('worker_threads', () => ({
  // oxlint-disable-next-line typescript/no-extraneous-class -- test double: the code under test calls it with new
  Worker: class {
    constructor(_path: string, options: { workerData: unknown }) {
      if (!mocks.spawn) throw new Error('Cannot find module large-file-index-worker.js')
      const emitter = mocks.spawn(options.workerData)
      Object.assign(this, {
        on: emitter.on.bind(emitter),
        removeAllListeners: emitter.removeAllListeners.bind(emitter),
        terminate: () => Promise.resolve(0)
      })
    }
  }
}))

import { IN_PROCESS_HASH_MAX_BYTES, hashFileOffThread } from './file-hash-bridge'

describe('hashFileOffThread', () => {
  let dir: string
  const jobs: unknown[] = []
  const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

  beforeEach(async () => {
    mocks.spawn = null
    jobs.length = 0
    dir = await mkdtemp(join(tmpdir(), 'memry-file-hash-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const workerAnswering = (sha: string) => (workerData: unknown) => {
    jobs.push(workerData)
    const worker = new EventEmitter()
    setImmediate(() => worker.emit('message', { type: 'hash-done', sha256: sha }))
    return worker
  }

  it("hands a large file to the worker and answers with the worker's sha256", async () => {
    const large = join(dir, 'v.mp4')
    await writeFile(large, '')
    await truncate(large, IN_PROCESS_HASH_MAX_BYTES + 1)
    mocks.spawn = workerAnswering('from-the-worker')

    await expect(hashFileOffThread(large)).resolves.toBe('from-the-worker')
    expect(jobs).toEqual([{ kind: 'hash', absolutePath: large }])
  })

  // A worker costs more to start than a small file costs to hash (#5617).
  it('hashes a small file in-process, with no worker', async () => {
    await writeFile(join(dir, 'p.png'), 'image bytes')
    mocks.spawn = workerAnswering('from-the-worker')

    await expect(hashFileOffThread(join(dir, 'p.png'))).resolves.toBe(sha256('image bytes'))
    await expect(hashFileOffThread(join(dir, 'gone.png'))).resolves.toBeNull()
    expect(jobs).toEqual([])
  })

  it('hashes a large file in-process when the worker cannot start', async () => {
    const large = join(dir, 'v.mp4')
    await writeFile(large, '')
    await truncate(large, IN_PROCESS_HASH_MAX_BYTES + 1)

    await expect(hashFileOffThread(large)).resolves.toBe(
      createHash('sha256')
        .update(Buffer.alloc(IN_PROCESS_HASH_MAX_BYTES + 1))
        .digest('hex')
    )
  })
})
