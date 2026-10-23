/**
 * Tab enter/exit animation wiring (#1368 deleted variants nothing consumed;
 * this asserts the replacement is actually consumed).
 *
 * The contract under test: a removed tab leaves the DOM *through* an
 * AnimatePresence exit — it is still mounted synchronously after the state
 * change and disappears when the exit finishes — and a strip re-render keeps
 * every remaining tab mounted. Real `motion/react` on purpose; mocking it
 * would re-create the exact bug this guards against.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TabBarWithDrag } from './tab-bar-with-drag'

const mocks = vi.hoisted(() => ({
  tabGroup: null as Record<string, unknown> | null
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  horizontalListSortingStrategy: {}
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ isOpen: false, width: 320, isResizing: false, toggle: vi.fn() })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabGroup: () => mocks.tabGroup
}))

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded' })
}))

vi.mock('./sortable-tab', () => ({
  SortableTab: ({ tab }: { tab: { id: string; title: string } }) => (
    <div data-tab-id={tab.id}>{tab.title}</div>
  )
}))

vi.mock('./pinned-tab', () => ({
  PinnedTab: ({ tab }: { tab: { title: string } }) => <div>{tab.title}</div>
}))

vi.mock('./tab-bar-action', () => ({
  TabBarAction: () => null
}))

vi.mock('./new-tab-menu', () => ({
  NewTabMenu: () => <button type="button">new tab</button>
}))

vi.mock('./tab-bar-context-menu', () => ({
  TabBarContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./tab-context-menu', () => ({
  TabContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const tab = (id: string, title: string, isPinned = false): Record<string, unknown> => ({
  id,
  title,
  isPinned,
  type: 'note'
})

const group = (tabs: Record<string, unknown>[]): Record<string, unknown> => ({
  id: 'group-1',
  activeTabId: (tabs[0]?.id as string) ?? null,
  tabs
})

describe('tab enter/exit animation', () => {
  it('keeps a closed tab mounted through its exit animation, then removes it', async () => {
    mocks.tabGroup = group([tab('tab-1', 'First'), tab('tab-2', 'Second')])
    const { rerender } = render(<TabBarWithDrag groupId="group-1" />)

    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()

    mocks.tabGroup = group([tab('tab-1', 'First')])
    rerender(<TabBarWithDrag groupId="group-1" />)

    // Synchronously after the close, the tab is still in the DOM — that IS the
    // exit animation. Without AnimatePresence this assertion fails.
    expect(screen.getByText('Second')).toBeInTheDocument()

    // ...and once the exit finishes it is gone.
    await waitFor(() => expect(screen.queryByText('Second')).not.toBeInTheDocument(), {
      timeout: 3000
    })
    expect(screen.getByText('First')).toBeInTheDocument()
  })

  // The pinned SECTION is gated on pinnedTabs.length > 0, so closing the last
  // pinned tab drops the whole shell without an exit — only a pinned tab
  // leaving a still-populated section animates.
  it('animates a pinned tab out while the section remains', async () => {
    mocks.tabGroup = group([
      tab('pin-1', 'PinnedA', true),
      tab('pin-2', 'PinnedB', true),
      tab('tab-1', 'First')
    ])
    const { rerender } = render(<TabBarWithDrag groupId="group-1" />)
    expect(screen.getByText('PinnedB')).toBeInTheDocument()

    mocks.tabGroup = group([tab('pin-1', 'PinnedA', true), tab('tab-1', 'First')])
    rerender(<TabBarWithDrag groupId="group-1" />)

    expect(screen.getByText('PinnedB')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('PinnedB')).not.toBeInTheDocument(), {
      timeout: 3000
    })
    expect(screen.getByText('PinnedA')).toBeInTheDocument()
  })

  it('mounts a newly opened tab immediately', () => {
    mocks.tabGroup = group([tab('tab-1', 'First')])
    const { rerender } = render(<TabBarWithDrag groupId="group-1" />)

    mocks.tabGroup = group([tab('tab-1', 'First'), tab('tab-2', 'Second')])
    rerender(<TabBarWithDrag groupId="group-1" />)
    expect(screen.getByText('Second')).toBeInTheDocument()
  })
})
