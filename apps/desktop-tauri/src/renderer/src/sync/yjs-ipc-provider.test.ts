import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

/**
 * A fake editor host behind the `crdt_*` commands, as `commands/editor.rs` answers them: the
 * open is framed (header length, JSON header, state, state vector) and binds the channel it was
 * given; an edit is the raw body with `{ noteId }` in the metadata. `refuse` makes the next edits
 * fail with a `CommandError` code.
 */
interface TestChannel {
  onmessage: (data: ArrayBuffer) => void
}

const host = vi.hoisted(() => ({
  doc: null as unknown as Y.Doc,
  channels: [] as TestChannel[],
  opens: [] as Array<Record<string, unknown>>,
  sent: [] as Array<{ command: string; update: Uint8Array; meta: unknown }>,
  closes: [] as string[],
  needsSeed: false,
  readOnly: null as string | null,
  refuse: null as string | null,
  /** How many more edits `refuse` refuses; null refuses every one. */
  refuseTimes: null as number | null,
  /** Edits wait on this before they land, so a test can hold one in flight. */
  gate: null as Promise<void> | null,
  openGate: null as Promise<void> | null,
  closeGate: null as Promise<void> | null,
  /** What reached the host, in order: `open` when an open is answered, `close` when one is sent. */
  calls: [] as string[],
  resetListeners: new Set<(event: { payload: null }) => void>(),
  readyListeners: new Set<(event: { payload: { vaultPath: string } }) => void>()
}))

function frame(header: unknown, ...parts: Uint8Array[]): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const total = 4 + json.length + parts.reduce((sum, part) => sum + part.length, 0)
  const bytes = new Uint8Array(total)
  new DataView(bytes.buffer).setUint32(0, json.length, false)
  bytes.set(json, 4)
  let offset = 4 + json.length
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes.buffer
}

vi.mock('@tauri-apps/api/core', async () => {
  const Yjs = await import('yjs')
  return {
    Channel: class {
      constructor(public onmessage: (data: ArrayBuffer) => void = () => {}) {}
    },
    invoke: vi.fn(async (command: string, args: unknown, options?: { headers: never }) => {
      if (command === 'crdt_open_doc') {
        const input = args as Record<string, unknown>
        host.opens.push(input)
        host.channels.push(input.onUpdate as TestChannel)
        await host.openGate
        host.calls.push('open')
        const state = Yjs.encodeStateAsUpdate(host.doc)
        return frame(
          { needsSeed: host.needsSeed, stateLength: state.length, readOnly: host.readOnly },
          state,
          Yjs.encodeStateVector(host.doc)
        )
      }
      await host.gate
      const meta = JSON.parse(options?.headers['x-memry-meta'] ?? 'null') as unknown
      const update = args as Uint8Array
      host.sent.push({ command, update, meta })
      if (host.refuse && host.refuseTimes !== 0) {
        if (host.refuseTimes !== null) host.refuseTimes -= 1
        // oxlint-disable-next-line typescript/only-throw-error -- Tauri rejects a command with its serialized `CommandError`, a plain object
        throw { kind: 'invalid', code: host.refuse, message: host.refuse }
      }
      Yjs.applyUpdate(host.doc, update, 'window')
      host.calls.push('apply')
      return null
    })
  }
})

vi.mock('../../../generated/bindings', () => ({
  commands: {
    crdtCloseDoc: async (noteId: string) => {
      host.calls.push('close')
      await host.closeGate
      host.closes.push(noteId)
      return null
    }
  },
  events: {
    crdtProviderResetEvent: {
      listen: async (handler: (event: { payload: null }) => void) => {
        host.resetListeners.add(handler)
        return () => host.resetListeners.delete(handler)
      }
    },
    crdtProviderReadyEvent: {
      listen: async (handler: (event: { payload: { vaultPath: string } }) => void) => {
        host.readyListeners.add(handler)
        return () => host.readyListeners.delete(handler)
      }
    }
  }
}))

const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { flushAllPendingSaves, hasPendingSaves } from '@/lib/save-registry'
import { DocNeedsSeedError, YjsIpcProvider } from './yjs-ipc-provider'

const NOTE = 'note-1'

