import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { TabProvider, useTabActions, useTabs } from '@/contexts/tabs'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { noteCardClaims } from './canvas-note-lock'
import { useNoteEditLock, lockReasonForCard } from './use-note-edit-lock'
import type { CanvasCardRef } from './canvas-cards'

const syncStatus = { current: 'unknown' as string }
vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({ state: { status: syncStatus.current } })
}))

const CARD: CanvasCardRef = {
  elementId: 'card-1',
  entityType: 'note',
  entityId: 'note-1',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0
}

function Probe(): React.JSX.Element {
  const ctx = useNoteEditLock()
  const { openTab, splitView, setActiveGroup } = useTabActions()
  const { state } = useTabs()
  const groupIds = Object.keys(state.tabGroups)
  const primaryGroupId = groupIds[0]
  // SPLIT_VIEW creates the new pane but does not focus it (see
  // reducers/layout-reducer.ts — newGroup.isActive is false and
  // state.activeGroupId is untouched). An openTab call with no groupId
  // defaults to state.activeGroupId, which right after a split is still the
  // primary group — so it would land back in the SAME (focused) group and
  // never exercise the cross-group case this hook exists for. Targeting the
  // split-created group explicitly is what makes "note live in the other
  // pane" a real, reachable state instead of a same-group coincidence.
  const secondaryGroupId = groupIds.find((id) => id !== primaryGroupId)
  // Which group (if any) currently has note-1 as its active tab, relative to
  // whichever group is focused right now. This is the load-bearing proof:
  // collectVisibleNoteTabIds scans every group regardless of focus, so
  // 'lock' alone can't distinguish "note ended up in the focused group by
  // default-groupId coincidence" from "note is genuinely live in the OTHER,
  // non-focused pane" — both produce the same lock reason. noteLocation
  // makes that distinction explicit.
  const noteGroupId = groupIds.find((id) => {
    const group = state.tabGroups[id]
    const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId)
    return activeTab?.entityId === 'note-1'
  })
  const noteLocation =
    noteGroupId === undefined
      ? 'not-open'
      : noteGroupId === state.activeGroupId
        ? 'focused'
        : 'other'
  return (
    <div>
      <span data-testid="lock">{String(lockReasonForCard(ctx, CARD))}</span>
      <span data-testid="group-count">{groupIds.length}</span>
      <span data-testid="note-location">{noteLocation}</span>
      <button type="button" onClick={() => splitView('horizontal', primaryGroupId)}>
        split
      </button>
      <button
        type="button"
        onClick={() =>
          // openTab takes Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>, so every
          // other Tab field is required — see contexts/tabs/types.ts.
          openTab(
            {
              type: 'note',
              title: 'Note 1',
              icon: 'FileText',
              path: '/note-1',
              entityId: 'note-1',
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false
            },
            { groupId: secondaryGroupId }
          )
        }
      >
        open-note
      </button>
      <button type="button" onClick={() => setActiveGroup(primaryGroupId)}>
        focus-primary
      </button>
    </div>
  )
}

const renderProbe = (): void => {
  renderWithProviders(
    <TabProvider>
      <Probe />
    </TabProvider>
  )
}

describe('useNoteEditLock', () => {
  beforeEach(() => {
    syncStatus.current = 'unknown'
    noteCardClaims.release('note-1', noteCardClaims.claimedBy('note-1') ?? '')
  })

  it('does not lock when the note is not open in any visible pane', async () => {
    renderProbe()
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('locks an unauthenticated card when the note is live in the OTHER pane', async () => {
    const user = userEvent.setup()
    renderProbe()
    // Split, open the note in the newly-created (non-focused) pane, then
    // focus the primary pane again — the exact split-view shape the guard
    // exists for: the canvas is in the focused pane while the note stays
    // mounted and editable in the sibling pane.
    await user.click(screen.getByText('split'))
    expect(screen.getByTestId('group-count')).toHaveTextContent('2')
    await user.click(screen.getByText('open-note'))
    await user.click(screen.getByText('focus-primary'))
    // Prove the scenario is real: two groups exist, and note-1 is the active
    // tab of the group that is NOT currently focused. If the split or the
    // refocus silently no-op, noteLocation resolves to 'focused' or
    // 'not-open' instead of 'other', and this assertion fails.
    expect(screen.getByTestId('note-location')).toHaveTextContent('other')
    expect(screen.getByTestId('lock')).toHaveTextContent('note-open-in-tab')
  })

  it('does not lock an authenticated card even with the note live in the other pane', async () => {
    const user = userEvent.setup()
    syncStatus.current = 'idle'
    renderProbe()
    await user.click(screen.getByText('split'))
    await user.click(screen.getByText('open-note'))
    await user.click(screen.getByText('focus-primary'))
    // Same real cross-pane state as the unauthenticated case above — the
    // note genuinely lives in the non-focused group — but collaboration
    // being active short-circuits the lock regardless.
    expect(screen.getByTestId('note-location')).toHaveTextContent('other')
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('locks when another card holds the claim', async () => {
    noteCardClaims.claim('note-1', 'card-2')
    renderProbe()
    expect(screen.getByTestId('lock')).toHaveTextContent('note-active-on-another-card')
    noteCardClaims.release('note-1', 'card-2')
  })

  it('never locks a non-note card', () => {
    // Same entityId as the "open" note on purpose: only note cards are guarded,
    // because task and event cards autosave field-level patches rather than a
    // whole-body last-write-wins markdown save.
    const taskCard: CanvasCardRef = { ...CARD, entityType: 'task' }
    expect(
      lockReasonForCard(
        { collaborationActive: false, visibleNoteTabIds: new Set(['note-1']) },
        taskCard
      )
    ).toBeNull()
  })
})
