import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DropZone } from './drop-zone'
import { getDropZoneLabel } from './drop-zone-label'
import { EmptyPaneState } from './empty-pane-state'
import { applyLayoutPreset, layoutPresets } from './layout-presets'
import { SplitPreview } from './split-preview'

const mocks = vi.hoisted(() => ({
  isOver: false,
  openTab: vi.fn(),
  dispatch: vi.fn(),
  tabGroups: { main: {}, side: {} } as Record<string, unknown>
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: vi.fn(() => ({ isOver: mocks.isOver, setNodeRef: vi.fn() }))
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    openTab: mocks.openTab,
    dispatch: mocks.dispatch,
    state: { tabGroups: mocks.tabGroups }
  })
}))

describe('split-view small surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isOver = false
    mocks.tabGroups = { main: {}, side: {} }
  })

  it('labels and renders active drop zones', () => {
    expect(getDropZoneLabel('left')).toBe('Split Left')
    expect(getDropZoneLabel('right')).toBe('Split Right')
    expect(getDropZoneLabel('top')).toBe('Split Up')
    expect(getDropZoneLabel('bottom')).toBe('Split Down')
    expect(getDropZoneLabel('center')).toBe('Move Here')

    mocks.isOver = true
    render(<DropZone zone="left" groupId="main" className="absolute inset-0" />)
    expect(screen.getByText('Split Left')).toBeInTheDocument()
  })

  it('renders split previews for edge zones only', () => {
    const { container, rerender } = render(<SplitPreview zone={null} />)
    expect(container).toBeEmptyDOMElement()

    rerender(<SplitPreview zone="center" />)
    expect(container).toBeEmptyDOMElement()

    rerender(<SplitPreview zone="bottom" />)
    expect(container.firstElementChild).toHaveStyle({ bottom: '0px', height: '50%' })
  })

  it('opens inbox and closes empty panes when multiple groups exist', () => {
    render(<EmptyPaneState groupId="side" />)

    fireEvent.click(screen.getByText('phaseF.componentsSplitViewEmptyPaneState.openInbox'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox', title: 'Inbox' }),
      { groupId: 'side' }
    )

    fireEvent.click(screen.getByText('phaseF.componentsSplitViewEmptyPaneState.closePane'))
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'CLOSE_SPLIT',
      payload: { groupId: 'side' }
    })
  })

  it('applies every layout preset using existing tabs', () => {
    const state = {
      tabGroups: {
        main: {
          id: 'main',
          tabs: [
            { id: 'a', type: 'note', title: 'A' },
            { id: 'b', type: 'note', title: 'B' },
            { id: 'c', type: 'note', title: 'C' },
            { id: 'd', type: 'note', title: 'D' }
          ],
          activeTabId: 'a',
          isActive: true,
          back: [],
          forward: []
        }
      },
      layout: { type: 'leaf', tabGroupId: 'main' },
      activeGroupId: 'main',
      tabOrder: ['a', 'b', 'c', 'd']
    } as any

    expect(layoutPresets.map((preset) => preset.id)).toContain('grid-2x2')
    for (const preset of layoutPresets) {
      const next = applyLayoutPreset(state, preset.id)
      expect(next.activeGroupId).toBeTruthy()
      expect(Object.keys(next.tabGroups ?? {}).length).toBeGreaterThan(0)
      expect(next.layout).toBeTruthy()
    }
    expect(applyLayoutPreset(state, 'unknown' as any)).toEqual({})
  })
})