async function settle(cycles = 30): Promise<void> {
  for (let i = 0; i < cycles; i += 1) await Promise.resolve()
}

function text(doc: Y.Doc): string {
  return doc.getText('t').toJSON()
}

function type(doc: Y.Doc, value: string): void {
  doc.getText('t').insert(doc.getText('t').length, value)
}

/** Another window's edit of the host document, as the host's channel frame carries it. */
function otherWindowFrame(value: string, origin = 0): ArrayBuffer {
  const before = Y.encodeStateVector(host.doc)
  type(host.doc, value)
  const update = Y.encodeStateAsUpdate(host.doc, before)
  const bytes = new Uint8Array(update.length + 1)
  bytes[0] = origin
  bytes.set(update, 1)
  return bytes.buffer
}

const lastChannel = (): TestChannel => host.channels[host.channels.length - 1]

const reset = (): void => host.resetListeners.forEach((listen) => listen({ payload: null }))
const ready = (vaultPath = '/vault'): void =>
  host.readyListeners.forEach((listen) => listen({ payload: { vaultPath } }))

async function connected(config: Partial<ConstructorParameters<typeof YjsIpcProvider>[0]> = {}) {
  const doc = new Y.Doc()
  const provider = new YjsIpcProvider({ noteId: NOTE, doc, ...config })
  await provider.connect()
  return { doc, provider }
}

