/**
 * The BlockNote converter off the main thread (converter-worker-bridge.ts).
 *
 * The bridge and the worker entry run for real, with the real converter, and
 * talk over a real MessageChannel, so every message crosses a structured clone
 * as it does between threads. Only the thread itself is faked: the worker
 * module loads in a fresh module graph of this process, since vitest cannot
 * start a worker from TypeScript sources.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'events'
import type * as Fs from 'fs'
import type * as WorkerThreads from 'worker_threads'
import type { MessagePort } from 'worker_threads'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  readMarkdownSourceRecordFromYDoc,
  writeMarkdownSourceToYDoc
} from '@memry/shared/markdown-source'

const mocks = vi.hoisted(() => ({
  /** The worker side of the channel; the worker module reads it as `parentPort`. */
  workerPort: null as MessagePort | null,
  /** Called for every spawn with the fake thread. */
  spawn: null as ((thread: EventEmitter & { postMessage: (m: unknown) => void }) => void) | null,
  ports: [] as MessagePort[],
  /** Runs when main answers an embed lookup, which a seed of AUTHOR_FILE makes mid-parse. */
  onResolveEmbeds: null as (() => void) | null
}))

vi.mock('worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerThreads>()
  const { EventEmitter } = await import('events')
  // oxlint-disable-next-line typescript/no-extraneous-class -- test double: the bridge constructs it with new
  class FakeWorker extends EventEmitter {
    private readonly mainPort: MessagePort
    constructor() {
      super()
      const { port1, port2 } = new actual.MessageChannel()
      mocks.workerPort = port1
      mocks.ports.push(port1, port2)
      this.mainPort = port2
      port2.on('message', (message: unknown) => this.emit('message', message))
      mocks.spawn?.(this)
    }
    postMessage(message: unknown): void {
      this.mainPort.postMessage(message)
    }
    terminate(): Promise<number> {
      return Promise.resolve(0)
    }
  }
  return {
    ...actual,
    Worker: FakeWorker,
    get parentPort() {
      return mocks.workerPort
    }
  }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    // The built entry exists next to the bundle; under vitest only sources do.
    existsSync: (path: string) => path.endsWith('converter-worker.js') || actual.existsSync(path)
  }
})

vi.mock('../vault/resolve-embed', () => ({
  resolveVaultEmbeds: (refs: string[]) => {
    mocks.onResolveEmbeds?.()
    return Object.fromEntries(refs.map((ref) => [ref, `../Images/${ref}`]))
  }
}))

const NOTE_PATH = 'Food/Soup.md'
const AUTHOR_FILE = '# Soup\n\n* one\n* two\n\n![[photo.png]]\n\nStir slowly\n'

/** Starts the worker module in a fresh module graph, as a new thread would. */
function startWorkerModule(): void {
  vi.resetModules()
  void import('./converter-worker')
}

/**
 * A doc whose source record no longer describes it, so serializing it reads
 * the note's file to keep the author's spelling: the call back to main.
 */
async function seededDoc(): Promise<Y.Doc> {
  const { loadBlockNoteConverter } = await import('./blocknote-converter-loader')
  const { markdownToYFragment } = await loadBlockNoteConverter()
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  expect(await markdownToYFragment(AUTHOR_FILE, fragment, NOTE_PATH)).toBe(true)
  writeMarkdownSourceToYDoc(doc, 'a record from some other version of the note')
  return doc
}

async function convertOnMain(doc: Y.Doc, readFileBody: () => Promise<string | null>) {
  const { loadBlockNoteConverter } = await import('./blocknote-converter-loader')
  const { convertForWriteback } = await import('./writeback-conversion')
  return convertForWriteback(doc, NOTE_PATH, readFileBody, await loadBlockNoteConverter())
}

