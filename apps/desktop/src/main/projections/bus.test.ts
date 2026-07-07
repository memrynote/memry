import { describe, it, expect } from 'vitest'

import { ProjectionBus } from './bus'
import type { ProjectionEvent } from './types'

const ev = (id: string) => ({ type: 'note.updated', itemId: id }) as unknown as ProjectionEvent

describe('ProjectionBus', () => {
  it('dequeues in FIFO order and tracks size', () => {
    // #given
    const bus = new ProjectionBus()
    expect(bus.size).toBe(0)

    // #when
    bus.enqueue(ev('a'))
    bus.enqueue(ev('b'))

    // #then
    expect(bus.size).toBe(2)
    expect(bus.dequeue()).toEqual(ev('a'))
    expect(bus.dequeue()).toEqual(ev('b'))
    expect(bus.size).toBe(0)
  })

  it('returns undefined when draining past empty', () => {
    const bus = new ProjectionBus()
    expect(bus.dequeue()).toBeUndefined()
  })

  it('clear() drops all pending events', () => {
    // #given
    const bus = new ProjectionBus()
    bus.enqueue(ev('a'))
    bus.enqueue(ev('b'))

    // #when
    bus.clear()

    // #then
    expect(bus.size).toBe(0)
    expect(bus.dequeue()).toBeUndefined()
  })
})
