/**
 * "Open to the side" must land the tab in the pane the split created.
 *
 * These run against the real reducer and the real TabProvider on purpose: the
 * defect is entirely about which group the OPEN_TAB action resolves to, so a
 * test that stubs `splitView`/`openTab` cannot see it. The probe reports where
 * the item actually ended up, labelled relative to the panes that existed
 * before the gesture.
 */

import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { TabProvider, useTabActions, useTabs } from '@/contexts/tabs'
import type { SidebarItem } from '@/contexts/tabs/types'
import { SettingsModalProvider } from '@/contexts/settings-modal-context'
import { FEATURES_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { useSidebarNavigation } from './use-sidebar-navigation'

// Feature gating is a different concern (and 'note' is not a gated type); this
// keeps the hook off window.api so the test only exercises tab routing.
vi.mock('./use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags: FEATURES_SETTINGS_DEFAULTS })
}))

const NOTE_ITEM: SidebarItem = {
  type: 'note',
  title: 'Note B',
  path: '/notes/b.md',
  entityId: 'note-b'
}

/** Panes that existed before the gesture under test, recorded by `snapshot-panes`. */
const preExistingGroupIds = new Set<string>()

function Probe(): React.JSX.Element {
  const { openSidebarItem } = useSidebarNavigation()
  const { splitView, setActiveGroup, openTab } = useTabActions()
  const { state } = useTabs()

  const groupIds = Object.keys(state.tabGroups)
  const originalGroupId = groupIds[0]
  const holdsItem = (groupId: string): boolean =>
    state.tabGroups[groupId].tabs.some((tab) => tab.entityId === NOTE_ITEM.entityId)

  // Every pane holding the item, named relative to the panes that were already
  // on screen — so an assertion cannot pass by landing in the pane we split
  // away from, or in some other pane that happened to be focused.
  const itemLocations = groupIds.filter(holdsItem).map((groupId) => {
    if (groupId === originalGroupId) return 'original-pane'
    if (preExistingGroupIds.has(groupId)) return 'pre-existing-pane'
    return 'split-created-pane'
  })

  return (
    <div>
      <span data-testid="group-count">{groupIds.length}</span>
      <span data-testid="item-locations">{itemLocations.join(',') || 'not-open'}</span>
      <span data-testid="active-pane-has-item">{String(holdsItem(state.activeGroupId))}</span>
      <span data-testid="pane-tab-counts">
        {groupIds.map((groupId) => state.tabGroups[groupId].tabs.length).join(',')}
      </span>
      <button type="button" onClick={() => openSidebarItem(NOTE_ITEM, { toTheSide: true })}>
        open-to-the-side
      </button>
      <button type="button" onClick={() => openSidebarItem(NOTE_ITEM)}>
        open-here
      </button>
      <button type="button" onClick={() => splitView('horizontal', originalGroupId)}>
        pre-split
      </button>
      <button
        type="button"
        onClick={() => {
          // Freeze the current pane list so the probe can tell "the pane the
          // gesture under test created" from "a pane that was already there".
          // Clicked after any setup splits, before the gesture being asserted.
          for (const id of groupIds) preExistingGroupIds.add(id)
        }}
      >
        snapshot-panes
      </button>
      <button
        type="button"
        onClick={() => {
          // The race, made deterministic: something else takes focus in the same
          // turn as the split. An open that resolves its target group "later"
          // follows that focus and lands in the wrong pane.
          openSidebarItem(NOTE_ITEM, { toTheSide: true })
          const otherGroupId = groupIds.find((id) => id !== state.activeGroupId)
          if (otherGroupId) setActiveGroup(otherGroupId)
        }}
      >
        open-to-the-side-then-refocus
      </button>
      <button
        type="button"
        onClick={() =>
          openTab(
            {
              type: 'note',
              title: NOTE_ITEM.title,
              icon: 'FileText',
              path: NOTE_ITEM.path,
              entityId: NOTE_ITEM.entityId,
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false
            },
            { background: true }
          )
        }
      >
        open-item-here-in-background
      </button>
    </div>
  )
}

const renderProbe = (): void => {
  preExistingGroupIds.clear()
  renderWithProviders(
    <SettingsModalProvider>
      <TabProvider>
        <Probe />
      </TabProvider>
    </SettingsModalProvider>
  )
}

describe('useSidebarNavigation — open to the side', () => {
  it('leaves the new pane holding only the item, not a clone of the source tab', async () => {
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByText('open-to-the-side'))

    // SPLIT_VIEW seeds a new pane with a copy of the source's active tab so a
    // keyboard split is never empty. Here that copy is noise: you asked to see
    // this note beside what you were reading, not beside a second copy of it.
    expect(screen.getByTestId('pane-tab-counts')).toHaveTextContent('1,1')
  })

  it('opens the item in the pane the split created, not the pane it split from', async () => {
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByText('open-to-the-side'))

    expect(screen.getByTestId('group-count')).toHaveTextContent('2')
    expect(screen.getByTestId('item-locations')).toHaveTextContent(/^split-created-pane$/)
    // Focus follows the item into the new pane, which is the point of the gesture.
    expect(screen.getByTestId('active-pane-has-item')).toHaveTextContent('true')
  })

  it('lands in the target pane when focus moves before the open resolves', async () => {
    const user = userEvent.setup()
    renderProbe()

    // Two panes already on screen, focus on the first.
    await user.click(screen.getByText('pre-split'))
    expect(screen.getByTestId('group-count')).toHaveTextContent('2')
    await user.click(screen.getByText('snapshot-panes'))

    await user.click(screen.getByText('open-to-the-side-then-refocus'))

    // Still two panes — the gesture reuses the pane beside this one rather than
    // minting a third. The item must be in that sibling, not in the pane that
    // took focus a beat later.
    expect(screen.getByTestId('group-count')).toHaveTextContent('2')
    expect(screen.getByTestId('item-locations')).toHaveTextContent(/^pre-existing-pane$/)
  })

  it('reuses the pane beside this one instead of splitting again', async () => {
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByText('pre-split'))
    await user.click(screen.getByText('snapshot-panes'))
    await user.click(screen.getByText('open-to-the-side'))

    // Without this, every right-click grows the layout by a pane: three
    // "Open to the Side"s would leave four panes on screen.
    expect(screen.getByTestId('group-count')).toHaveTextContent('2')
    expect(screen.getByTestId('item-locations')).toHaveTextContent(/^pre-existing-pane$/)
  })

  it('gives the item its own tab in the new pane even when it is already open elsewhere', async () => {
    const user = userEvent.setup()
    renderProbe()

    // Item already open (unfocused) in the pane we are about to split.
    await user.click(screen.getByText('open-item-here-in-background'))
    expect(screen.getByTestId('item-locations')).toHaveTextContent(/^original-pane$/)

    await user.click(screen.getByText('open-to-the-side'))

    expect(screen.getByTestId('group-count')).toHaveTextContent('2')
    // Both copies: the original, plus one in the pane the split created.
    expect(screen.getByTestId('item-locations')).toHaveTextContent(
      /^original-pane,split-created-pane$/
    )
    expect(screen.getByTestId('active-pane-has-item')).toHaveTextContent('true')
  })

  it('opens in the active pane without splitting when toTheSide is not requested', async () => {
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByText('open-here'))

    expect(screen.getByTestId('group-count')).toHaveTextContent('1')
    expect(screen.getByTestId('item-locations')).toHaveTextContent(/^original-pane$/)
  })
})
