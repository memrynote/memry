import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushProjectionEvents,
  getProjectionRuntime,
  publishProjectionEvent,
  startProjectionRuntime,
  stopProjectionRuntime
} from './index'
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

function createProjector(name: string): ProjectionProjector {
  return {
    name,
    handles: () => true,
    project: vi.fn(),
    rebuild: vi.fn(),
    reconcile: vi.fn()
  }
}

describe('projection runtime lifecycle', () => {
  afterEach(async () => {
    await stopProjectionRuntime({ drain: false })
  })

  /**
   * Regression (#1024): a failed vault open leaves `isOpen` false, so the next
   * `selectVault` skips `closeVault()` — and its drained `stopProjectionRuntime`
   * — while the previous runtime is still live. `startProjectionRuntime` used to
   * return that runtime and drop the new projectors on the floor, so the new
   * vault's notes were indexed/embedded through projectors closed over the
   * PREVIOUS vault path.
   */
  it('restarts with the new projectors when a runtime is already running', async () => {
    const stale = createProjector('stale')
    const fresh = createProjector('fresh')

    startProjectionRuntime([stale])
    const runtime = startProjectionRuntime([fresh])

    publishProjectionEvent(noteEvent)
    await flushProjectionEvents()

    expect(fresh.project).toHaveBeenCalledWith(noteEvent)
    expect(stale.project).not.toHaveBeenCalled()
    expect(getProjectionRuntime()).toBe(runtime)
  })

  it('stops the superseded runtime so its projectors can no longer write', async () => {
    const stale = createProjector('stale')
    const staleRuntime = startProjectionRuntime([stale])

    startProjectionRuntime([createProjector('fresh')])

    staleRuntime.publish(noteEvent)
    await staleRuntime.flush()

    expect(stale.project).not.toHaveBeenCalled()
  })

  /**
   * The queued events belong to the PREVIOUS vault, and by the time
   * `startProjectionRuntime` runs again the new vault's databases are already
   * installed — replaying them would write the old vault's derived state into
   * the new vault's index. They are dropped instead; reopening that vault
   * re-indexes and reconciles from its files, which are the source of truth.
   */
  it('drops events still queued on the superseded runtime', async () => {
    const stale = createProjector('stale')
    startProjectionRuntime([stale])
    publishProjectionEvent(noteEvent)

    const fresh = createProjector('fresh')
    startProjectionRuntime([fresh])

    await flushProjectionEvents()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(stale.project).not.toHaveBeenCalled()
    expect(fresh.project).not.toHaveBeenCalled()
  })

  it('always leaves a live runtime installed after a restart', async () => {
    startProjectionRuntime([createProjector('stale')])
    const fresh = createProjector('fresh')
    startProjectionRuntime([fresh])

    publishProjectionEvent(noteEvent)
    await flushProjectionEvents()

    expect(getProjectionRuntime()).not.toBeNull()
    expect(fresh.project).toHaveBeenCalledOnce()
  })
})
