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

  it('stop aborts an in-flight reconcile and waits for it to unwind', async () => {
    const steps: number[] = []
    let unwound = false

    // Each step parks on a timer, so the pass can only have unwound by the time
    // stop() resolves if stop() actually awaited it — draining microtasks is
    // not enough.
    const slow = createProjector('slow', {
      reconcile: async (signal?: AbortSignal) => {
        for (let i = 0; i < 5; i++) {
          if (signal?.aborted) {
            break
          }
          steps.push(i)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        unwound = true
      }
    })
    const runtime = createProjectionRuntime({ projectors: [slow] })

    const reconcilePromise = runtime.reconcile()
    await Promise.resolve()
    expect(steps).toEqual([0])

    await runtime.stop()

    // stop() must not resolve while the old pass can still touch the vault...
    expect(unwound).toBe(true)
    // ...and the pass must have been cut short rather than run to completion.
    expect(steps).toEqual([0])

    await reconcilePromise
  })
})
