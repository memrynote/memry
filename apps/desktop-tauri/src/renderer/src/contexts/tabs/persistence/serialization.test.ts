import { describe, it, expect } from 'vitest'
import { deserializeTabState, isRestorableTabType, serializeTabState } from './serialization'
import { STORAGE_VERSION } from './types'
import type { PersistedTabState } from './types'
import type { FeaturesSettings } from '@memry/contracts/settings-schemas'
import type { Tab, TabGroup, TabSystemState } from '../types'
import { generateId } from '../helpers'

const flags: FeaturesSettings = {
  home: false,
  inbox: false,
  journal: true,
  tasks: true,
  calendar: true,
  graph: true
}

describe('isRestorableTabType', () => {
  it('drops a disabled feature tab', () => {
    expect(isRestorableTabType('inbox', flags)).toBe(false)
  })
  it('keeps an enabled feature tab', () => {
    expect(isRestorableTabType('journal', flags)).toBe(true)
  })
  it('always keeps the home launcher even when home is off', () => {
    expect(isRestorableTabType('home', flags)).toBe(true)
  })
  it('keeps non-feature tabs (notes)', () => {
    expect(isRestorableTabType('note', flags)).toBe(true)
  })
})

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: generateId(),
  type: 'note',
  title: 'Test Note',
  icon: 'file-text',
  path: '/note/test',
  entityId: `entity-${generateId()}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: Date.now(),
  lastAccessedAt: Date.now(),
  ...overrides
})

const makeState = (tabs: Tab[]): TabSystemState => {
  const group: TabGroup = {
    id: 'g1',
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    isActive: true,
    back: [],
    forward: []
  }
  return {
    tabGroups: { g1: group },
    layout: { type: 'leaf', tabGroupId: 'g1' },
    activeGroupId: 'g1',
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
    recentlyClosed: []
  }
}

describe('serializeTabState', () => {
  it('never persists ephemeral virtual-note tabs (release notes) so they die with the session', () => {
    const note = makeTab({ title: 'Real note' })
    const releaseNotes = makeTab({
      type: 'virtual-note',
      title: 'MemryNote 2026.708.1',
      entityId: undefined,
      path: '/virtual/release-notes/2026.708.1',
      viewState: { content: '<h2>Fixes</h2>', contentType: 'html' }
    })

    const persisted = serializeTabState(makeState([note, releaseNotes]))
    const persistedTabs = persisted.tabGroups.g1?.tabs ?? []

    expect(persistedTabs.map((tab) => tab.type)).toEqual(['note'])
    expect(persistedTabs.some((tab) => tab.type === 'virtual-note')).toBe(false)
  })

  it('never persists the calendar anchor date or a create-event nonce', () => {
    // Both replayed on the next launch: Calendar opened on a day in August with
    // the event-creation dialog already up, on every start.
    const calendar = makeTab({
      type: 'calendar',
      entityId: undefined,
      viewState: {
        calendarView: 'day',
        calendarAnchorDate: '2026-08-08',
        createEventAt: 1_700_000_000_000
      }
    })

    const persisted = serializeTabState(makeState([calendar]))

    expect(persisted.tabGroups.g1?.tabs[0]?.viewState).toEqual({ calendarView: 'day' })
  })
})

describe('deserializeTabState', () => {
  const persistedWithViewState = (viewState: Record<string, unknown>): PersistedTabState => ({
    version: STORAGE_VERSION,
    tabGroups: {
      g1: {
        id: 'g1',
        activeTabId: 'tab-1',
        tabs: [
          {
            id: 'tab-1',
            type: 'calendar',
            title: 'Calendar',
            isPinned: false,
            viewState
          }
        ]
      }
    },
    layout: { type: 'leaf', tabGroupId: 'g1' },
    activeGroupId: 'g1',
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
    savedAt: Date.now()
  })

  it('strips transient keys written by an older build', () => {
    // Real users are sitting on session files that already contain these.
    const restored = deserializeTabState(
      persistedWithViewState({
        calendarView: 'day',
        calendarAnchorDate: '2026-08-08',
        createEventAt: 1_700_000_000_000
      })
    )

    expect(restored.tabGroups?.g1.tabs[0].viewState).toEqual({ calendarView: 'day' })
  })

  it('keeps the last view mode, which is a real preference', () => {
    const restored = deserializeTabState(persistedWithViewState({ calendarView: 'week' }))

    expect(restored.tabGroups?.g1.tabs[0].viewState).toEqual({ calendarView: 'week' })
  })
})
