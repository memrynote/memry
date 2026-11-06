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
  /** Edits wait on this before they land, so a test can hold one in flight. */
  gate: null as Promise<void> | null,
  closeGate: null as Promise<void> | null,
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
      if (host.refuse) {
        // oxlint-disable-next-line typescript/only-throw-error -- Tauri rejects a command with its serialized `CommandError`, a plain object
        throw { kind: 'invalid', code: host.refuse, message: host.refuse }
      }
      Yjs.applyUpdate(host.doc, update, 'window')
      return null
    })
  }
})

vi.mock('../../../generated/bindings', () => ({
  commands: {
    crdtCloseDoc: async (noteId: string) => {
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

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

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
  host.gate = null
  host.closeGate = null
  host.resetListeners.clear()
  host.readyListeners.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

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

  it('stops sending once the host answers document_purged', async () => {
    const { doc } = await connected()
    host.refuse = 'document_purged'
    type(doc, ' one')
    await settle()
    type(doc, ' two')
    await settle()

    expect(host.sent).toHaveLength(1)
    lastChannel().onmessage(otherWindowFrame(' later'))
    expect(text(doc)).toBe('stored one two')
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
