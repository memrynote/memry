import { describe, expect, it, vi } from 'vitest'
import { createProjectionRuntime } from './runtime'
import type { ProjectionEvent, ProjectionProjector } from './types'

const noteEvent: ProjectionEvent = {
  type: 'note.upserted',
  note: {
    kind: 'markdown',
    noteId: 'note-1',
    path: 'notes/note-1.md',
    title: 'Note 1',
    fileType: 'markdown',
    localOnly: false,
    contentHash: 'hash',
    wordCount: 1,
    characterCount: 4,
    snippet: 'test',
    date: null,
    emoji: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    parsedContent: 'test',
    tags: [],
    properties: {},
    wikiLinks: []
  }
}

function createProjector(
  name: string,
  overrides: Partial<ProjectionProjector> = {}
): ProjectionProjector {
  return {
    name,
    handles: overrides.handles ?? (() => true),
    project: overrides.project ?? vi.fn(),
    rebuild: overrides.rebuild ?? vi.fn(),
    reconcile: overrides.reconcile ?? vi.fn()
  }
}

function eventEntityId(event: ProjectionEvent): string {
  switch (event.type) {
    case 'note.upserted':
      return event.note.noteId
    case 'note.deleted':
      return event.noteId
    case 'task.upserted':
    case 'task.deleted':
      return event.taskId
    default:
      return event.itemId
  }
}

describe('projection runtime', () => {
  it('fans out an event to every matching projector', async () => {
    const first = createProjector('first', { project: vi.fn() })
    const second = createProjector('second', { project: vi.fn() })
    const runtime = createProjectionRuntime({ projectors: [first, second] })

    runtime.publish(noteEvent)
    await runtime.flush()

    expect(first.project).toHaveBeenCalledWith(noteEvent)
    expect(second.project).toHaveBeenCalledWith(noteEvent)
  })

  it('isolates projector failures so later projectors still run', async () => {
    const logger = { error: vi.fn() }
    const failing = createProjector('failing', {
      project: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const healthy = createProjector('healthy', { project: vi.fn() })
    const runtime = createProjectionRuntime({
      projectors: [failing, healthy],
      logger
    })

    runtime.publish(noteEvent)
    await runtime.flush()

    expect(healthy.project).toHaveBeenCalledWith(noteEvent)
    expect(logger.error).toHaveBeenCalledWith(
      'Projection projector failed',
      expect.objectContaining({ projector: 'failing' })
    )
  })

  it('drains events in publish order and projector order', async () => {
    const calls: string[] = []
    const first = createProjector('first', {
      project: vi.fn(async (event: ProjectionEvent) => {
        calls.push(`first:${event.type}:${eventEntityId(event)}`)
      })
    })
    const second = createProjector('second', {
      project: vi.fn(async (event: ProjectionEvent) => {
        calls.push(`second:${event.type}:${eventEntityId(event)}`)
      })
    })
    const runtime = createProjectionRuntime({ projectors: [first, second] })

    runtime.publish(noteEvent)
    runtime.publish({ type: 'inbox.deleted', itemId: 'item-1' })
    await runtime.flush()

    expect(calls).toEqual([
      'first:note.upserted:note-1',
      'second:note.upserted:note-1',
      'first:inbox.deleted:item-1',
      'second:inbox.deleted:item-1'
    ])
  })

  it('dispatches rebuild and reconcile to selected projectors', async () => {
    const first = createProjector('first', { rebuild: vi.fn(), reconcile: vi.fn() })
    const second = createProjector('second', { rebuild: vi.fn(), reconcile: vi.fn() })
    const runtime = createProjectionRuntime({ projectors: [first, second] })

    await runtime.rebuild(['second'])
    await runtime.reconcile()

    expect(first.rebuild).not.toHaveBeenCalled()
    expect(second.rebuild).toHaveBeenCalledOnce()
    expect(first.reconcile).toHaveBeenCalledOnce()
    expect(second.reconcile).toHaveBeenCalledOnce()
  })
})
