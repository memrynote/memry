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

  // The journal is newline-delimited, so a value carrying a raw newline would
  // forge extra entries or truncate the parse. Telemetry dimensions can carry
  // remote-controlled text — page titles and URLs scraped by the inbox fetcher
  // reach them — so this is the format's load-bearing invariant, and CodeQL
  // flags the append as a network-data-to-file sink for exactly that reason.
  const HOSTILE = {
    lf: 'a\nb',
    crlf: 'a\r\nb',
    cr: 'a\rb',
    forgedLine: '\n{"id":"forged","name":"app_crashed"}\n',
    forgedHeader: '\n{"version":2}\n',
    quotes: 'he said "hi" \\ and \\\\ too',
    // JSON.stringify emits U+2028/U+2029 raw — legal inside a JSON string, and
    // harmless here only because the journal splits on \n alone.
    lineSeparators: 'a\u2028b\u2029c',
    controls: 'a\tb\u0000c\u001fd',
    // Keys go through the same quoting as values.
    ['key\nwith\nnewlines']: 'value'
  }

  it('cannot be made to forge journal lines by an item carrying newlines', () => {
    // #given three items whose values (and one key) carry every line-breaking
    // character, plus text shaped like a complete journal entry and header
    const store = createQueueStore<Record<string, string>>(filePath)
    const items = [HOSTILE, { plain: 'ordinary' }, HOSTILE]
    store.save([items[0]])
    store.append(items[1], items.slice(0, 2))
    store.append(items[2], items)

    // #then the file is exactly one header line plus one line per item — the
    // embedded newlines were escaped, not written raw
    const raw = fs.readFileSync(filePath, 'utf-8')
    expect(raw.split('\n')).toHaveLength(items.length + 2) // + header, + trailing ''
    expect(raw.endsWith('\n')).toBe(true)

    // #and every value survives byte-for-byte, forged lines included
    const restored = createQueueStore<Record<string, string>>(filePath).load()
    expect(restored).toEqual(items)
    expect(restored[0].forgedLine).toBe(HOSTILE.forgedLine)
    expect(restored[0]['key\nwith\nnewlines']).toBe('value')
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

  it('keeps working when the disk fails mid-session, after the journal started', () => {
    // #given a healthy journal that then hits a full or read-only disk — the
    // append path has its own failure handling, separate from the rewrite path
    const store = createQueueStore<number>(filePath)
    store.save([1])
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('ENOSPC')
    })

    // #when further items are recorded
    // #then nothing throws and the already-journalled items are still readable
    expect(() => store.append(2, [1, 2])).not.toThrow()
    expect(() => store.append(3, [1, 2, 3])).not.toThrow()
    vi.restoreAllMocks()
    expect(createQueueStore<number>(filePath).load()).toEqual([1])
  })

  it.each([
    ['a header that is not an object', '5\n'],
    ['a v1 header whose items are not an array', '{"version":1,"items":"nope"}'],
    ['a v2 header with no items yet', '{"version":2}']
  ])('starts clean on %s', (_case, contents) => {
    // #given a mirror this build cannot make sense of
    fs.writeFileSync(filePath, contents)

    // #when the next launch opens it
    // #then it yields nothing rather than throwing or half-parsing
    expect(createQueueStore<number>(filePath).load()).toEqual([])
  })
})
