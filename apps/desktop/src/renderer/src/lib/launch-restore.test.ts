import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, tabStateStorageKey } from '@/contexts/tabs/persistence'
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

const noteTabStateFor = (noteId: string, savedAt: number): PersistedTabState =>
  noteTabState({
    savedAt,
    tabGroups: {
      'group-1': {
        id: 'group-1',
        activeTabId: 'tab-1',
        tabs: [
          {
            id: 'tab-1',
            type: 'note',
            title: noteId,
            icon: 'file-text',
            path: `/notes/${noteId}`,
            entityId: noteId,
            isPinned: false
          }
        ]
      }
    }
  })

const VAULT_A = '/Users/me/Vault A'
const VAULT_B = '/Users/me/Vault B'

const launchInto = (vaultPath: string | null): void => {
  vi.mocked(window.api.vault.getStartupPath).mockReturnValue(vaultPath)
}

const seedVault = (vaultPath: string, state: PersistedTabState): void => {
  localStorage.setItem(tabStateStorageKey(vaultPath), JSON.stringify(state))
}

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
  launchInto(VAULT_A)
  prefetchPageModuleMock.mockClear()
  trackNoteReadableMock.mockClear()
})

afterEach(() => {
  localStorage.clear()
  vi.mocked(window.api.vault.getStartupPath).mockReturnValue(null)
})

describe('readRestoredActiveTab', () => {
  it('returns null when storage is empty', async () => {
    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })

  it("reads the launching vault's tabs even when another vault saved more recently", async () => {
    // #2066: switch to B, quit before B's tab state flushes, so A's is newer.
    seedVault(VAULT_A, noteTabStateFor('note-a', 200))
    seedVault(VAULT_B, noteTabStateFor('note-b', 100))
    launchInto(VAULT_B)

    const { readRestoredActiveTab, LAUNCH_NOTE_ID } = await loadModule()
    expect(readRestoredActiveTab()).toEqual({ type: 'note', entityId: 'note-b' })
    expect(LAUNCH_NOTE_ID).toBe('note-b')
  })

  it('returns null when the window opened on the vault picker', async () => {
    seedVault(VAULT_A, noteTabState())
    launchInto(null)

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })

  it('falls back to the legacy global key the launching vault will adopt', async () => {
    seedVault(VAULT_B, noteTabStateFor('note-b', 100))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(noteTabState()))

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toEqual({ type: 'note', entityId: 'note-1' })
  })

  it("returns null when the launching vault's entry is malformed JSON", async () => {
    localStorage.setItem(tabStateStorageKey(VAULT_A), '{not json')

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })

  it('returns null when the entry has no activeGroupId', async () => {
    const { activeGroupId: _drop, ...withoutActiveGroupId } = noteTabState()
    localStorage.setItem(tabStateStorageKey(VAULT_A), JSON.stringify(withoutActiveGroupId))

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })

  it('returns null when the active group has no active tab id', async () => {
    seedVault(
      VAULT_A,
      noteTabState({
        tabGroups: { 'group-1': { id: 'group-1', activeTabId: null, tabs: [] } }
      })
    )

    const { readRestoredActiveTab } = await loadModule()
    expect(readRestoredActiveTab()).toBeNull()
  })
})

describe('prefetchRestoredTabPage', () => {
  it('prefetches the page module keyed by the restored tab type', async () => {
    seedVault(VAULT_A, noteTabState())
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
    seedVault(VAULT_A, noteTabState())
    const { markLaunchNoteReadable, NOTE_READABLE_MARK, LAUNCH_NOTE_ID } = await loadModule()
    expect(LAUNCH_NOTE_ID).toBe('note-1')

    const markSpy = vi.spyOn(performance, 'mark')

    markLaunchNoteReadable('note-1')

    expect(markSpy).toHaveBeenCalledExactlyOnceWith(NOTE_READABLE_MARK)
    expect(trackNoteReadableMock).toHaveBeenCalledTimes(1)

    markSpy.mockRestore()
  })

  it('is idempotent — a second call for the same note is a no-op', async () => {
    seedVault(VAULT_A, noteTabState())
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
    seedVault(VAULT_A, noteTabState())
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
