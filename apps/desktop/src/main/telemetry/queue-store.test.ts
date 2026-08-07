import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createQueueStore } from './queue-store'

describe('createQueueStore — incremental writes', () => {
  let tempDir: string
  let filePath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-queue-store-'))
    filePath = path.join(tempDir, 'queue.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // fs.appendFileSync dispatches through fs.writeFileSync inside Node, so a spy
  // on writeFileSync sees both paths. Byte volume is what separates them: an
  // append costs one line, a rewrite costs the entire queue.
  const bytesWrittenBy = (run: () => void): number => {
    const write = vi.spyOn(fs, 'writeFileSync')
    run()
    const total = write.mock.calls.reduce((sum, call) => sum + String(call[1]).length, 0)
    write.mockRestore()
    return total
  }

  it('appends one line per item instead of rewriting the whole queue', () => {
    // #given a store holding a queue at its limit — what an offline session looks
    // like, where every extra item used to re-serialise all 500
    const store = createQueueStore<number>(filePath)
    const items = Array.from({ length: 500 }, (_, i) => i)
    store.save(items)
    const mirrorSize = fs.statSync(filePath).size
    const appendLine = vi.spyOn(fs, 'appendFileSync')

    // #when 200 more items are recorded
    const written = bytesWrittenBy(() => {
      for (let i = 500; i < 700; i++) {
        items.push(i)
        store.append(i, items)
      }
    })

    // #then each cost a single appended line, and the whole burst wrote less than
    // one copy of the queue — rewriting per item would have written ~200 copies
    expect(appendLine).toHaveBeenCalledTimes(200)
    expect(written).toBeLessThan(mirrorSize)

    // #and the mirror still holds every item, in order
    expect(createQueueStore<number>(filePath).load()).toEqual(items)
  })

  it('compacts once the journal outgrows its bound', () => {
    // #given a session that queues far more than it ever holds: the queue trims
    // from the head, which an append cannot express, so the journal keeps the
    // dropped lines until it is worth rewriting
    const store = createQueueStore<number>(filePath)
    const queue: number[] = []
    for (let i = 0; i <= 1000; i++) {
      queue.push(i)
      if (queue.length > 500) queue.shift()
      store.append(i, queue)
    }

    // #then crossing the bound rewrote the file from the live queue instead of
    // letting it grow one line per event for the life of the session
    expect(createQueueStore<number>(filePath).load()).toEqual(queue)
  })

  it('never creates the file from an append, which would leave it headerless', () => {
    // #given a store whose mirror does not exist yet
    const store = createQueueStore<number>(filePath)

    // #when the very first item is recorded
    store.append(1, [1])

    // #then the file is readable — an appended line with no header would parse as
    // an unknown format and be thrown away on the next launch
    expect(createQueueStore<number>(filePath).load()).toEqual([1])
  })

  it('reads a mirror left by the previous format', () => {
    // #given a file written by the build that shipped before the journal
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, items: [1, 2, 3] }))

    // #when this build opens it
    const store = createQueueStore<number>(filePath)

    // #then the upgrading install keeps what its last session queued, and the
    // next write upgrades the file in place
    expect(store.load()).toEqual([1, 2, 3])
    store.append(4, [1, 2, 3, 4])
    expect(createQueueStore<number>(filePath).load()).toEqual([1, 2, 3, 4])
  })

  it('drops a line the crash truncated instead of the whole journal', () => {
    // #given a journal whose last append died half-written
    const store = createQueueStore<number>(filePath)
    store.save([1, 2])
    fs.appendFileSync(filePath, '{"a":')

    // #when the next launch opens it
    // #then the complete lines survive and only the partial one is lost
    expect(createQueueStore<number>(filePath).load()).toEqual([1, 2])
  })

  it('keeps working when the mirror cannot be written', () => {
    // #given a path inside a directory that does not exist
    const store = createQueueStore<number>(path.join(tempDir, 'missing', 'queue.json'))

    // #when items are recorded
    // #then durability is the only loss; nothing throws
    expect(() => store.append(1, [1])).not.toThrow()
    expect(() => store.save([1])).not.toThrow()
  })
})
