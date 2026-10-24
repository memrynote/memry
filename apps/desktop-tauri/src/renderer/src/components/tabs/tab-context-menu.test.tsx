import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TabProvider, useTabs } from '@/contexts/tabs'
import type { SplitLayout, Tab, TabGroup, TabSystemState } from '@/contexts/tabs/types'
import { TabContextMenu } from './tab-context-menu'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      if (key.endsWith('splitDown')) return 'Split Down'
      if (key.endsWith('splitRight')) return 'Split Right'
      return key
    }
  })
}))

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: `tab-${Math.random().toString(36).slice(2, 8)}`,
  type: 'note',
  title: 'Test Note',
  icon: 'file-text',
  path: '/note/test',
  entityId: `entity-${Math.random().toString(36).slice(2, 8)}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: Date.now(),
  lastAccessedAt: Date.now(),
  ...overrides
})

const makeGroup = (tabs: Tab[]): TabGroup => ({
  id: `group-${Math.random().toString(36).slice(2, 8)}`,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  isActive: true,
  back: [],
  forward: []
})

const makeState = (groups: TabGroup[], layout?: SplitLayout): TabSystemState => {
  const tabGroups: Record<string, TabGroup> = {}
  groups.forEach((group) => {
    tabGroups[group.id] = group
  })
  return {
    tabGroups,
    layout: layout ?? { type: 'leaf', tabGroupId: groups[0].id },
    activeGroupId: groups[0].id,
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' }
  }
}

const Capture = ({ onState }: { onState: (state: TabSystemState) => void }): null => {
  const { state } = useTabs()
  onState(state)
  return null
}

describe('TabContextMenu', () => {
  it('creates a vertical split for Split Down', async () => {
    const firstTab = makeTab({ title: 'First' })
    const secondTab = makeTab({ title: 'Second' })
    const group = makeGroup([firstTab, secondTab])
    const initialState = makeState([group])
    let latestState = initialState

    ;(
      window as unknown as {
        api: {
          showContextMenu: ReturnType<typeof vi.fn>
          onSettingsChanged: ReturnType<typeof vi.fn>
        }
      }
    ).api = {
      showContextMenu: vi.fn().mockResolvedValue('split-down'),
      onSettingsChanged: vi.fn(() => vi.fn())
    }

    render(
      <TabProvider initialState={initialState}>
        <Capture onState={(state) => (latestState = state)} />
        <TabContextMenu tab={secondTab} groupId={group.id}>
          <button type="button">Second</button>
        </TabContextMenu>
      </TabProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Second' }))

    await waitFor(() => {
      expect(latestState.layout.type).toBe('split')
      if (latestState.layout.type !== 'split') throw new Error('expected a split layout')
      expect(latestState.layout.direction).toBe('vertical')
    })
  })

  it.each([
    ['pin', 'pins the right-clicked tab, not the active one', true],
    ['duplicate', 'duplicates the right-clicked tab with its view state', false]
  ])('%s: %s', async (choice, _name, isPin) => {
    const activeTab = makeTab({ title: 'Active' })
    const clickedTab = makeTab({ title: 'Clicked', viewState: { filter: 'done' } })
    const group = makeGroup([activeTab, clickedTab])
    const initialState = makeState([group])
    let latestState = initialState

    ;(window as unknown as { api: unknown }).api = {
      showContextMenu: vi.fn().mockResolvedValue(choice),
      onSettingsChanged: vi.fn(() => vi.fn())
    }

    render(
      <TabProvider initialState={initialState}>
        <Capture onState={(state) => (latestState = state)} />
        <TabContextMenu tab={clickedTab} groupId={group.id}>
          <button type="button">Clicked</button>
        </TabContextMenu>
      </TabProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Clicked' }))

    await waitFor(() => {
      const tabs = latestState.tabGroups[group.id].tabs
      if (isPin) {
        /* oxlint-disable vitest/no-conditional-expect -- platform-specific behavior: the contract differs per OS, so only the running OS's branch can be asserted */
        expect(tabs.find((tab) => tab.id === clickedTab.id)?.isPinned).toBe(true)
        expect(tabs.find((tab) => tab.id === activeTab.id)?.isPinned).toBe(false)
      } else {
        expect(tabs).toHaveLength(3)
        expect(tabs.filter((tab) => tab.entityId === clickedTab.entityId)).toHaveLength(2)
        expect(tabs.at(-1)?.viewState).toEqual({ filter: 'done' })
        /* oxlint-enable vitest/no-conditional-expect */
      }
    })
  })
})
