/**
 * #1644 — openSidebarItem under the "clicking a page opens a new tab"
 * preference, and the singleton un-gating that shipped with it.
 *
 * Real reducer + real TabProvider, like the split tests beside this file: the
 * behaviour under test is which tab the OPEN_TAB action ends up touching, which
 * stubbed `openTab` mocks cannot see.
 */

import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { TabProvider, useTabs } from '@/contexts/tabs'
import type { SidebarItem } from '@/contexts/tabs/types'
import { SettingsModalProvider } from '@/contexts/settings-modal-context'
import { FEATURES_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { useSidebarNavigation } from './use-sidebar-navigation'

vi.mock('./use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags: FEATURES_SETTINGS_DEFAULTS })
}))

const settingsMock = vi.hoisted(() => ({ openPagesInNewTab: true }))
vi.mock('./use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { openPagesInNewTab: settingsMock.openPagesInNewTab }
  })
}))

const noteItem = (id: string): SidebarItem => ({
  type: 'note',
  title: id,
  path: `/notes/${id}`,
  entityId: id
})

const INBOX_ITEM: SidebarItem = { type: 'inbox', title: 'Inbox', path: '/inbox' }

function Probe(): React.JSX.Element {
  const { openSidebarItem } = useSidebarNavigation()
  const { state } = useTabs()

  const group = state.tabGroups[state.activeGroupId]
  const activeTab = group.tabs.find((t) => t.id === group.activeTabId)

  return (
    <div>
      <span data-testid="tab-count">{group.tabs.length}</span>
      <span data-testid="inbox-count">{group.tabs.filter((t) => t.type === 'inbox').length}</span>
      <span data-testid="active-entity">{activeTab?.entityId ?? activeTab?.type ?? 'none'}</span>
      <button type="button" onClick={() => openSidebarItem(noteItem('note-a'))}>
        open-a
      </button>
      <button type="button" onClick={() => openSidebarItem(noteItem('note-b'))}>
        open-b
      </button>
      <button type="button" onClick={() => openSidebarItem(INBOX_ITEM)}>
        open-inbox
      </button>
      <button type="button" onClick={() => openSidebarItem(INBOX_ITEM, { inNewTab: true })}>
        open-inbox-new-tab
      </button>
      <button
        type="button"
        onClick={() => openSidebarItem(INBOX_ITEM, { inNewTab: true, inBackground: true })}
      >
        open-inbox-middle-click
      </button>
    </div>
  )
}

const renderProbe = (): void => {
  renderWithProviders(
    <SettingsModalProvider>
      <TabProvider>
        <Probe />
      </TabProvider>
    </SettingsModalProvider>
  )
}

describe('openSidebarItem under openPagesInNewTab (#1644)', () => {
  it('reuses the active tab for plain opens when the preference is off', async () => {
    settingsMock.openPagesInNewTab = false
    const user = userEvent.setup()
    renderProbe()

    const startCount = Number(screen.getByTestId('tab-count').textContent)

    await user.click(screen.getByText('open-a'))
    expect(screen.getByTestId('active-entity').textContent).toBe('note-a')
    expect(Number(screen.getByTestId('tab-count').textContent)).toBe(startCount)

    // Browsing on replaces in place rather than accumulating.
    await user.click(screen.getByText('open-b'))
    expect(screen.getByTestId('active-entity').textContent).toBe('note-b')
    expect(Number(screen.getByTestId('tab-count').textContent)).toBe(startCount)

    // Reopening a page that is already open focuses it — dedup runs before
    // reuse, so no tab is destroyed to show a copy of itself.
    await user.click(screen.getByText('open-b'))
    expect(Number(screen.getByTestId('tab-count').textContent)).toBe(startCount)
  })

  it('keeps opening new tabs for plain opens when the preference is on', async () => {
    settingsMock.openPagesInNewTab = true
    const user = userEvent.setup()
    renderProbe()

    const startCount = Number(screen.getByTestId('tab-count').textContent)
    await user.click(screen.getByText('open-a'))
    await user.click(screen.getByText('open-b'))
    expect(Number(screen.getByTestId('tab-count').textContent)).toBe(startCount + 2)
  })

  it('mints a genuine second copy of a singleton on an explicit new-tab gesture', async () => {
    settingsMock.openPagesInNewTab = true
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByText('open-inbox'))
    expect(screen.getByTestId('inbox-count').textContent).toBe('1')

    // Plain re-click focuses the existing one — the singleton dedup still holds
    // for plain clicks.
    await user.click(screen.getByText('open-inbox'))
    expect(screen.getByTestId('inbox-count').textContent).toBe('1')

    // The explicit gesture is no longer downgraded to "focus what exists".
    await user.click(screen.getByText('open-inbox-new-tab'))
    expect(screen.getByTestId('inbox-count').textContent).toBe('2')
  })

  it('middle-click opens a background copy without stealing focus', async () => {
    settingsMock.openPagesInNewTab = true
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByText('open-a'))
    expect(screen.getByTestId('active-entity').textContent).toBe('note-a')

    await user.click(screen.getByText('open-inbox-middle-click'))
    expect(screen.getByTestId('inbox-count').textContent).toBe('1')
    // Focus stayed where it was.
    expect(screen.getByTestId('active-entity').textContent).toBe('note-a')
  })
})
