import { fireEvent, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { TabProvider, useTabs } from '@/contexts/tabs'
import type { Tab, TabGroup, TabSystemState } from '@/contexts/tabs/types'
import { useTabKeyboardShortcuts } from './use-tab-keyboard-shortcuts'

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

const makeState = (): TabSystemState => {
  const group = makeGroup([makeTab()])

  return {
    tabGroups: { [group.id]: group },
    layout: { type: 'leaf', tabGroupId: group.id },
    activeGroupId: group.id,
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' }
  }
}

const Harness = ({ onState }: { onState: (state: TabSystemState) => void }): null => {
  const { state } = useTabs()
  useTabKeyboardShortcuts()

  useEffect(() => {
    onState(state)
  }, [onState, state])

  return null
}

describe('useTabKeyboardShortcuts', () => {
  it('creates a horizontal split for Cmd+\\', async () => {
    const initialState = makeState()
    let latestState = initialState

    ;(
      window as unknown as {
        api: { onSettingsChanged: ReturnType<typeof vi.fn>; windowClose: ReturnType<typeof vi.fn> }
      }
    ).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    fireEvent.keyDown(window, { key: '\\', metaKey: true, ctrlKey: true })

    await waitFor(() => {
      expect(latestState.layout.type).toBe('split')
      if (latestState.layout.type === 'split') {
        expect(latestState.layout.direction).toBe('horizontal')
      }
    })
  })

  it('creates a vertical split for Cmd+Shift+\\', async () => {
    const initialState = makeState()
    let latestState = initialState

    ;(
      window as unknown as {
        api: { onSettingsChanged: ReturnType<typeof vi.fn>; windowClose: ReturnType<typeof vi.fn> }
      }
    ).api = {
      onSettingsChanged: vi.fn(() => vi.fn()),
      windowClose: vi.fn()
    }

    render(
      <TabProvider initialState={initialState}>
        <Harness onState={(state) => (latestState = state)} />
      </TabProvider>
    )

    fireEvent.keyDown(window, { key: '\\', metaKey: true, ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      expect(latestState.layout.type).toBe('split')
      if (latestState.layout.type === 'split') {
        expect(latestState.layout.direction).toBe('vertical')
      }
    })
  })
})
