import { describe, it, expect } from 'vitest'

import { ProjectionBus } from './bus'
import type { ProjectionEvent } from './types'

const ev = (id: string) => ({ type: 'note.updated', itemId: id }) as unknown as ProjectionEvent

const upsert = (noteId: string, parsedContent: string): ProjectionEvent => ({
  type: 'note.upserted',
  note: {
    kind: 'markdown',
    noteId,
    path: `notes/${noteId}.md`,
    title: noteId,
    fileType: 'markdown',
    localOnly: false,
    contentHash: parsedContent,
    wordCount: 1,
    characterCount: parsedContent.length,
    snippet: parsedContent,
    date: null,
    emoji: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    parsedContent,
    tags: [],
    properties: {},
    wikiLinks: []
  }
})

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

  /**
   * #992: a stalled lane used to hold one copy of every note body it had ever
   * been handed. Re-saving one note must not grow the queue.
   */
  it('coalesces newest-wins per entity, in place', () => {
    // #given
    const bus = new ProjectionBus()
    bus.enqueue(upsert('a', 'v1'))
    bus.enqueue(upsert('b', 'v1'))

    // #when
    bus.enqueue(upsert('a', 'v2'))

    // #then
    expect(bus.size).toBe(2)
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'a', parsedContent: 'v2' } })
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'b', parsedContent: 'v1' } })
  })

  it('never coalesces across event types for the same entity', () => {
    // #given
    const bus = new ProjectionBus()
    bus.enqueue(upsert('a', 'v1'))
    bus.enqueue({ type: 'note.deleted', noteId: 'a' })

    // #when
    bus.enqueue(upsert('a', 'v2'))

    // #then — coalescing must never reorder the delete after the newer upsert
    expect(bus.size).toBe(3)
    expect(bus.dequeue()).toMatchObject({ type: 'note.upserted', note: { parsedContent: 'v1' } })
    expect(bus.dequeue()).toMatchObject({ type: 'note.deleted' })
    expect(bus.dequeue()).toMatchObject({ type: 'note.upserted', note: { parsedContent: 'v2' } })
  })

  it('does not coalesce into an already dequeued event', () => {
    // #given
    const bus = new ProjectionBus()
    bus.enqueue(upsert('a', 'v1'))
    bus.enqueue(upsert('b', 'v1'))
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'a', parsedContent: 'v1' } })

    // #when
    bus.enqueue(upsert('a', 'v2'))

    // #then
    expect(bus.size).toBe(2)
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'b' } })
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'a', parsedContent: 'v2' } })
  })

  it('drops the oldest event once the queue limit is reached', () => {
    // #given
    const bus = new ProjectionBus(3)

    // #when
    for (let i = 0; i < 1000; i++) {
      bus.enqueue(upsert(`note-${i}`, 'body'))
    }

    // #then
    expect(bus.size).toBe(3)
    expect(bus.takeDroppedCount()).toBe(997)
    expect(bus.takeDroppedCount()).toBe(0)
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'note-997' } })
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'note-998' } })
    expect(bus.dequeue()).toMatchObject({ note: { noteId: 'note-999' } })
  })
})
