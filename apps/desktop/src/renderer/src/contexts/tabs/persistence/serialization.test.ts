import { describe, it, expect } from 'vitest'
import { isRestorableTabType, serializeTabState } from './serialization'
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
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' }
  }
}

describe('serializeTabState', () => {
  it('never persists ephemeral virtual-note tabs (release notes) so they die with the session', () => {
    const note = makeTab({ title: 'Real note' })
    const releaseNotes = makeTab({
      type: 'virtual-note',
      title: 'memry note 2026.708.1',
      entityId: undefined,
      path: '/virtual/release-notes/2026.708.1',
      viewState: { content: '<h2>Fixes</h2>', contentType: 'html' }
    })

    const persisted = serializeTabState(makeState([note, releaseNotes]))
    const persistedTabs = persisted.tabGroups.g1?.tabs ?? []

    expect(persistedTabs.map((tab) => tab.type)).toEqual(['note'])
    expect(persistedTabs.some((tab) => tab.type === 'virtual-note')).toBe(false)
  })
})
