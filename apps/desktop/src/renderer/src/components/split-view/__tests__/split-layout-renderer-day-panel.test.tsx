import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SplitLayout, TabGroup, TabSystemState } from '@/contexts/tabs/types'
import { SplitLayoutRenderer } from '../split-layout-renderer'

interface CapturedPaneProps {
  groupId: string
  reserveDayPanelSpace?: boolean
}

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  panes: [] as CapturedPaneProps[],
  state: null as TabSystemState | null
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    state: mocks.state,
    dispatch: mocks.dispatch
  })
}))

vi.mock('../tab-pane-with-drop-zones', () => ({
  TabPaneWithDropZones: (props: CapturedPaneProps) => {
    mocks.panes.push(props)
    return <div data-testid={`pane-${props.groupId}`} />
  }
}))

vi.mock('../split-pane', () => ({
  SplitPane: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const makeGroup = (id: string): TabGroup => ({
  id,
  tabs: [],
  activeTabId: null,
  isActive: false,
  back: [],
  forward: []
})

const makeState = (layout: SplitLayout): TabSystemState => ({
  tabGroups: {
    g1: makeGroup('g1'),
    g2: makeGroup('g2'),
    g3: makeGroup('g3')
  },
  layout,
  activeGroupId: 'g1',
  settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' }
})

describe('SplitLayoutRenderer day panel spacing', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear()
    mocks.panes = []
  })

  it('does not reserve fixed day panel space inside the left pane of a horizontal split', () => {
    const layout: SplitLayout = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    }
    mocks.state = makeState(layout)

    render(<SplitLayoutRenderer layout={layout} path={[]} />)

    expect(mocks.panes).toEqual([
      expect.objectContaining({ groupId: 'g1', reserveDayPanelSpace: false }),
      expect.objectContaining({ groupId: 'g2', reserveDayPanelSpace: true })
    ])
  })

  it('reserves fixed day panel space for both rows in a vertical split', () => {
    const layout: SplitLayout = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    }
    mocks.state = makeState(layout)

    render(<SplitLayoutRenderer layout={layout} path={[]} />)

    expect(mocks.panes).toEqual([
      expect.objectContaining({ groupId: 'g1', reserveDayPanelSpace: true }),
      expect.objectContaining({ groupId: 'g2', reserveDayPanelSpace: true })
    ])
  })

  it('only reserves space for leaves that still touch the outer inline-end edge', () => {
    const layout: SplitLayout = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g2' },
        second: { type: 'leaf', tabGroupId: 'g3' }
      }
    }
    mocks.state = makeState(layout)

    render(<SplitLayoutRenderer layout={layout} path={[]} />)

    expect(mocks.panes).toEqual([
      expect.objectContaining({ groupId: 'g1', reserveDayPanelSpace: false }),
      expect.objectContaining({ groupId: 'g2', reserveDayPanelSpace: true }),
      expect.objectContaining({ groupId: 'g3', reserveDayPanelSpace: true })
    ])
  })
})
