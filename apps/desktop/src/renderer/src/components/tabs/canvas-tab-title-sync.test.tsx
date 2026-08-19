/**
 * The seam under test is the real one: a real `TabProvider`, the real reducer,
 * and the real `updateTabTitleByEntityId`. Only `window.api.onCanvasUpdated` —
 * the IPC boundary the renderer cannot own — is a mock, so an assertion here is
 * about the tab state a user would see and not about a spy having been called.
 */

import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabProvider, useTabs } from '@/contexts/tabs/context'
import type { Tab, TabGroup, TabSystemState } from '@/contexts/tabs/types'
import { CanvasTabTitleSync } from './canvas-tab-title-sync'

interface CanvasUpdatedPayload {
  canvas?: { id?: string; title?: string }
}

/** The listener the component hands to the preload bridge. */
let emitCanvasUpdated: ((event: CanvasUpdatedPayload) => void) | null = null
const unsubscribe = vi.fn()

const canvasTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: overrides.id ?? 'tab-canvas',
  type: 'canvas',
  title: overrides.title ?? 'Old name',
  icon: 'pen-tool',
  path: `/canvas/${overrides.entityId ?? 'canvas-1'}`,
  entityId: overrides.entityId ?? 'canvas-1',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1,
  ...overrides
})

const makeGroup = (id: string, tabs: Tab[]): TabGroup => ({
  id,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  isActive: true,
  back: [],
  forward: []
})

const makeState = (groups: TabGroup[]): TabSystemState => ({
  tabGroups: Object.fromEntries(groups.map((group) => [group.id, group])),
  layout: { type: 'leaf', tabGroupId: groups[0].id },
  activeGroupId: groups[0].id,
  settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
  recentlyClosed: []
})

function mount(initialState: TabSystemState) {
  let latest: ReturnType<typeof useTabs> | null = null

  const Probe = (): null => {
    latest = useTabs()
    return null
  }

  const view = render(
    <TabProvider initialState={initialState}>
      <CanvasTabTitleSync />
      <Probe />
    </TabProvider>
  )

  return {
    ...view,
    titleOf: (groupId: string, tabId: string): string | undefined =>
      latest?.state.tabGroups[groupId]?.tabs.find((tab) => tab.id === tabId)?.title,
    get groups() {
      return latest?.state.tabGroups
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  emitCanvasUpdated = null
  window.api.onSettingsChanged = vi.fn(() => vi.fn())
  window.api.onCanvasUpdated = vi.fn((callback: (event: CanvasUpdatedPayload) => void) => {
    emitCanvasUpdated = callback
    return unsubscribe
  }) as unknown as typeof window.api.onCanvasUpdated
})

describe('CanvasTabTitleSync', () => {
  it('retitles the open tab when its canvas is renamed', () => {
    const view = mount(makeState([makeGroup('main', [canvasTab()])]))

    act(() => emitCanvasUpdated?.({ canvas: { id: 'canvas-1', title: 'New name' } }))

    expect(view.titleOf('main', 'tab-canvas')).toBe('New name')
  })

  it('retitles a canvas tab the user is not looking at', () => {
    const view = mount(
      makeState([
        makeGroup('main', [
          canvasTab({ id: 'tab-active', entityId: 'canvas-active', title: 'Active' }),
          canvasTab({ id: 'tab-background', entityId: 'canvas-1' })
        ])
      ])
    )

    act(() => emitCanvasUpdated?.({ canvas: { id: 'canvas-1', title: 'New name' } }))

    expect(view.titleOf('main', 'tab-background')).toBe('New name')
    expect(view.titleOf('main', 'tab-active')).toBe('Active')
  })

  it('retitles the same canvas in every pane it is open in', () => {
    const view = mount(
      makeState([
        makeGroup('main', [canvasTab({ id: 'tab-left' })]),
        makeGroup('side', [canvasTab({ id: 'tab-right' })])
      ])
    )

    act(() => emitCanvasUpdated?.({ canvas: { id: 'canvas-1', title: 'New name' } }))

    expect(view.titleOf('main', 'tab-left')).toBe('New name')
    expect(view.titleOf('side', 'tab-right')).toBe('New name')
  })

  it('leaves tab state untouched when a save carries the title the tab already has', () => {
    // `canvas:updated` fires on every scene save, so this is the common case,
    // not the edge one: it must not churn state the persistence layer writes.
    const view = mount(makeState([makeGroup('main', [canvasTab({ title: 'Same name' })])]))
    const before = view.groups

    act(() => emitCanvasUpdated?.({ canvas: { id: 'canvas-1', title: 'Same name' } }))

    expect(view.groups).toBe(before)
  })

  it('falls back to the untitled label when a write clears the title', () => {
    const view = mount(makeState([makeGroup('main', [canvasTab()])]))

    act(() => emitCanvasUpdated?.({ canvas: { id: 'canvas-1', title: '' } }))

    expect(view.titleOf('main', 'tab-canvas')).toBe('Untitled canvas')
  })

  it('ignores an update for a canvas that has no tab open', () => {
    const view = mount(makeState([makeGroup('main', [canvasTab()])]))
    const before = view.groups

    act(() => emitCanvasUpdated?.({ canvas: { id: 'canvas-other', title: 'New name' } }))

    expect(view.groups).toBe(before)
    expect(view.titleOf('main', 'tab-canvas')).toBe('Old name')
  })

  it('survives an event that carries no canvas', () => {
    const view = mount(makeState([makeGroup('main', [canvasTab()])]))

    act(() => emitCanvasUpdated?.({}))

    expect(view.titleOf('main', 'tab-canvas')).toBe('Old name')
  })

  it('unsubscribes on unmount', () => {
    const view = mount(makeState([makeGroup('main', [canvasTab()])]))

    view.unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
