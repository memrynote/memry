import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { CrdtTransport } from '@memry/sync-client/adapters'
import type { CrdtPersistence } from '../crdt-persistence'
import { DesktopCrdtPersistenceAdapter } from './crdt-persistence-adapter'
import { DesktopCrdtProviderHost } from './crdt-provider-host'

function docWithText(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}

function textOf(state: { updates: Uint8Array[] }): string {
  const doc = new Y.Doc()
  for (const update of state.updates) Y.applyUpdate(doc, update)
  const text = doc.getText('content').toString()
  doc.destroy()
  return text
}

describe('DesktopCrdtPersistenceAdapter (real y-leveldb)', () => {
  let dir: string
  let store: LeveldbPersistence
  let adapter: DesktopCrdtPersistenceAdapter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crdt-adapter-'))
    store = new LeveldbPersistence(dir)
    adapter = new DesktopCrdtPersistenceAdapter(store as unknown as CrdtPersistence)
  })

  afterEach(async () => {
    await store.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips appended updates through loadDoc', async () => {
    const source = docWithText('hello')
    await adapter.appendUpdate('doc-1', Y.encodeStateAsUpdate(source))
    source.getText('content').insert(5, ' world')
    await adapter.appendUpdate('doc-1', Y.encodeStateAsUpdate(source))
    source.destroy()

    const state = await adapter.loadDoc('doc-1')
    expect(textOf(state)).toBe('hello world')
  })

  it('saveSnapshot supersedes prior updates and compact keeps the content', async () => {
    const source = docWithText('draft')
    await adapter.appendUpdate('doc-2', Y.encodeStateAsUpdate(source))
    source.getText('content').delete(0, 5)
    source.getText('content').insert(0, 'final')
    await adapter.saveSnapshot('doc-2', Y.encodeStateAsUpdate(source), 7)
    source.destroy()

    await adapter.compact('doc-2')
    const state = await adapter.loadDoc('doc-2')
    expect(textOf(state)).toBe('final')
  })

  it('lists appended docs and deleteDoc removes content and listing both', async () => {
    const source = docWithText('x')
    await adapter.appendUpdate('doc-3', Y.encodeStateAsUpdate(source))
    source.destroy()

    expect(await adapter.listDocs()).toContain('doc-3')

    await adapter.deleteDoc('doc-3')
    const state = await adapter.loadDoc('doc-3')
    expect(textOf(state)).toBe('')
    expect(await adapter.listDocs()).not.toContain('doc-3')
  })
})

interface FakeTransport extends CrdtTransport {
  received: Uint8Array[][]
  pushFromUi: (frames: Uint8Array[]) => void
}

function makeTransport(originTag: string): FakeTransport {
  let uiCallback: ((frames: Uint8Array[]) => void) | null = null
  const transport: FakeTransport = {
    originTag,
    received: [],
    sendToUi(frames) {
      transport.received.push(frames)
    },
    onFromUi(cb) {
      uiCallback = cb
      return () => {
        uiCallback = null
      }
    },
    pushFromUi(frames) {
      uiCallback?.(frames)
    }
  }
  return transport
}

function receivedText(transport: FakeTransport): string {
  const doc = new Y.Doc()
  for (const frames of transport.received) {
    for (const frame of frames) Y.applyUpdate(doc, frame)
  }
  const text = doc.getText('content').toString()
  doc.destroy()
  return text
}

describe('DesktopCrdtProviderHost', () => {
  it('sends the full current state to a late-attaching transport', async () => {
    const doc = docWithText('existing')
    const host = new DesktopCrdtProviderHost({ open: async () => doc })
    const transport = makeTransport('t1')

    const detach = host.attach('note-1', transport)
    await Promise.resolve()

    expect(receivedText(transport)).toBe('existing')
    detach()
    doc.destroy()
  })

  it('applies UI frames to the doc without echoing them back, and fans out to other transports', async () => {
    const doc = docWithText('')
    const host = new DesktopCrdtProviderHost({ open: async () => doc })
    const editor = makeTransport('editor')
    const observer = makeTransport('observer')

    const detachEditor = host.attach('note-1', editor)
    const detachObserver = host.attach('note-1', observer)
    await Promise.resolve()
    const editorFramesAfterAttach = editor.received.length

    const uiDoc = new Y.Doc()
    uiDoc.getText('content').insert(0, 'typed on ui')
    editor.pushFromUi([Y.encodeStateAsUpdate(uiDoc)])
    uiDoc.destroy()

    expect(doc.getText('content').toString()).toBe('typed on ui')
    // The editor's own frame must not come back to it…
    expect(editor.received.length).toBe(editorFramesAfterAttach)
    // …but the other attachment sees it.
    expect(receivedText(observer)).toBe('typed on ui')

    detachEditor()
    detachObserver()
    doc.destroy()
  })

  it('buffers frames sent before open resolves and replays them in order', async () => {
    const doc = new Y.Doc()
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = new DesktopCrdtProviderHost({
      open: async () => {
        await gate
        return doc
      }
    })
    const transport = makeTransport('early')
    const detach = host.attach('note-1', transport)

    const uiDoc = docWithText('before open')
    transport.pushFromUi([Y.encodeStateAsUpdate(uiDoc)])
    uiDoc.destroy()
    expect(doc.getText('content').toString()).toBe('')

    release!()
    await gate
    await Promise.resolve()

    expect(doc.getText('content').toString()).toBe('before open')
    detach()
    doc.destroy()
  })

  it('detach stops both directions', async () => {
    const doc = docWithText('')
    const host = new DesktopCrdtProviderHost({ open: async () => doc })
    const transport = makeTransport('gone')
    const detach = host.attach('note-1', transport)
    await Promise.resolve()

    detach()
    const framesAtDetach = transport.received.length

    const uiDoc = docWithText('after detach')
    transport.pushFromUi([Y.encodeStateAsUpdate(uiDoc)])
    uiDoc.destroy()
    expect(doc.getText('content').toString()).toBe('')

    doc.getText('content').insert(0, 'engine edit')
    expect(transport.received.length).toBe(framesAtDetach)

    doc.destroy()
  })
})
