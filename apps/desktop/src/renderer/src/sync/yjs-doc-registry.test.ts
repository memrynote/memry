import { describe, it, expect, vi } from 'vitest'
import { createYjsDocRegistry } from './yjs-doc-registry'

function makeRegistry() {
  const destroy = vi.fn()
  let created = 0
  const registry = createYjsDocRegistry((noteId: string) => {
    created++
    return { noteId, destroy: () => destroy(noteId) }
  })
  return { registry, destroy, created: () => created }
}

describe('yjs-doc-registry', () => {
  it('creates one entry per noteId and shares it across consumers (refCount)', () => {
    const { registry, created } = makeRegistry()
    const a = Symbol('a')
    const b = Symbol('b')
    const e1 = registry.acquire('note-1', a)
    const e2 = registry.acquire('note-1', b)
    expect(e1).toBe(e2)
    expect(created()).toBe(1)
    expect(registry.refCount('note-1')).toBe(2)
  })

  it('destroys the entry only when the last consumer releases (parity with today)', () => {
    const { registry, destroy } = makeRegistry()
    const a = Symbol('a')
    registry.acquire('note-1', a)
    registry.release('note-1', a)
    expect(destroy).toHaveBeenCalledWith('note-1')
    expect(registry.refCount('note-1')).toBe(0)
  })

  it('does not destroy while a sibling consumer is still live (teardown bug fix)', () => {
    const { registry, destroy } = makeRegistry()
    const a = Symbol('a')
    const b = Symbol('b')
    registry.acquire('note-1', a)
    registry.acquire('note-1', b)
    registry.release('note-1', a)
    expect(destroy).not.toHaveBeenCalled()
    registry.release('note-1', b)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('assigns side-effect ownership to the first consumer and promotes on owner release', () => {
    const { registry } = makeRegistry()
    const a = Symbol('a')
    const b = Symbol('b')
    registry.acquire('note-1', a)
    registry.acquire('note-1', b)
    expect(registry.isSideEffectOwner('note-1', a)).toBe(true)
    expect(registry.isSideEffectOwner('note-1', b)).toBe(false)
    registry.release('note-1', a)
    expect(registry.isSideEffectOwner('note-1', b)).toBe(true)
  })

  it('notifies the newly-promoted consumer via onOwnerChange(true) on owner release', () => {
    const { registry } = makeRegistry()
    const a = Symbol('a')
    const b = Symbol('b')
    const onOwnerChangeA = vi.fn()
    const onOwnerChangeB = vi.fn()
    registry.acquire('note-1', a, onOwnerChangeA)
    registry.acquire('note-1', b, onOwnerChangeB)
    registry.release('note-1', a)
    expect(onOwnerChangeB).toHaveBeenCalledWith(true)
    expect(onOwnerChangeA).not.toHaveBeenCalledWith(true)
    expect(registry.isSideEffectOwner('note-1', b)).toBe(true)
  })

  it('keeps separate entries for different noteIds', () => {
    const { registry, created } = makeRegistry()
    registry.acquire('note-1', Symbol('a'))
    registry.acquire('note-2', Symbol('b'))
    expect(created()).toBe(2)
    expect(registry.refCount('note-1')).toBe(1)
    expect(registry.refCount('note-2')).toBe(1)
  })

  it('keeps refCount exact through interleaved acquire/release churn', () => {
    const destroy = vi.fn()
    const registry = createYjsDocRegistry(() => ({ destroy }))
    const consumers = Array.from({ length: 6 }, () => Symbol('consumer'))

    consumers.forEach((c) => registry.acquire('n1', c))
    expect(registry.refCount('n1')).toBe(6)

    // Release out of acquisition order, interleaved with a re-acquire.
    registry.release('n1', consumers[3])
    registry.release('n1', consumers[0])
    const late = Symbol('late')
    registry.acquire('n1', late)
    registry.release('n1', consumers[5])
    expect(registry.refCount('n1')).toBe(4)
    expect(destroy).not.toHaveBeenCalled()
    ;[consumers[1], consumers[2], consumers[4], late].forEach((c) => registry.release('n1', c))
    expect(registry.refCount('n1')).toBe(0)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('promotes ownership to a still-live consumer on each owner release', () => {
    const registry = createYjsDocRegistry(() => ({ destroy: vi.fn() }))
    const a = Symbol('a')
    const b = Symbol('b')
    const c = Symbol('c')
    registry.acquire('n1', a)
    registry.acquire('n1', b)
    registry.acquire('n1', c)
    expect(registry.isSideEffectOwner('n1', a)).toBe(true)

    registry.release('n1', a)
    const ownersAfterFirst = [b, c].filter((s) => registry.isSideEffectOwner('n1', s))
    expect(ownersAfterFirst).toHaveLength(1)

    registry.release('n1', ownersAfterFirst[0])
    const remaining = [b, c].filter(
      (s) => registry.refCount('n1') > 0 && registry.isSideEffectOwner('n1', s)
    )
    expect(remaining).toHaveLength(1)
  })

  it('survives a duplicate release without going negative or double-destroying', () => {
    const destroy = vi.fn()
    const registry = createYjsDocRegistry(() => ({ destroy }))
    const a = Symbol('a')
    registry.acquire('n1', a)
    registry.release('n1', a)
    registry.release('n1', a)
    expect(registry.refCount('n1')).toBe(0)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('re-creates a fresh entry after full teardown (no stale slot leak)', () => {
    const createEntry = vi.fn(() => ({ destroy: vi.fn() }))
    const registry = createYjsDocRegistry(createEntry)
    const a = Symbol('a')
    registry.acquire('n1', a)
    registry.release('n1', a)
    registry.acquire('n1', Symbol('b'))
    expect(createEntry).toHaveBeenCalledTimes(2)
    expect(registry.refCount('n1')).toBe(1)
  })

  it('refCount===1 stays byte-identical to the pre-registry path', () => {
    const destroy = vi.fn()
    const createEntry = vi.fn(() => ({ destroy }))
    const registry = createYjsDocRegistry(createEntry)
    const only = Symbol('only')
    registry.acquire('n1', only)
    expect(createEntry).toHaveBeenCalledTimes(1)
    expect(registry.isSideEffectOwner('n1', only)).toBe(true)
    registry.release('n1', only)
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
