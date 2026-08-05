import { describe, it, expect, vi } from 'vitest'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { NoteUpdatedEvent } from '@memry/contracts/notes-api'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { emitNoteUpdated } from './note-events'

describe('emitNoteUpdated', () => {
  it('emits on the notes:updated channel', () => {
    const emit = vi.fn()

    emitNoteUpdated(emit, { id: 'note-1', changes: { title: 'Hi' }, source: 'sync' })

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toBe(NotesChannels.events.UPDATED)
    // Channel name is part of the renderer contract, not an implementation
    // detail: the preload subscribes by literal string.
    expect(emit.mock.calls[0][0]).toBe('notes:updated')
  })

  it('forwards the exact event object it was given, by reference', () => {
    const emit = vi.fn()
    const event: NoteUpdatedEvent = {
      id: 'note-1',
      changes: { title: 'Hi', emoji: '📝' },
      source: 'internal'
    }

    emitNoteUpdated(emit, event)

    // No copying, no normalisation, no key filtering — the payload the caller
    // constructed is exactly what the renderer receives.
    expect(emit.mock.calls[0][1]).toBe(event)
  })

  it('carries `changes` for every payload shape the sync path emits', () => {
    const emit = vi.fn()

    // crdt-writeback.ts: a remote body edit landing on this device.
    emitNoteUpdated(emit, {
      id: 'note-1',
      changes: { content: '# Remote edit' },
      source: 'sync'
    })
    // note-handler.ts binary branch: sidecar metadata only, never file bytes.
    emitNoteUpdated(emit, {
      id: 'note-2',
      changes: { title: 'Scan', emoji: '📎' },
      source: 'sync'
    })
    // note-handler.ts markdown branch: frontmatter/title/path, never the body.
    emitNoteUpdated(emit, {
      id: 'note-3',
      changes: { title: 'Notes', emoji: null, tags: ['a', 'b'] },
      source: 'sync'
    })

    for (const [, payload] of emit.mock.calls) {
      const event = payload as NoteUpdatedEvent
      // `use-notes-query.ts` reads `event.changes.content` without guarding for
      // every note that is not the open one, so an emit that omits `changes`
      // throws once per pulled note and the subscriber misses the event.
      expect(event.changes).toBeDefined()
      expect(typeof event.changes).toBe('object')
    }

    expect(emit.mock.calls[0][1]).toEqual({
      id: 'note-1',
      changes: { content: '# Remote edit' },
      source: 'sync'
    })
    expect(emit.mock.calls[1][1]).toEqual({
      id: 'note-2',
      changes: { title: 'Scan', emoji: '📎' },
      source: 'sync'
    })
    expect(emit.mock.calls[2][1]).toEqual({
      id: 'note-3',
      changes: { title: 'Notes', emoji: null, tags: ['a', 'b'] },
      source: 'sync'
    })
  })

  it('preserves `source: sync` so the subscriber can tell a pull from a local edit', () => {
    const emit = vi.fn()

    emitNoteUpdated(emit, { id: 'note-1', changes: { content: 'remote' }, source: 'sync' })

    expect((emit.mock.calls[0][1] as NoteUpdatedEvent).source).toBe('sync')
  })

  it('does NOT suppress sync-sourced events — echo suppression is the subscriber’s job', () => {
    const emit = vi.fn()

    // Read the source before changing this expectation: `emitNoteUpdated` is an
    // unconditional passthrough. It holds no loop guard of its own; a change
    // that arrived FROM sync is still emitted outward, tagged `source: 'sync'`,
    // and it is the renderer subscriber that must not write it back. The loop
    // is broken by the tag, not by dropping the emit.
    emitNoteUpdated(emit, { id: 'note-1', changes: { content: 'remote' }, source: 'sync' })
    emitNoteUpdated(emit, { id: 'note-1', changes: { content: 'local' }, source: 'internal' })
    emitNoteUpdated(emit, { id: 'note-1', changes: { content: 'watcher' }, source: 'external' })

    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit.mock.calls.map(([, payload]) => (payload as NoteUpdatedEvent).source)).toEqual([
      'sync',
      'internal',
      'external'
    ])
  })

  it('emits once per call and never fans out to a second channel', () => {
    const emit = vi.fn()

    emitNoteUpdated(emit, { id: 'note-1', changes: { title: 'A' }, source: 'sync' })
    emitNoteUpdated(emit, { id: 'note-2', changes: { title: 'B' }, source: 'sync' })

    expect(emit).toHaveBeenCalledTimes(2)
    expect(new Set(emit.mock.calls.map(([channel]) => channel))).toEqual(
      new Set([NotesChannels.events.UPDATED])
    )
  })

  it('does not swallow an emitter that throws', () => {
    const emit = vi.fn(() => {
      throw new Error('destroyed window')
    })

    expect(() =>
      emitNoteUpdated(emit, { id: 'note-1', changes: { title: 'A' }, source: 'sync' })
    ).toThrow('destroyed window')
  })

  it('performs no runtime validation — `changes` is enforced by the type, not a check', () => {
    const emit = vi.fn()
    // Documents the real guarantee: the helper exists so the payload is
    // typechecked at the call site. A caller that defeats the type (e.g. a
    // payload built from `unknown` and cast) still reaches the renderer as-is.
    const malformed = { id: 'note-1', source: 'sync' } as unknown as NoteUpdatedEvent

    emitNoteUpdated(emit, malformed)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][1]).toBe(malformed)
    expect((emit.mock.calls[0][1] as NoteUpdatedEvent).changes).toBeUndefined()
  })
})
