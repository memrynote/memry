import { describe, it, expect, vi, beforeEach } from 'vitest'

// See src/lib/ipc/invoke.test.ts for rationale — global setup-dom mock must
// step aside so this file can exercise the real forwarder module.
vi.unmock('@/lib/ipc/forwarder')
vi.unmock('./forwarder')

vi.mock('./invoke', () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => ({ cmd, args }))
}))
vi.mock('./events', () => ({
  listen: vi.fn(async () => vi.fn())
}))

import {
  camelToSnake,
  snakeToCamel,
  buildCommandName,
  packArgs,
  createInvokeForwarder,
  subscribeEvent
} from './forwarder'
import { invoke } from './invoke'
import { listen } from './events'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('camelToSnake', () => {
  it('converts simple camelCase', () => {
    expect(camelToSnake('listByFolder')).toBe('list_by_folder')
  })

  it('leaves already-snake unchanged', () => {
    expect(camelToSnake('create')).toBe('create')
  })

  it('handles acronyms as consecutive capitals', () => {
    expect(camelToSnake('getHTTPStatus')).toBe('get_h_t_t_p_status')
  })
})

describe('snakeToCamel', () => {
  it('converts snake to camel', () => {
    expect(snakeToCamel('list_by_folder')).toBe('listByFolder')
  })
})

describe('buildCommandName', () => {
  it('joins domain and snake-cased method', () => {
    expect(buildCommandName('notes', 'listByFolder')).toBe('notes_list_by_folder')
    expect(buildCommandName('sync', 'pushNow')).toBe('sync_push_now')
  })
})

describe('packArgs', () => {
  it('returns undefined for empty args', () => {
    expect(packArgs([])).toBeUndefined()
  })

  it('passes through a single plain-object arg unchanged', () => {
    const obj = { id: '1', name: 'x' }
    expect(packArgs([obj])).toBe(obj)
  })

  it('wraps a single scalar arg in { args: [value] }', () => {
    expect(packArgs(['note-1'])).toEqual({ args: ['note-1'] })
  })

  it('wraps a single array arg in { args: [array] }', () => {
    expect(packArgs([['a', 'b']])).toEqual({ args: [['a', 'b']] })
  })

  it('wraps multiple args in { args: [...positional] }', () => {
    expect(packArgs(['note-1', 'Renamed'])).toEqual({ args: ['note-1', 'Renamed'] })
  })
})

describe('createInvokeForwarder', () => {
  it('forwards methods as invoke(domain_method, packed)', async () => {
    // #given
    const svc = createInvokeForwarder<{ create: (input: { title: string }) => Promise<unknown> }>(
      'notes'
    )

    // #when
    await svc.create({ title: 'hello' })

    // #then
    expect(invoke).toHaveBeenCalledWith('notes_create', { title: 'hello' })
  })

  it('snake-cases camelCase method names', async () => {
    const svc = createInvokeForwarder<{ listByFolder: (id: string) => Promise<unknown> }>('notes')
    await svc.listByFolder('folder-1')
    expect(invoke).toHaveBeenCalledWith('notes_list_by_folder', { args: ['folder-1'] })
  })

  it('packs multiple positional args into { args: [...] }', async () => {
    const svc = createInvokeForwarder<{
      rename: (id: string, title: string) => Promise<unknown>
    }>('notes')
    await svc.rename('note-1', 'Renamed')
    expect(invoke).toHaveBeenCalledWith('notes_rename', { args: ['note-1', 'Renamed'] })
  })

  it('handles zero-arg methods', async () => {
    const svc = createInvokeForwarder<{ pushNow: () => Promise<unknown> }>('sync')
    await svc.pushNow()
    expect(invoke).toHaveBeenCalledWith('sync_push_now', undefined)
  })
})

describe('subscribeEvent', () => {
  it('registers listener and returns sync unsubscribe', async () => {
    // #given
    const unlisten = vi.fn()
    vi.mocked(listen).mockResolvedValueOnce(unlisten)
    const callback = vi.fn()

    // #when
    const cleanup = subscribeEvent('note-created', callback)

    // allow the listen promise to resolve
    await Promise.resolve()

    cleanup()

    // #then
    expect(listen).toHaveBeenCalledWith('note-created', callback)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('detaches immediately if cleanup runs before listen resolves', async () => {
    // #given
    const unlisten = vi.fn()
    let resolveListen: ((fn: typeof unlisten) => void) | undefined
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveListen = r
        })
    )
    const callback = vi.fn()

    // #when
    const cleanup = subscribeEvent('note-created', callback)
    cleanup()
    resolveListen?.(unlisten)
    await Promise.resolve()

    // #then
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
