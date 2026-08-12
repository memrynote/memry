/**
 * "Open in New Tab" must actually open a new tab.
 *
 * Driven through the real `SidebarNavItem` (so the Cmd-click / middle-click /
 * context-menu handlers are the ones under test) against the real `TabProvider`
 * and reducer. A stubbed `openTab` cannot see this defect: the hook did call
 * `openTab`/`setActiveTab`, it just called them with intent the reducer then
 * deduplicated away. Only the resulting tab list tells the truth.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TabProvider, useTabActions, useTabs } from '@/contexts/tabs'
import { createTabFromSidebarItem } from '@/contexts/tabs/helpers'
import type { SidebarItem } from '@/contexts/tabs/types'
import { SettingsModalProvider } from '@/contexts/settings-modal-context'
import { FEATURES_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'
import { SidebarNavItem } from './sidebar-nav-item'

// Feature gating is a different concern; this keeps the hook off window.api so
// the test only exercises tab routing.
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags: FEATURES_SETTINGS_DEFAULTS })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const NOTE_ITEM: SidebarItem = {
  type: 'note',
  title: 'Note A',
  path: '/notes/a.md',
  entityId: 'note-a'
}

/** A declared SINGLETON_TAB_TYPES view — one instance, by design. */
const INBOX_ITEM: SidebarItem = {
  type: 'inbox',
  title: 'Inbox',
  path: '/inbox'
}

function Probe({ item }: { item: SidebarItem }): React.JSX.Element {
  const { state } = useTabs()
  const { openTab } = useTabActions()

  const group = state.tabGroups[state.activeGroupId]
  const matches = group.tabs.filter((tab) =>
    item.entityId ? tab.entityId === item.entityId : tab.type === item.type
  )
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId)

  return (
    <div>
      <span data-testid="tabs-for-item">{matches.length}</span>
      {/* Distinct reducer-minted ids, not one tab counted twice. */}
      <span data-testid="distinct-tab-ids">{new Set(matches.map((tab) => tab.id)).size}</span>
      <span data-testid="active-tab-type">{activeTab?.type ?? 'none'}</span>
      <span data-testid="active-tab-is-item">
        {String(
          activeTab !== undefined &&
            (item.entityId ? activeTab.entityId === item.entityId : activeTab.type === item.type)
        )}
      </span>
      <button
        type="button"
        onClick={() => openTab(createTabFromSidebarItem(item), { background: true })}
      >
        seed-unfocused-tab
      </button>
    </div>
  )
}

const renderItem = (item: SidebarItem): void => {
  render(
    <SettingsModalProvider>
      <TabProvider>
        <Probe item={item} />
        <SidebarNavItem item={item} />
      </TabProvider>
    </SettingsModalProvider>
  )
}

/** The sidebar row itself (the Probe's buttons are named, this one is not). */
const sidebarRow = (item: SidebarItem): HTMLElement =>
  screen.getByRole('button', { name: item.title })

/** Item already open, sitting unfocused behind the default Home tab. */
const seedUnfocusedTab = (item: SidebarItem): void => {
  fireEvent.click(screen.getByText('seed-unfocused-tab'))
  expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('1')
  expect(screen.getByTestId('active-tab-type')).toHaveTextContent('home')
}

describe('SidebarNavItem — open in new tab', () => {
  it('gives a plain click the tab that is already open, not a second one', () => {
    renderItem(NOTE_ITEM)
    seedUnfocusedTab(NOTE_ITEM)

    fireEvent.click(sidebarRow(NOTE_ITEM))

    expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('1')
    expect(screen.getByTestId('active-tab-is-item')).toHaveTextContent('true')
  })

  it('opens a second tab on Cmd-click even though the item is already open', () => {
    renderItem(NOTE_ITEM)
    seedUnfocusedTab(NOTE_ITEM)

    fireEvent.click(sidebarRow(NOTE_ITEM), { metaKey: true })

    expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('2')
    expect(screen.getByTestId('distinct-tab-ids')).toHaveTextContent('2')
    // Cmd-click without Shift focuses what it opened.
    expect(screen.getByTestId('active-tab-is-item')).toHaveTextContent('true')
  })

  it('opens a second tab on Ctrl-click (Windows/Linux modifier)', () => {
    renderItem(NOTE_ITEM)
    seedUnfocusedTab(NOTE_ITEM)

    fireEvent.click(sidebarRow(NOTE_ITEM), { ctrlKey: true })

    expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('2')
    expect(screen.getByTestId('distinct-tab-ids')).toHaveTextContent('2')
  })

  it('opens a second tab in the background on middle-click', () => {
    renderItem(NOTE_ITEM)
    seedUnfocusedTab(NOTE_ITEM)

    fireEvent.mouseDown(sidebarRow(NOTE_ITEM), { button: 1 })

    expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('2')
    expect(screen.getByTestId('distinct-tab-ids')).toHaveTextContent('2')
    // Background: focus stays where it was.
    expect(screen.getByTestId('active-tab-type')).toHaveTextContent('home')
  })

  it('opens a second tab from the "Open in New Tab" context-menu entry', async () => {
    renderItem(NOTE_ITEM)
    seedUnfocusedTab(NOTE_ITEM)

    fireEvent.contextMenu(sidebarRow(NOTE_ITEM))
    const menuItem = await screen.findByText('Open in New Tab')
    fireEvent.click(menuItem)

    await waitFor(() => {
      expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('2')
    })
    expect(screen.getByTestId('distinct-tab-ids')).toHaveTextContent('2')
    expect(screen.getByTestId('active-tab-is-item')).toHaveTextContent('true')
  })

  it('keeps singleton views single-instance and leaves focus alone in the background', () => {
    // Deliberate policy: SINGLETON_TAB_TYPES (Inbox, Calendar, Tasks, …) are
    // declared one-instance, so "new tab" cannot mint a second identical view.
    // What it must still honour is `inBackground` — middle-click may not yank
    // focus onto a tab it did not open.
    renderItem(INBOX_ITEM)
    seedUnfocusedTab(INBOX_ITEM)

    fireEvent.mouseDown(sidebarRow(INBOX_ITEM), { button: 1 })

    expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('1')
    expect(screen.getByTestId('active-tab-type')).toHaveTextContent('home')
  })

  it('still focuses the existing singleton tab on a foreground open', () => {
    renderItem(INBOX_ITEM)
    seedUnfocusedTab(INBOX_ITEM)

    fireEvent.click(sidebarRow(INBOX_ITEM), { metaKey: true })

    expect(screen.getByTestId('tabs-for-item')).toHaveTextContent('1')
    expect(screen.getByTestId('active-tab-type')).toHaveTextContent('inbox')
  })
})
