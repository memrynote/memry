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
})
