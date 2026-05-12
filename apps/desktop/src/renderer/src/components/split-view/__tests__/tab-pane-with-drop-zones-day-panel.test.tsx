import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabPaneWithDropZones } from '../tab-pane-with-drop-zones'

const mocks = vi.hoisted(() => ({
  group: {
    id: 'g1',
    tabs: [
      {
        id: 'tab-1',
        type: 'note',
        title: 'Note',
        icon: 'file-text',
        path: '/note/test',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        openedAt: 1,
        lastAccessedAt: 1
      }
    ],
    activeTabId: 'tab-1',
    isActive: true,
    back: [],
    forward: []
  },
  dayPanel: {
    isOpen: true,
    width: 320,
    isResizing: false
  },
  tabBars: [] as Array<{ reserveDayPanelSpace?: boolean }>,
  dispatch: vi.fn()
}))

vi.mock('@dnd-kit/core', () => ({
  useDndMonitor: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ dispatch: mocks.dispatch }),
  useTabGroup: () => mocks.group
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => mocks.dayPanel
}))

vi.mock('@/components/tabs', () => ({
  TabBarWithDrag: (props: { reserveDayPanelSpace?: boolean }) => {
    mocks.tabBars.push(props)
    return <div data-testid="tab-bar" />
  }
}))

vi.mock('../tab-content', () => ({
  TabContent: () => <div data-testid="tab-content" />
}))

vi.mock('../empty-pane-state', () => ({
  EmptyPaneState: () => <div data-testid="empty-pane" />
}))

vi.mock('../split-preview', () => ({
  SplitPreview: () => null
}))

vi.mock('../split-drop-zones', () => ({
  SplitDropZones: () => null
}))

describe('TabPaneWithDropZones day panel spacing', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear()
    mocks.dayPanel.isOpen = true
    mocks.dayPanel.width = 320
    mocks.dayPanel.isResizing = false
    mocks.tabBars = []
  })

  it('reserves day panel width only when the pane is allowed to reserve it', () => {
    const { rerender } = render(<TabPaneWithDropZones groupId="g1" isActive reserveDayPanelSpace />)

    expect(screen.getByTestId('tab-content').parentElement).toHaveStyle({
      marginInlineEnd: '320px'
    })
    expect(mocks.tabBars[0]).toEqual(expect.objectContaining({ reserveDayPanelSpace: true }))

    rerender(<TabPaneWithDropZones groupId="g1" isActive reserveDayPanelSpace={false} />)

    expect(screen.getByTestId('tab-content').parentElement?.style.marginInlineEnd).not.toBe('320px')
    expect(mocks.tabBars[1]).toEqual(expect.objectContaining({ reserveDayPanelSpace: false }))
  })
})
