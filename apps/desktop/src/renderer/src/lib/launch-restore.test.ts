import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY } from '@/contexts/tabs/persistence'
import type { PersistedTabState } from '@/contexts/tabs/persistence'

// Renderer tests never clear localStorage between files (no global afterEach
// does it), so this suite clears it itself in both beforeEach and afterEach —
// otherwise a fixture written here would leak into whatever runs next.

const { prefetchPageModuleMock, trackNoteReadableMock } = vi.hoisted(() => ({
  prefetchPageModuleMock: vi.fn(),
  trackNoteReadableMock: vi.fn()
}))

vi.mock('@/components/split-view/tab-content', () => ({
  prefetchPageModule: prefetchPageModuleMock
}))

vi.mock('./telemetry-diagnostics', () => ({
  trackNoteReadable: trackNoteReadableMock
}))

const noteTabState = (overrides: Partial<PersistedTabState> = {}): PersistedTabState => ({
  version: 2,
  tabGroups: {
    'group-1': {
      id: 'group-1',
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          type: 'note',
          title: 'Note',
          icon: 'file-text',
          path: '/notes/note-1',
          entityId: 'note-1',
          isPinned: false
        }
      ]
    }
  },
  layout: { type: 'leaf', tabGroupId: 'group-1' },
  activeGroupId: 'group-1',
  settings: {} as PersistedTabState['settings'],
  savedAt: 1000,
  ...overrides
})

// `launch-restore.ts` computes `LAUNCH_NOTE_ID` and reads `restoredTab` as a
// module-scope side effect at import time, so a scenario that depends on
// either one needs a fresh module instance loaded after localStorage is
// seeded — a plain re-import would just return the already-evaluated module.
const loadModule = async () => {
  vi.resetModules()
  return import('./launch-restore')
}

beforeEach(() => {
  localStorage.clear()
  prefetchPageModuleMock.mockClear()
  trackNoteReadableMock.mockClear()
})

afterEach(() => {
  localStorage.clear()
})

describe('readRestoredActiveTab', () => {
  it('returns null when storage is empty', async () => {
    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })

  it('picks the entry with the largest savedAt across multiple vault-scoped keys', async () => {
    localStorage.setItem(`${STORAGE_KEY}:vault-a`, JSON.stringify(noteTabState({ savedAt: 100 })))
    localStorage.setItem(
      `${STORAGE_KEY}:vault-b`,
      JSON.stringify(
        noteTabState({
          savedAt: 200,
          tabGroups: {
            'group-1': {
              id: 'group-1',
              activeTabId: 'tab-2',
              tabs: [
                {
                  id: 'tab-2',
                  type: 'note',
                  title: 'B',
                  icon: 'file-text',
                  path: '/notes/note-2',
                  entityId: 'note-2',
                  isPinned: false
                }
              ]
            }
          }
        })
      )
    )

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toEqual({ type: 'note', entityId: 'note-2' })
  })

  it('falls back to the legacy global key when it is the only entry', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(noteTabState()))

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toEqual({ type: 'note', entityId: 'note-1' })
  })

  it('skips a malformed JSON entry and still finds a valid one', async () => {
    localStorage.setItem(`${STORAGE_KEY}:broken`, '{not json')
    localStorage.setItem(`${STORAGE_KEY}:vault-a`, JSON.stringify(noteTabState()))

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toEqual({ type: 'note', entityId: 'note-1' })
  })

  it('returns null when the newest entry has no activeGroupId', async () => {
    const { activeGroupId: _drop, ...withoutActiveGroupId } = noteTabState()
    localStorage.setItem(`${STORAGE_KEY}:vault-a`, JSON.stringify(withoutActiveGroupId))

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })

  it('returns null when the active group has no active tab id', async () => {
    localStorage.setItem(
      `${STORAGE_KEY}:vault-a`,
      JSON.stringify(
        noteTabState({
          tabGroups: { 'group-1': { id: 'group-1', activeTabId: null, tabs: [] } }
        })
      )
    )

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })

  it('ignores keys that do not start with the tab-state prefix', async () => {
    localStorage.setItem('unrelated-key', JSON.stringify(noteTabState()))

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })
})

describe('prefetchRestoredTabPage', () => {
  it('prefetches the page module keyed by the restored tab type', async () => {
    localStorage.setItem(`${STORAGE_KEY}:vault-a`, JSON.stringify(noteTabState()))
    const { prefetchRestoredTabPage } = await loadModule()

    prefetchRestoredTabPage()
    expect(prefetchPageModuleMock).toHaveBeenCalledExactlyOnceWith('note')
  })

  it('no-ops when nothing was restored', async () => {
    const { prefetchRestoredTabPage } = await loadModule()

    prefetchRestoredTabPage()
    expect(prefetchPageModuleMock).not.toHaveBeenCalled()
  })
})

describe('markLaunchNoteReadable', () => {
  it('marks performance and tracks telemetry once for the note the launch restored', async () => {
    localStorage.setItem(`${STORAGE_KEY}:vault-a`, JSON.stringify(noteTabState()))
    const { markLaunchNoteReadable, NOTE_READABLE_MARK, LAUNCH_NOTE_ID } = await loadModule()
    expect(LAUNCH_NOTE_ID).toBe('note-1')

    const markSpy = vi.spyOn(performance, 'mark')

    markLaunchNoteReadable('note-1')

    expect(markSpy).toHaveBeenCalledExactlyOnceWith(NOTE_READABLE_MARK)
    expect(trackNoteReadableMock).toHaveBeenCalledTimes(1)

    markSpy.mockRestore()
  })

  it('is idempotent — a second call for the same note is a no-op', async () => {
    localStorage.setItem(`${STORAGE_KEY}:vault-a`, JSON.stringify(noteTabState()))
    const { markLaunchNoteReadable } = await loadModule()

    const markSpy = vi.spyOn(performance, 'mark')

    markLaunchNoteReadable('note-1')
    markSpy.mockClear()
    trackNoteReadableMock.mockClear()

    markLaunchNoteReadable('note-1')

    expect(markSpy).not.toHaveBeenCalled()
    expect(trackNoteReadableMock).not.toHaveBeenCalled()

    markSpy.mockRestore()
  })

  it('ignores a note id that does not match the launch-restored note', async () => {
    localStorage.setItem(`${STORAGE_KEY}:vault-a`, JSON.stringify(noteTabState()))
    const { markLaunchNoteReadable } = await loadModule()

    const markSpy = vi.spyOn(performance, 'mark')
    markLaunchNoteReadable('some-other-note')

    expect(markSpy).not.toHaveBeenCalled()
    expect(trackNoteReadableMock).not.toHaveBeenCalled()

    markSpy.mockRestore()
  })

  it('no-ops when the launch restored no note at all', async () => {
    const { markLaunchNoteReadable, LAUNCH_NOTE_ID } = await loadModule()
    expect(LAUNCH_NOTE_ID).toBeNull()

    const markSpy = vi.spyOn(performance, 'mark')
    markLaunchNoteReadable('note-1')

    expect(markSpy).not.toHaveBeenCalled()
    expect(trackNoteReadableMock).not.toHaveBeenCalled()

    markSpy.mockRestore()
  })
})
