import { describe, expect, it, vi } from 'vitest'
import { createProjectionRuntime, isReconcileFailure } from './runtime'
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
    background: overrides.background,
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

  /**
   * #992: the cap drops the oldest pending events, so the lane's output is now
   * missing whatever they carried — a dropped `note.upserted` in the search lane
   * means that note is absent from search. Nothing else calls reconcile() on this
   * path, so overflow must pay for itself with a deferred repair rather than
   * leaving a quietly wrong projection.
   */
  it('reconciles a lane once after an overflowed queue drains', async () => {
    const slow = createProjector('slow', { reconcile: vi.fn() })
    const runtime = createProjectionRuntime({
      projectors: [slow],
      scheduleDrain: () => {},
      queueLimit: 2
    })

    for (let i = 0; i < 10; i++) {
      runtime.publish(markdownEvent(`note-${i}`, 'body'))
    }
    await runtime.flush()

    expect(slow.reconcile).toHaveBeenCalledOnce()

    // A later burst that never overflows must not pay for another repair.
    runtime.publish(markdownEvent('note-later', 'body'))
    await runtime.flush()

    expect(slow.reconcile).toHaveBeenCalledOnce()
  })

  it('does not let an event published by the overflow repair trigger another repair', async () => {
    // A repair that writes through the bus must not re-arm itself. Publishing is
    // capped so that a runtime which never clears the flag fails the assertion
    // below instead of spinning forever.
    let echoes = 0
    const slow = createProjector('slow', {
      reconcile: vi.fn(() => {
        if (echoes >= 3) {
          return
        }
        echoes++
        runtime.publish(markdownEvent(`echo-${echoes}`, 'body'))
      })
    })
    const runtime = createProjectionRuntime({
      projectors: [slow],
      scheduleDrain: () => {},
      queueLimit: 2
    })

    for (let i = 0; i < 10; i++) {
      runtime.publish(markdownEvent(`note-${i}`, 'body'))
    }
    await runtime.flush()

    expect(slow.reconcile).toHaveBeenCalledOnce()
    expect(echoes).toBe(1)
  })

  it('logs a failed overflow repair and retries it on the next drain', async () => {
    const logger = { warn: vi.fn() }
    const slow = createProjector('slow', {
      reconcile: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const runtime = createProjectionRuntime({
      projectors: [slow],
      scheduleDrain: () => {},
      queueLimit: 2,
      logger
    })

    for (let i = 0; i < 10; i++) {
      runtime.publish(markdownEvent(`note-${i}`, 'body'))
    }
    await runtime.flush()

    expect(slow.reconcile).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      'Projection overflow repair failed',
      expect.objectContaining({ projector: 'slow' })
    )

    // The lane is not wedged and the repair is still owed, so the next drain retries.
    runtime.publish(markdownEvent('note-later', 'body'))
    await runtime.flush()

    expect(slow.reconcile).toHaveBeenCalledTimes(2)
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

  it('keeps reconciling the other projectors after one of them throws', async () => {
    // #given the search projector's position in the real list: one before the
    // three that self-repair embeddings, inbox counts and note↔project links
    const failure = new Error('fts_notes is corrupt')
    const first = createProjector('noteDerivedState', { reconcile: vi.fn() })
    const broken = createProjector('search', {
      reconcile: vi.fn(() => Promise.reject(failure))
    })
    const third = createProjector('embedding', { reconcile: vi.fn() })
    const fourth = createProjector('inboxStats', { reconcile: vi.fn() })
    const logger = { error: vi.fn(), warn: vi.fn() }
    const runtime = createProjectionRuntime({
      projectors: [first, broken, third, fourth],
      logger
    })

    // #when the second projector throws — the pass used to abandon everything
    // behind it, silently, on every launch
    const results = await runtime.reconcile()

    // #then every sibling still ran
    expect(first.reconcile).toHaveBeenCalledOnce()
    expect(third.reconcile).toHaveBeenCalledOnce()
    expect(fourth.reconcile).toHaveBeenCalledOnce()

    // #then the failure is recorded rather than swallowed, so the caller can
    // report it and repair what it points at
    expect(isReconcileFailure(results.search)).toBe(true)
    expect(results.search).toMatchObject({ projector: 'search', error: failure })
    expect(isReconcileFailure(results.embedding)).toBe(false)
    expect(logger.error).toHaveBeenCalledWith(
      'Projection reconcile failed',
      expect.objectContaining({ projector: 'search', error: failure })
    )
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

  /**
   * A pass that polls its signal between steps, so an abort that never arrives
   * shows up as work continuing after stop() resolved.
   */
  function createReconcileTracker(steps = 40, stepMs = 20) {
    const state = { inFlight: 0, completed: 0, steps: 0 }

    const reconcile = async (signal?: AbortSignal): Promise<void> => {
      state.inFlight += 1
      try {
        for (let i = 0; i < steps; i++) {
          if (signal?.aborted) {
            return
          }
          state.steps += 1
          await new Promise((resolve) => setTimeout(resolve, stepMs))
        }
        state.completed += 1
      } finally {
        state.inFlight -= 1
      }
    }

    return { state, reconcile }
  }

  /**
   * #1083's post-reindex embedding drain (`reconcileProjections(['embedding'])`)
   * can fire while `openVault`'s backgrounded full pass is still running, so two
   * reconciles overlap. The runtime kept a single controller/promise pair and
   * the second call overwrote both, leaving the first pass with a signal nobody
   * held: stop() aborted and awaited only the newest pass, and the older one
   * kept reading the vault the caller was already closing (#803/#805 stall
   * class).
   */
  it('stop aborts every outstanding reconcile pass, not just the newest', async () => {
    const { state, reconcile } = createReconcileTracker()
    const runtime = createProjectionRuntime({
      projectors: [createProjector('search', { reconcile })]
    })

    const first = runtime.reconcile()
    const second = runtime.reconcile(['search'])
    await new Promise((resolve) => setTimeout(resolve, 30))

    await runtime.stop()

    // Nothing may still be inside reconcile() when stop() resolves: the caller
    // closes the databases on the next line.
    expect(state.inFlight).toBe(0)
    expect(state.completed).toBe(0)

    // And no pass may resume afterwards.
    const stepsAtStop = state.steps
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(state.steps).toBe(stepsAtStop)

    await Promise.all([first, second])
  })

  it('stop stays bounded with two reconcile passes outstanding', async () => {
    // 40 steps x 20ms = 800ms per pass if nothing aborts it.
    const { state, reconcile } = createReconcileTracker()
    const runtime = createProjectionRuntime({
      projectors: [createProjector('search', { reconcile })]
    })

    const first = runtime.reconcile()
    const second = runtime.reconcile(['search'])
    await new Promise((resolve) => setTimeout(resolve, 30))

    const startedAt = Date.now()
    await runtime.stop()
    const elapsed = Date.now() - startedAt

    // Prompt: `closeVault()` awaits stop(), and 800ms of unaborted repair per
    // pass must not be on that path.
    expect(elapsed).toBeLessThan(400)
    expect(state.steps).toBeLessThan(10)
    // Prompt *and* complete — returning early while a pass keeps reading the
    // vault is what made the old stall silent.
    expect(state.inFlight).toBe(0)

    await Promise.all([first, second])
  })

  it('runs overlapping reconcile passes one at a time', async () => {
    const { state, reconcile } = createReconcileTracker(2, 10)
    const peak = { inFlight: 0 }
    const runtime = createProjectionRuntime({
      projectors: [
        createProjector('search', {
          reconcile: async (signal?: AbortSignal) => {
            const pass = reconcile(signal)
            peak.inFlight = Math.max(peak.inFlight, state.inFlight)
            await pass
          }
        })
      ]
    })

    await Promise.all([runtime.reconcile(), runtime.reconcile(['search'])])

    // Both repairs still run — serializing must not coalesce one away.
    expect(state.completed).toBe(2)
    expect(peak.inFlight).toBe(1)
  })

  it('keeps queuing passes after one fails, and no-ops a pass requested after stop', async () => {
    const seen: string[] = []
    const runtime = createProjectionRuntime({
      projectors: [
        createProjector('search', {
          reconcile: vi.fn(async () => {
            seen.push('pass')
            if (seen.length === 1) {
              throw new Error('reconcile exploded')
            }
          })
        })
      ]
    })

    const failing = runtime.reconcile()
    const next = runtime.reconcile()

    // The pass records the failure instead of rejecting: projectors are
    // isolated from each other, so one throwing no longer ends the pass.
    expect(isReconcileFailure((await failing).search)).toBe(true)
    await next
    expect(seen).toHaveLength(2)

    await runtime.stop()

    // The databases are closed by now, so a late caller must not reach a
    // projector.
    await runtime.reconcile()
    expect(seen).toHaveLength(2)
  })

  it('loses no projection events while reconcile passes are outstanding', async () => {
    const projected: string[] = []
    const { reconcile } = createReconcileTracker()
    const runtime = createProjectionRuntime({
      projectors: [
        createProjector('search', {
          reconcile,
          project: async (event: ProjectionEvent) => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            projected.push(eventEntityId(event))
          }
        })
      ]
    })

    const first = runtime.reconcile()
    const second = runtime.reconcile(['search'])

    const ids = ['note-a', 'note-b', 'note-c']
    for (const id of ids) {
      runtime.publish(markdownEvent(id, id))
    }

    await runtime.stop()

    expect(projected).toEqual(ids)

    await Promise.all([first, second])
  })

  /**
   * #1078: `flushProjectionEvents()` waited for *every* lane, and the indexer
   * awaits it once per file. That put the embedding lane's model load plus
   * per-note inference in front of every file the 8-worker pool touched.
   */
  it('flush does not wait for a background lane', async () => {
    let releaseBackground: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseBackground = resolve
    })
    const embedded: string[] = []
    const embedding = createProjector('embedding', {
      background: true,
      project: vi.fn(async (event: ProjectionEvent) => {
        await gate
        embedded.push(eventEntityId(event))
      })
    })
    const search = createProjector('search', { project: vi.fn() })
    const runtime = createProjectionRuntime({ projectors: [embedding, search] })

    runtime.publish(markdownEvent('note-1', 'body'))
    runtime.publish(markdownEvent('note-2', 'body'))

    await runtime.flush()

    expect(search.project).toHaveBeenCalledTimes(2)
    expect(embedded).toEqual([])

    // The barrier is lifted, not the work: the lane still holds both events, in
    // publish order, and stop({ drain: true }) still drains it.
    releaseBackground()
    await runtime.stop({ drain: true })

    expect(embedded).toEqual(['note-1', 'note-2'])
  })

  /**
   * #1078: publish() kept accepting events for the whole stop drain, so anything
   * still emitting refilled a lane as fast as it emptied and drain()'s wait loop
   * never settled — closeVault() hung behind it.
   */
  it('refuses events published during stop so a refilled lane cannot keep the drain alive', async () => {
    const logger = { warn: vi.fn() }
    let projected = 0
    const echoing = createProjector('echoing', {
      project: vi.fn(async () => {
        projected++
        // Yield to the macrotask queue so a regression here surfaces as a test
        // timeout rather than starving the event loop outright.
        await new Promise((resolve) => setTimeout(resolve, 0))
        runtime.publish(markdownEvent(`echo-${projected}`, 'body'))
      })
    })
    const runtime = createProjectionRuntime({
      projectors: [echoing],
      scheduleDrain: () => {},
      logger
    })

    runtime.publish(markdownEvent('note-1', 'body'))
    await runtime.stop({ drain: true })

    expect(projected).toBe(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'Projection event published after runtime stop',
      expect.anything()
    )
  })

  /**
   * #1078: closeVault() awaits stopProjectionRuntime({ drain: true }), so an
   * unbounded drain made a vault switch wait out the whole backlog.
   */
  it('stops a long backlog at the drain deadline and still finishes the in-flight event', async () => {
    const logger = { warn: vi.fn() }
    const started: string[] = []
    const finished: string[] = []
    const slow = createProjector('slow', {
      project: vi.fn(async (event: ProjectionEvent) => {
        started.push(eventEntityId(event))
        await new Promise((resolve) => setTimeout(resolve, 30))
        finished.push(eventEntityId(event))
      })
    })
    const runtime = createProjectionRuntime({ projectors: [slow], logger })

    for (let i = 0; i < 50; i++) {
      runtime.publish(markdownEvent(`note-${i}`, 'body'))
    }

    const startedAt = Date.now()
    await runtime.stop({ drain: true, drainTimeoutMs: 40 })

    // Draining all 50 would take ~1.5s; the deadline plus the one in-flight
    // event is ~70ms.
    expect(Date.now() - startedAt).toBeLessThan(600)
    expect(started.length).toBeLessThan(50)
    // Cut short, never abandoned: everything that entered project() came back
    // out before stop() resolved and the caller closed the databases.
    expect(finished).toEqual(started)
    expect(logger.warn).toHaveBeenCalledWith(
      'Projection stop drain timed out — cutting the backlog short',
      expect.objectContaining({ timeoutMs: 40 })
    )
  })

  it('waits for the event already inside a projector even when the drain is skipped', async () => {
    let started = false
    let finished = false
    const slow = createProjector('slow', {
      project: vi.fn(async () => {
        started = true
        await new Promise((resolve) => setTimeout(resolve, 30))
        finished = true
      })
    })
    const runtime = createProjectionRuntime({ projectors: [slow] })

    runtime.publish(noteEvent)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toBe(true)

    await runtime.stop({ drain: false })

    expect(finished).toBe(true)
  })
})
