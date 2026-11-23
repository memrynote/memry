import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
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

import { hashFileOffThread } from './file-hash-bridge'

describe('hashFileOffThread', () => {
  beforeEach(() => {
    mocks.spawn = null
  })

  it("hands the path to the worker and answers with the worker's sha256", async () => {
    const jobs: unknown[] = []
    mocks.spawn = (workerData) => {
      jobs.push(workerData)
      const worker = new EventEmitter()
      setImmediate(() => worker.emit('message', { type: 'hash-done', sha256: 'from-the-worker' }))
      return worker
    }

    await expect(hashFileOffThread('/vault/p.png')).resolves.toBe('from-the-worker')
    expect(jobs).toEqual([{ kind: 'hash', absolutePath: '/vault/p.png' }])
  })

  it('hashes in-process when the worker cannot start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memry-file-hash-'))
    try {
      await writeFile(join(dir, 'p.png'), 'image bytes')

      await expect(hashFileOffThread(join(dir, 'p.png'))).resolves.toBe(
        createHash('sha256').update('image bytes').digest('hex')
      )
      await expect(hashFileOffThread(join(dir, 'gone.png'))).resolves.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