beforeEach(() => {
  host.doc = new Y.Doc()
  type(host.doc, 'stored')
  host.channels = []
  host.opens = []
  host.sent = []
  host.closes = []
  host.needsSeed = false
  host.readOnly = null
  host.refuse = null
  host.refuseTimes = null
  host.gate = null
  host.openGate = null
  host.closeGate = null
  host.calls = []
  host.resetListeners.clear()
  host.readyListeners.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** Holds every edit the host gets until the returned function lets them land. */
function holdEdits(): () => void {
  let open!: () => void
  host.gate = new Promise((resolve) => (open = resolve))
  return open
}

describe('YjsIpcProvider.connect', () => {
  it('opens the note on a channel, takes its state and sends nothing it already has', async () => {
    const { doc, provider } = await connected({ vaultPath: '/vault' })

    expect(host.opens).toEqual([
      expect.objectContaining({ noteId: NOTE, vaultPath: '/vault', onUpdate: lastChannel() })
    ])
    expect(text(doc)).toBe('stored')
    expect(host.sent).toEqual([])
    expect(provider.isSynced).toBe(true)
    expect(provider.readOnly).toBeNull()
  })

  it('sends what the window held beyond the host as sync step 2', async () => {
    const doc = new Y.Doc()
    type(doc, 'offline ')
    const provider = new YjsIpcProvider({ noteId: NOTE, doc })
    await provider.connect()

    expect(host.sent.map((sent) => sent.command)).toEqual(['crdt_sync_step_2'])
    expect(host.sent[0].meta).toEqual({ noteId: NOTE })
    expect(text(host.doc)).toBe(text(doc))
  })

  it('refuses to bind a document the host did not seed, so the editor keeps the file', async () => {
    host.doc = new Y.Doc()
    host.needsSeed = true
    const provider = new YjsIpcProvider({ noteId: NOTE, doc: new Y.Doc() })

    await expect(provider.connect()).rejects.toBeInstanceOf(DocNeedsSeedError)
  })
})

describe('YjsIpcProvider updates', () => {
  it('applies a frame of any origin as remote and never sends it back', async () => {
    const { doc } = await connected()

    lastChannel().onmessage(otherWindowFrame(' from side', 0))
    lastChannel().onmessage(otherWindowFrame(' from disk', 2))
    await settle()

    expect(text(doc)).toBe('stored from side from disk')
    expect(host.sent).toEqual([])
  })

  it('sends local edits in order, one request at a time, merging those typed meanwhile', async () => {
    const { doc } = await connected()
    let open!: () => void
    host.gate = new Promise((resolve) => (open = resolve))

    type(doc, ' a')
    await settle()
    type(doc, 'b')
    type(doc, 'c')
    await settle()
    expect(host.sent).toHaveLength(0)
    open()
    await settle()

    expect(host.sent.map((sent) => sent.command)).toEqual([
      'crdt_apply_update',
      'crdt_apply_update'
    ])
    expect(text(host.doc)).toBe('stored abc')
  })

  it('drops frames of an earlier channel once the note reopened on a new one', async () => {
    const { doc } = await connected()
    const first = lastChannel()
    reset()
    ready()
    await settle()
    expect(host.channels).toHaveLength(2)

    first.onmessage(otherWindowFrame(' stale'))
    await settle()
    expect(text(doc)).toBe('stored')
  })
})

describe('YjsIpcProvider outside edits', () => {
  const EXTERNAL = 2
  const paragraph = (value: string): Y.XmlElement => {
    const element = new Y.XmlElement('paragraph')
    element.insert(0, [new Y.XmlText(value)])
    return element
  }
  const body = (doc: Y.Doc): string => doc.getXmlFragment(CRDT_FRAGMENT_NAME).toJSON()

  /** The core replaced the body with a file edited outside the app, as the feed does. */
  function outsideEditFrame(value: string): ArrayBuffer {
    const before = Y.encodeStateVector(host.doc)
    const fragment = host.doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    host.doc.transact(() => {
      fragment.delete(0, fragment.length)
      fragment.insert(0, [paragraph(value)])
    })
    const update = Y.encodeStateAsUpdate(host.doc, before)
    const bytes = new Uint8Array(update.length + 1)
    bytes[0] = EXTERNAL
    bytes.set(update, 1)
    return bytes.buffer
  }

  async function withBody() {
    host.doc = new Y.Doc()
    host.doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [paragraph('first words')])
    const opened = await connected()
    const typeInBody = (value: string): void => {
      const words = opened.doc.getXmlFragment(CRDT_FRAGMENT_NAME).get(0) as Y.XmlElement
      ;(words.get(0) as Y.XmlText).insert(11, value)
    }
    return { ...opened, typeInBody }
  }

  it('keeps typing still on its way to the host over an outside edit the host took first', async () => {
    const { doc, typeInBody } = await withBody()
    const release = holdEdits()
    typeInBody(' typed')
    lastChannel().onmessage(outsideEditFrame('edited outside'))
    release()
    await settle()

    expect(body(doc)).toContain('first words typed')
    expect(body(doc)).not.toContain('edited outside')
    expect(body(host.doc)).toBe(body(doc))
    // The host keeps the file the outside edit wrote as a version, once.
    const flagged = host.sent.filter(
      (sent) => (sent.meta as Record<string, unknown>).overOutsideEdit
    )
    expect(flagged).toHaveLength(1)

    typeInBody('!')
    await settle()
    expect(host.sent.at(-1)?.meta).toEqual({ noteId: NOTE })
  })

  it('asks again to keep the outside edit when the typing put back over it failed to store', async () => {
    vi.useFakeTimers()
    const { typeInBody } = await withBody()
    const release = holdEdits()
    typeInBody(' typed')
    lastChannel().onmessage(outsideEditFrame('edited outside'))
    host.refuse = 'storage_failed'
    host.refuseTimes = 2
    release()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(body(host.doc)).toContain('first words typed')
    const last = host.sent.at(-1)?.meta as Record<string, unknown>
    expect(last.overOutsideEdit).toBe(true)
  })

  it('takes an outside edit when no typing is on its way', async () => {
    const { doc, typeInBody } = await withBody()
    typeInBody(' typed')
    await settle()
    lastChannel().onmessage(outsideEditFrame('edited outside'))
    await settle()

    expect(body(doc)).toBe(body(host.doc))
    expect(body(doc)).toContain('edited outside')
    expect(
      host.sent.every((sent) => sent.meta !== null && !('overOutsideEdit' in (sent.meta as object)))
    ).toBe(true)
  })
})

describe('YjsIpcProvider read-only', () => {
  it('opens a locked note read-only and sends none of its edits', async () => {
    host.readOnly = 'locked'
    const doc = new Y.Doc()
    type(doc, 'held before the open ')
    const provider = new YjsIpcProvider({ noteId: NOTE, doc })
    await provider.connect()

    type(doc, ' typed')
    await settle()

    expect(provider.readOnly).toBe('locked')
    expect(host.sent).toEqual([])
  })

  it.each([
    ['note_locked', 'locked'],
    ['note_large_file', 'large-file']
  ])('turns read-only when the host refuses an edit with %s', async (code, reason) => {
    const { doc, provider } = await connected()
    const heard: unknown[] = []
    provider.on('read-only', (value: unknown) => heard.push(value))
    host.refuse = code

    type(doc, ' first')
    await settle()
    type(doc, ' second')
    await settle()

    expect(provider.readOnly).toBe(reason)
    expect(heard).toEqual([reason])
    expect(host.sent).toHaveLength(1)
  })
})

describe('YjsIpcProvider purge', () => {
  it('drops every later frame and edit after the purge byte, and no ready reopens it', async () => {
    const { doc } = await connected()

    lastChannel().onmessage(new Uint8Array([4]).buffer)
    lastChannel().onmessage(otherWindowFrame(' recreated'))
    type(doc, ' typed')
    reset()
    ready()
    await settle()

    expect(text(doc)).toBe('stored typed')
    expect(host.sent).toEqual([])
    expect(host.opens).toHaveLength(1)
  })

  it('turns the editor read-only on a purge, so no keystroke is dropped unseen', async () => {
    const { provider } = await connected()
    const heard: unknown[] = []
    provider.on('read-only', (value: unknown) => heard.push(value))

    lastChannel().onmessage(new Uint8Array([4]).buffer)

    expect(provider.readOnly).toBe('purged')
    expect(heard).toEqual(['purged'])
  })

  it('stops sending once the host answers document_purged', async () => {
    const { doc, provider } = await connected()
    host.refuse = 'document_purged'
    type(doc, ' one')
    await settle()
    type(doc, ' two')
    await settle()

    expect(host.sent).toHaveLength(1)
    expect(provider.readOnly).toBe('purged')
    lastChannel().onmessage(otherWindowFrame(' later'))
    expect(text(doc)).toBe('stored one two')
  })
})

describe('YjsIpcProvider failed edits', () => {
  it('sends again an edit the host failed to store, and what was typed after it', async () => {
    vi.useFakeTimers()
    const { doc } = await connected()
    host.refuse = 'storage_failed'
    host.refuseTimes = 1

    type(doc, ' x')
    await settle()
    type(doc, ' y')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(text(host.doc)).toBe('stored x y')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('sends again a sync step 2 the host failed to store', async () => {
    vi.useFakeTimers()
    host.refuse = 'storage_failed'
    host.refuseTimes = 1
    const doc = new Y.Doc()
    type(doc, 'offline ')
    await new YjsIpcProvider({ noteId: NOTE, doc }).connect()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(text(host.doc)).toBe(text(doc))
  })

  it('tells the user once when edits keep failing, and still sends them when the host recovers', async () => {
    vi.useFakeTimers()
    const { doc } = await connected()
    host.refuse = 'storage_failed'

    type(doc, ' x')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(
      "Your latest edits to this note couldn't be saved",
      expect.objectContaining({ description: expect.any(String) })
    )

    host.refuse = null
    await vi.advanceTimersByTimeAsync(10_000)
    expect(text(host.doc)).toBe('stored x')
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('gives up on a failing edit once the note is closed, and still closes it', async () => {
    vi.useFakeTimers()
    const { doc, provider } = await connected()
    host.refuse = 'storage_failed'
    type(doc, ' x')
    provider.destroy()

    await vi.advanceTimersByTimeAsync(30_000)

    expect(host.closes).toEqual([NOTE])
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})

describe('YjsIpcProvider rebinding', () => {
  it('reopens when the host says the window has not opened the note, carrying the edit', async () => {
    const { doc } = await connected()
    host.refuse = 'document_not_open'
    type(doc, ' typed')
    await settle(5)
    host.refuse = null
    await settle()

    expect(host.opens).toHaveLength(2)
    expect(host.sent.map((sent) => sent.command)).toEqual(['crdt_apply_update', 'crdt_sync_step_2'])
    expect(text(host.doc)).toBe('stored typed')
  })

  it('waits for the ready event after a reset, and carries edits made while unbound', async () => {
    const { doc, provider } = await connected()
    reset()
    expect(provider.isSynced).toBe(false)
    type(doc, ' offline')
    await settle()
    expect(host.sent).toEqual([])
    expect(host.opens).toHaveLength(1)

    ready()
    await settle()

    expect(host.opens).toHaveLength(2)
    expect(text(host.doc)).toBe('stored offline')
    expect(provider.isSynced).toBe(true)
  })

  it('hands canRebind the vault of the latest ready and holds the rebind while it says no', async () => {
    let allowed = false
    const seen: Array<string | null | undefined> = []
    const { provider } = await connected({
      canRebind: (vaultPath) => {
        seen.push(vaultPath)
        return allowed
      }
    })
    reset()
    ready('/other')
    await settle()
    expect(seen).toEqual(['/other'])
    expect(host.opens).toHaveLength(1)

    allowed = true
    provider.resumeRebind()
    await settle()
    expect(host.opens).toHaveLength(2)
  })

  it('does not reopen a live binding on a ready event', async () => {
    await connected()
    ready()
    await settle()
    expect(host.opens).toHaveLength(1)
  })
})

describe('YjsIpcProvider teardown', () => {
  it('closes the note, and a reopen of it waits for that close to land', async () => {
    const { provider } = await connected()
    let landed!: () => void
    host.closeGate = new Promise((resolve) => (landed = resolve))
    provider.destroy()

    const next = new YjsIpcProvider({ noteId: NOTE, doc: new Y.Doc() })
    const connecting = next.connect()
    await settle()
    expect(host.opens).toHaveLength(1)

    landed()
    await connecting
    expect(host.closes).toEqual([NOTE])
    expect(host.opens).toHaveLength(2)
  })

  it('sends the typing queued behind an edit in flight before it closes the note', async () => {
    const { doc, provider } = await connected()
    const land = holdEdits()
    type(doc, ' a')
    await settle()
    type(doc, ' b')
    provider.destroy()
    land()
    await settle(60)

    expect(text(host.doc)).toBe('stored a b')
    expect(host.calls).toEqual(['open', 'apply', 'apply', 'close'])
  })

  it('is flushed by a flush of every pending save, as a quit or a template apply runs', async () => {
    const { doc } = await connected()
    const land = holdEdits()
    type(doc, ' a')
    await settle()
    type(doc, ' b')
    let flushed = false
    const flushing = flushAllPendingSaves().then(() => (flushed = true))
    await settle()
    expect(flushed).toBe(false)

    land()
    await flushing
    expect(text(host.doc)).toBe('stored a b')
  })

  it('leaves the pending saves once its close landed', async () => {
    const { provider } = await connected()
    expect(hasPendingSaves()).toBe(true)
    const flush = vi.spyOn(provider, 'flush')
    provider.destroy()
    await settle()
    const teardownFlushes = flush.mock.calls.length

    await flushAllPendingSaves()
    expect(flush).toHaveBeenCalledTimes(teardownFlushes)
  })

  it('never opens once destroyed while it waited on an earlier close', async () => {
    const { provider } = await connected()
    let landed!: () => void
    host.closeGate = new Promise((resolve) => (landed = resolve))
    provider.destroy()
    const next = new YjsIpcProvider({ noteId: NOTE, doc: new Y.Doc() })
    void next.connect()
    await settle()
    next.destroy()
    landed()
    await settle(60)

    expect(host.opens).toHaveLength(1)
    expect(host.closes).toEqual([NOTE])
  })

  it('closes a note destroyed while its open is in flight only after the open lands', async () => {
    let answer!: () => void
    host.openGate = new Promise((resolve) => (answer = resolve))
    const provider = new YjsIpcProvider({ noteId: NOTE, doc: new Y.Doc() })
    const connecting = provider.connect()
    await settle()
    provider.destroy()
    await settle()
    answer()
    await connecting
    await settle(60)

    expect(host.calls).toEqual(['open', 'close'])
  })

  it('stops listening and sending once destroyed', async () => {
    const { doc, provider } = await connected()
    provider.destroy()

    lastChannel().onmessage(otherWindowFrame(' late'))
    type(doc, ' typed')
    ready()
    await settle()

    expect(text(doc)).toBe('stored typed')
    expect(host.sent).toEqual([])
    expect(host.resetListeners.size + host.readyListeners.size).toBe(0)
  })
})
