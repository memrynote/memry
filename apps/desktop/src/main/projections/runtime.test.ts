import { describe, expect, it, vi } from 'vitest'
import { createProjectionRuntime } from './runtime'
import type { ProjectionEvent, ProjectionProjector } from './types'

function markdownEvent(noteId: string, parsedContent: string): ProjectionEvent {
  return {
    type: 'note.upserted',
    note: {
      kind: 'markdown',
      noteId,
      path: `notes/${noteId}.md`,
      title: 'Note 1',
      fileType: 'markdown',
      localOnly: false,
      contentHash: 'hash',
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
  }
}

const noteEvent: ProjectionEvent = markdownEvent('note-1', 'test')

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

  it('drains each projector in publish order', async () => {
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

    expect(calls.filter((call) => call.startsWith('first:'))).toEqual([
      'first:note.upserted:note-1',
      'first:inbox.deleted:item-1'
    ])
    expect(calls.filter((call) => call.startsWith('second:'))).toEqual([
      'second:note.upserted:note-1',
      'second:inbox.deleted:item-1'
    ])
  })

  /**
   * Regression (#877): the embedding projector awaits a multi-second model load
   * inside project(). With one shared queue that stalled every other projector,
   * so note_cache kept a renamed note's old path and every read of it returned
   * null — the whole renderer saw a live note as deleted.
   */
  it('does not let a slow projector stall the other projectors', async () => {
    let releaseSlow: () => void = () => {}
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const slow = createProjector('slow', { project: vi.fn(async () => slowGate) })
    const fastCalls: string[] = []
    const fast = createProjector('fast', {
      project: vi.fn(async (event: ProjectionEvent) => {
        fastCalls.push(eventEntityId(event))
      })
    })
    const runtime = createProjectionRuntime({ projectors: [slow, fast] })

    runtime.publish(noteEvent)
    runtime.publish({ type: 'inbox.deleted', itemId: 'item-1' })

    // Let every already-schedulable task run, without releasing the slow projector.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fastCalls).toEqual(['note-1', 'item-1'])

    releaseSlow()
    await runtime.flush()
    expect(slow.project).toHaveBeenCalledTimes(2)
  })

  it('flush waits for every projector, including a slow one', async () => {
    const done: string[] = []
    const slow = createProjector('slow', {
      project: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        done.push('slow')
      })
    })
    const fast = createProjector('fast', {
      project: vi.fn(async () => {
        done.push('fast')
      })
    })
    const runtime = createProjectionRuntime({ projectors: [slow, fast] })

    runtime.publish(noteEvent)
    await runtime.flush()

    expect(done).toEqual(['fast', 'slow'])
    expect(runtime.getPendingCount()).toBe(0)
  })

  /**
   * #992: publish() used to push every event into all five lanes and only ask
   * handles() at drain time, so an inbox event sat in the note lanes (and a
   * note body sat in the inbox lane) until the slowest lane got to it.
   */
  it('queues an event only in the lanes whose projector handles it', () => {
    const noteLane = createProjector('note-lane', {
      handles: (event: ProjectionEvent) => event.type === 'note.upserted'
    })
    const inboxLane = createProjector('inbox-lane', {
      handles: (event: ProjectionEvent) => event.type.startsWith('inbox.')
    })
    // Freeze the lanes so the queues stay observable.
    const runtime = createProjectionRuntime({
      projectors: [noteLane, inboxLane],
      scheduleDrain: () => {}
    })

    runtime.publish(noteEvent)

    expect(runtime.getPendingCount()).toBe(1)
  })

  /**
   * #992: the embedding lane awaits a ~23MB model load plus per-note CPU
   * inference, so a stalled lane used to retain one full `parsedContent` per
   * queued event. Re-saving one note must not grow its backlog.
   */
  it('retains only the newest queued event per note while a lane is stalled', () => {
    const runtime = createProjectionRuntime({
      projectors: [createProjector('slow')],
      scheduleDrain: () => {}
    })

    for (let i = 0; i < 10_000; i++) {
      runtime.publish(markdownEvent('note-1', `body ${i}`))
    }

    expect(runtime.getPendingCount()).toBe(1)
  })

  it('bounds a stalled lane queue and reports the dropped events', async () => {
    const logger = { warn: vi.fn() }
    const runtime = createProjectionRuntime({
      projectors: [createProjector('slow')],
      scheduleDrain: () => {},
      queueLimit: 100,
      logger
    })

    for (let i = 0; i < 10_000; i++) {
      runtime.publish(markdownEvent(`note-${i}`, 'body'))
    }

    expect(runtime.getPendingCount()).toBe(100)

    await runtime.flush()
    expect(logger.warn).toHaveBeenCalledWith(
      'Projection queue overflow — dropped pending events',
      expect.objectContaining({ projector: 'slow', dropped: 9900, limit: 100 })
    )
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
