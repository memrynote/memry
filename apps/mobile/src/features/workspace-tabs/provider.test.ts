import { describe, expect, it } from 'vitest'
import { WorkspaceTabsStore } from './provider'
import type { WorkspaceTabsState } from './model'
import type { WorkspaceTabsStorage } from './storage'

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('WorkspaceTabsStore', () => {
  it('merges a registration made during hydration and saves the merge last', async () => {
    const pending = deferred<WorkspaceTabsState>()
    const saves: WorkspaceTabsState[] = []
    const storage: WorkspaceTabsStorage = {
      load: () => pending.promise,
      save: async (next) => {
        saves.push(next)
      }
    }
    const store = new WorkspaceTabsStore(storage)
    const hydration = store.hydrate()

    store.register({ id: 'current', title: 'Live title' })
    pending.resolve({
      activeTabId: 'stored-current',
      tabs: [
        {
          id: 'stored-current',
          destination: { kind: 'note', noteId: 'current' },
          title: 'Stale title',
          openedAt: 1,
          lastAccessedAt: Number.MAX_SAFE_INTEGER
        },
        {
          id: 'note:persisted',
          destination: { kind: 'note', noteId: 'persisted' },
          title: 'Persisted',
          openedAt: 2,
          lastAccessedAt: 2
        }
      ]
    })

    await hydration
    await store.flush()
    expect(store.getSnapshot().tabs.map((tab) => [tab.destination.noteId, tab.title])).toEqual([
      ['persisted', 'Persisted'],
      ['current', 'Live title']
    ])
    expect(store.getSnapshot().activeTabId).toBe('note:current')
    expect(saves.at(-1)).toEqual(store.getSnapshot())
  })

  it('does not restore a tab closed while hydration is pending', async () => {
    const pending = deferred<WorkspaceTabsState>()
    const storage: WorkspaceTabsStorage = {
      load: () => pending.promise,
      save: async () => undefined
    }
    const store = new WorkspaceTabsStore(storage)
    const hydration = store.hydrate()

    store.register({ id: 'current', title: 'Current' })
    store.close('note:current')
    pending.resolve({
      activeTabId: 'note:current',
      tabs: [
        {
          id: 'note:current',
          destination: { kind: 'note', noteId: 'current' },
          title: 'Stale current',
          openedAt: 1,
          lastAccessedAt: 1
        }
      ]
    })

    await hydration
    expect(store.getSnapshot()).toEqual({ tabs: [], activeTabId: null })
  })

  it('does nothing when the already-active tab is activated', () => {
    const navigated: (string | null)[] = []
    const store = new WorkspaceTabsStore(null)
    store.setNavigate((noteId) => navigated.push(noteId))
    store.register({ id: 'current', title: 'Current' })
    const before = store.getSnapshot()

    store.activate('note:current')

    expect(store.getSnapshot()).toBe(before)
    expect(navigated).toEqual([])
  })

  it('pushes when a note is opened and replaces when tabs are switched or closed', () => {
    const navigated: [string | null, string][] = []
    const store = new WorkspaceTabsStore(null)
    store.setNavigate((noteId, mode) => navigated.push([noteId, mode]))

    store.open({ id: 'a', title: 'A' })
    store.open({ id: 'b', title: 'B' })
    store.activate('note:a')
    store.close('note:a')

    expect(navigated).toEqual([
      ['a', 'push'],
      ['b', 'push'],
      ['a', 'replace'],
      ['b', 'replace']
    ])
  })
})
