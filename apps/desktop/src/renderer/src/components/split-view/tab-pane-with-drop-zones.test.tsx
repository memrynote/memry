import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabPaneWithDropZones } from './tab-pane-with-drop-zones'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  monitor: null as null | {
    onDragStart: (event: any) => void
    onDragOver: (event: any) => void
    onDragEnd: (event: any) => void
    onDragCancel: () => void
  },
  groups: new Map<string, any>(),
  dayPanel: {
    isOpen: false,
    width: 320,
    isResizing: false
  }
}))

vi.mock('@dnd-kit/core', () => ({
  useDndMonitor: (handlers: NonNullable<typeof mocks.monitor>) => {
    mocks.monitor = handlers
  }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ dispatch: mocks.dispatch }),
  useTabGroup: (groupId: string) => mocks.groups.get(groupId)
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => mocks.dayPanel
}))

vi.mock('@/components/tabs', () => ({
  TabBarWithDrag: ({ groupId }: { groupId: string }) => <div>tab bar {groupId}</div>
}))

vi.mock('./tab-content', () => ({
  TabContent: ({ tab }: { tab: { title: string } }) => <div>tab content {tab.title}</div>
}))

vi.mock('./empty-pane-state', () => ({
  EmptyPaneState: ({ groupId }: { groupId: string }) => <div>empty pane {groupId}</div>
}))

vi.mock('./split-drop-zones', () => ({
  SplitDropZones: ({ isActive }: { isActive: boolean }) => (
    <div>drop zones {isActive ? 'active' : 'inactive'}</div>
  )
}))

vi.mock('./split-preview', () => ({
  SplitPreview: ({ zone }: { zone: string | null }) => <div>preview {zone ?? 'none'}</div>
}))

describe('TabPaneWithDropZones', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.monitor = null
    mocks.groups = new Map([
      [
        'main',
        {
          id: 'main',
          tabs: [
            { id: 'tab-1', type: 'note', title: 'One' },
            { id: 'tab-2', type: 'note', title: 'Two' }
          ],
          activeTabId: 'tab-1'
        }
      ]
    ])
    mocks.dayPanel = {
      isOpen: false,
      width: 320,
      isResizing: false
    }
  })

  it('renders null for unknown groups and focuses inactive panes on click', () => {
    mocks.groups = new Map()
    const { container, rerender } = render(<TabPaneWithDropZones groupId="missing" isActive />)
    expect(container).toBeEmptyDOMElement()

    mocks.groups = new Map([
      [
        'main',
        {
          id: 'main',
          tabs: [{ id: 'tab-1', type: 'note', title: 'One' }],
          activeTabId: 'tab-1'
        }
      ]
    ])
    rerender(<TabPaneWithDropZones groupId="main" isActive={false} />)
    fireEvent.click(screen.getByText('tab content One').closest('[data-pane-id="main"]')!)
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'SET_ACTIVE_GROUP',
      payload: { groupId: 'main' }
    })
  })

  it('renders active content, empty panes, and day-panel margin state', () => {
    mocks.dayPanel = { isOpen: true, width: 280, isResizing: false }
    const { rerender } = render(<TabPaneWithDropZones groupId="main" isActive />)

    expect(screen.getByText('tab bar main')).toBeInTheDocument()
    expect(screen.getByText('tab content One')).toBeInTheDocument()
    expect(screen.getByText('tab content One').parentElement).toHaveStyle({
      marginInlineEnd: '280px'
    })

    mocks.groups.set('main', {
      id: 'main',
      tabs: [],
      activeTabId: null
    })
    rerender(<TabPaneWithDropZones groupId="main" isActive />)
    expect(screen.getByText('empty pane main')).toBeInTheDocument()
  })

  it('tracks tab drag monitor state and dispatches split and center drops', () => {
    render(<TabPaneWithDropZones groupId="main" isActive />)

    act(() => {
      mocks.monitor?.onDragStart({
        active: { id: 'tab-2', data: { current: { type: 'tab', groupId: 'source' } } }
      })
    })
    expect(screen.getByText('drop zones active')).toBeInTheDocument()

    act(() => {
      mocks.monitor?.onDragOver({
        over: { data: { current: { type: 'split-zone', zone: 'right', groupId: 'main' } } }
      })
    })
    expect(screen.getByText('preview right')).toBeInTheDocument()

    act(() => {
      mocks.monitor?.onDragEnd({
        over: { data: { current: { type: 'split-zone', zone: 'bottom', groupId: 'main' } } }
      })
    })
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'MOVE_TAB_TO_NEW_SPLIT',
      payload: {
        tabId: 'tab-2',
        fromGroupId: 'source',
        targetGroupId: 'main',
        direction: 'down',
        position: 'second'
      }
    })
    expect(screen.getByText('drop zones inactive')).toBeInTheDocument()

    act(() => {
      mocks.monitor?.onDragStart({
        active: { id: 'tab-1', data: { current: { type: 'tab', groupId: 'source' } } }
      })
    })
    act(() => {
      mocks.monitor?.onDragEnd({
        over: { data: { current: { type: 'split-zone', zone: 'center', groupId: 'main' } } }
      })
    })
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'MOVE_TAB',
      payload: {
        tabId: 'tab-1',
        fromGroupId: 'source',
        toGroupId: 'main',
        toIndex: 2
      }
    })
  })

  it('ignores unrelated drags, out-of-pane hover, same-group center drops, and cancel resets', () => {
    render(<TabPaneWithDropZones groupId="main" isActive />)

    act(() => {
      mocks.monitor?.onDragStart({
        active: { id: 'note-1', data: { current: { type: 'note' } } }
      })
      mocks.monitor?.onDragOver({
        over: { data: { current: { type: 'split-zone', zone: 'left', groupId: 'other' } } }
      })
    })
    expect(screen.getByText('drop zones inactive')).toBeInTheDocument()
    expect(screen.getByText('preview none')).toBeInTheDocument()

    act(() => {
      mocks.monitor?.onDragStart({
        active: { id: 'tab-1', data: { current: { type: 'tab', groupId: 'main' } } }
      })
      mocks.monitor?.onDragEnd({
        over: { data: { current: { type: 'split-zone', zone: 'center', groupId: 'main' } } }
      })
    })
    expect(mocks.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'MOVE_TAB' }))

    act(() => {
      mocks.monitor?.onDragStart({
        active: { id: 'tab-1', data: { current: { type: 'tab', groupId: 'source' } } }
      })
      mocks.monitor?.onDragCancel()
    })
    expect(screen.getByText('drop zones inactive')).toBeInTheDocument()
  })
})