describe('converter worker bridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    for (const port of mocks.ports) port.close()
    mocks.ports = []
    mocks.workerPort = null
    mocks.spawn = null
    mocks.onResolveEmbeds = null
  })

  it('writes on the worker exactly the bytes main writes', async () => {
    // #given a note whose serialization resolves an embed and reads its file
    const doc = await seededDoc()
    const readOnMain = vi.fn(async () => AUTHOR_FILE)
    const expected = await convertOnMain(doc, async () => AUTHOR_FILE)
    mocks.spawn = startWorkerModule
    const { readyWritebackConverter } = await import('./converter-worker-bridge')

    // #when the pass converts on the worker
    const convert = await readyWritebackConverter()
    const result = await convert(doc, NOTE_PATH, readOnMain)

    // #then same bytes, same outcome, and the file was read through main
    expect(expected).toMatchObject({ kind: 'serialized', sourceRestore: 'file' })
    expect(result).toEqual(expected)
    expect(readOnMain).toHaveBeenCalled()
  })

  it('converts on main when the worker dies mid-pass', async () => {
    // #given a worker that starts, then crashes on the first conversion
    const doc = await seededDoc()
    const expected = await convertOnMain(doc, async () => AUTHOR_FILE)
    mocks.spawn = (thread) => {
      thread.postMessage = (message: unknown) => {
        if ((message as { type: string }).type === 'job') thread.emit('exit', 1)
      }
      queueMicrotask(() => thread.emit('message', { type: 'ready' }))
    }
    const { readyWritebackConverter } = await import('./converter-worker-bridge')

    // #when a pass runs on it
    const convert = await readyWritebackConverter()
    const result = await convert(doc, NOTE_PATH, async () => AUTHOR_FILE)

    // #then the pass still produces the file body, converted on main
    expect(result).toEqual(expected)
  })

  it('converts on main when the worker never starts', async () => {
    const doc = await seededDoc()
    const expected = await convertOnMain(doc, async () => AUTHOR_FILE)
    mocks.spawn = (thread) => queueMicrotask(() => thread.emit('exit', 1))
    const { readyWritebackConverter } = await import('./converter-worker-bridge')

    const convert = await readyWritebackConverter()

    expect(await convert(doc, NOTE_PATH, async () => AUTHOR_FILE)).toEqual(expected)
  })
  it('seeds on the worker the doc main seeds', async () => {
    // #given two docs holding a stale source record, which the seed replaces
    const onMain = new Y.Doc()
    const onWorker = new Y.Doc()
    for (const doc of [onMain, onWorker]) writeMarkdownSourceToYDoc(doc, 'stale record')
    const { loadBlockNoteConverter } = await import('./blocknote-converter-loader')
    const { markdownToYFragment, yDocToMarkdown } = await loadBlockNoteConverter()
    await markdownToYFragment(AUTHOR_FILE, onMain.getXmlFragment(CRDT_FRAGMENT_NAME), NOTE_PATH)
    mocks.spawn = startWorkerModule
    const { seedFragment } = await import('./converter-worker-bridge')

    // #when one is seeded on the worker
    const fragment = onWorker.getXmlFragment(CRDT_FRAGMENT_NAME)
    expect(await seedFragment(AUTHOR_FILE, fragment, NOTE_PATH, undefined)).toBe(true)

    // #then the same body, the same record, and the same file bytes
    // Block ids are minted fresh by every seed, wherever it runs.
    const withoutIds = (f: Y.XmlFragment) => f.toJSON().replaceAll(/ id="[^"]*"/g, '')
    expect(withoutIds(fragment)).toBe(withoutIds(onMain.getXmlFragment(CRDT_FRAGMENT_NAME)))
    expect(readMarkdownSourceRecordFromYDoc(onWorker)).toEqual(
      readMarkdownSourceRecordFromYDoc(onMain)
    )
    expect(await yDocToMarkdown(onWorker)).toBe(await yDocToMarkdown(onMain))
  })

  it('leaves a note that filled while it was seeding', async () => {
    // #given a remote body that lands while the worker parses
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    mocks.onResolveEmbeds = () => {
      if (fragment.length === 0) fragment.insert(0, [new Y.XmlElement('blockGroup')])
    }
    mocks.spawn = startWorkerModule
    const { seedFragment } = await import('./converter-worker-bridge')

    // #when the seed comes back
    const seeded = await seedFragment(AUTHOR_FILE, fragment, NOTE_PATH, undefined)

    // #then it is dropped rather than put in beside the remote body
    expect(seeded).toBe(false)
    expect(fragment.length).toBe(1)
    expect(fragment.toJSON()).toBe('<blockgroup></blockgroup>')
  })
})
