import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  TabBarAction: ({ tooltip, onClick }: { tooltip: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {tooltip}
    </button>
  )
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

/** Strip geometry jsdom does not compute — drives the chevron gutter state. */
const strip = { scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 }

const defineMetric = (name: 'scrollWidth' | 'clientWidth' | 'scrollLeft'): PropertyDescriptor =>
  ({
    configurable: true,
    get: () => strip[name],
    set: (value: number) => {
      strip[name] = value
    }
  }) as PropertyDescriptor

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()

const group = (activeTabId: string): Record<string, unknown> => ({
  id: 'group-1',
  activeTabId,
  tabs: [
    { id: 'tab-1', title: 'First', isPinned: false, type: 'note' },
    { id: 'tab-2', title: 'Second', isPinned: false, type: 'note' },
    { id: 'tab-3', title: 'Third', isPinned: false, type: 'note' }
  ]
})

describe('TabBarWithDrag active-tab scrolling', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    strip.scrollLeft = 0
    strip.scrollWidth = 1000
    strip.clientWidth = 300

    for (const name of ['scrollWidth', 'clientWidth', 'scrollLeft'] as const) {
      originalDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
      Object.defineProperty(HTMLElement.prototype, name, defineMetric(name))
    }

    scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView =
      scrollIntoView as unknown as HTMLElement['scrollIntoView']
    mocks.tabGroup = group('tab-1')
  })

  afterEach(() => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor)
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
      }
    }
    originalDescriptors.clear()
    vi.restoreAllMocks()
  })

  it('scrolls the active tab into view once, not again as the chevron gutters resize', () => {
    // Mount: the strip overflows, so checkScroll flips canScrollToEnd in the same
    // commit as the scroll — the gutter re-render must not re-animate.
    render(<TabBarWithDrag groupId="group-1" />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    // Scrolling past the start edge flips canScrollToStart, adding the second
    // gutter. The active tab is still on screen, so no second animation.
    strip.scrollLeft = 50
    fireEvent.scroll(screen.getByTestId('tab-strip'))
    expect(
      screen.getByRole('button', { name: 'phaseF.componentsTabsTabBarWithDrag.scrollTabsLeft' })
    ).toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('still scrolls when a different tab becomes active', () => {
    const { rerender } = render(<TabBarWithDrag groupId="group-1" />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toHaveAttribute('data-tab-id', 'tab-1')

    mocks.tabGroup = group('tab-3')
    rerender(<TabBarWithDrag groupId="group-1" />)

    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView.mock.instances[1]).toHaveAttribute('data-tab-id', 'tab-3')
  })
})
