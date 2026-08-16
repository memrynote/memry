/**
 * The lock decision driven end to end, not in halves: the REAL module-level
 * registry in sync/use-yjs-collaboration.ts, its REAL entry factory (real Y.Doc,
 * real snapshot publishing), the REAL `useYjsCollaboration` a note tab's
 * ContentArea mounts, the REAL read-only `useLiveFragmentQuery`, the REAL
 * TabProvider, and the REAL `evaluateNoteLock`. Only `YjsIpcProvider` is faked,
 * because it is the actual outside edge (Electron IPC to main's CRDT provider) —
 * and faking exactly it is what lets a test choose the three settle states the
 * lock now distinguishes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMemo, useState } from 'react'
import { screen, waitFor, act } from '@testing-library/react'
import { TabProvider, useTabActions, useTabs } from '@/contexts/tabs'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { useYjsCollaboration } from '@/sync/use-yjs-collaboration'
import { noteCardClaims } from './canvas-note-lock'
import { useNoteEditLock, lockReasonForCard } from './use-note-edit-lock'
import type { CanvasCardRef } from './canvas-cards'

const ipc = vi.hoisted(() => ({
  mode: 'resolve' as 'resolve' | 'reject' | 'pending',
  settle: [] as Array<() => void>
}))

// Only the three members the entry factory touches: construct, connect, destroy.
// `reject` reproduces the fail-open (`crdt:open-doc` answering success:false, a
// rejecting validateNoteForCrdt, a throwing handshake); `pending` holds the slot
// in its pre-settle state.
vi.mock('@/sync/yjs-ipc-provider', () => ({
  YjsIpcProvider: class {
    connect(): Promise<void> {
      if (ipc.mode === 'reject') return Promise.reject(new Error('crdt:open-doc failed'))
      if (ipc.mode === 'pending') {
        return new Promise<void>((resolve) => {
          ipc.settle.push(resolve)
        })
      }
      return Promise.resolve()
    }
    destroy(): void {}
  }
}))

const cardFor = (noteId: string): CanvasCardRef => ({
  elementId: 'card-1',
  entityType: 'note',
  entityId: noteId,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0
})

/**
 * Stands in for the note tab's ContentArea: the same `useYjsCollaboration` call,
 * with the same single registry consumer. Its reported binding is what the lock
 * is being asked about, so the tests assert on it rather than on timers.
 */
function EditorStandIn({ noteId, testId }: { noteId: string; testId: string }): React.JSX.Element {
  const { isReady, fragment, isSideEffectOwner } = useYjsCollaboration({ noteId })
  return (
    <>
      <span data-testid={`${testId}-binding`}>
        {!isReady ? 'connecting' : fragment ? 'fragment' : 'fail-open'}
      </span>
      <span data-testid={`${testId}-owner`}>{String(isSideEffectOwner)}</span>
    </>
  )
}

function Probe({ noteId }: { noteId: string }): React.JSX.Element {
  const ctx = useNoteEditLock()
  const { openTab, splitView, setActiveGroup } = useTabActions()
  const { state } = useTabs()
  const [editors, setEditors] = useState(0)
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
  // Which group (if any) currently has the note as its active tab, relative to
  // whichever group is focused right now. This is the load-bearing proof:
  // collectVisibleNoteTabIds scans every group regardless of focus, so
  // 'lock' alone can't distinguish "note ended up in the focused group by
  // default-groupId coincidence" from "note is genuinely live in the OTHER,
  // non-focused pane" — both produce the same lock reason. noteLocation
  // makes that distinction explicit.
  const noteGroupId = groupIds.find((id) => {
    const group = state.tabGroups[id]
    const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId)
    return activeTab?.entityId === noteId
  })
  const noteLocation =
    noteGroupId === undefined
      ? 'not-open'
      : noteGroupId === state.activeGroupId
        ? 'focused'
        : 'other'
  // canvas-card-overlay.tsx memoizes its rendered card list on the lock
  // context's IDENTITY (`lockCtx` is a dep of that useMemo, and of both the
  // lockCtxRef sync and the yield-to-tab effect). Mirroring that memo here is
  // what makes this a test of the BOUNDARY between the hook and its consumer
  // rather than of the hook alone: the direct `lock` readout below recomputes on
  // every render, so it stays green even if the context object never takes a new
  // identity — and a context that keeps its identity across a fragment settle
  // leaves a stale lock badge on a card that is now perfectly editable.
  const memoizedLock = useMemo(() => String(lockReasonForCard(ctx, cardFor(noteId))), [ctx, noteId])
  return (
    <div>
      <span data-testid="lock">{String(lockReasonForCard(ctx, cardFor(noteId)))}</span>
      <span data-testid="lock-memoized">{memoizedLock}</span>
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
              title: 'Note',
              icon: 'FileText',
              path: `/${noteId}`,
              entityId: noteId,
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
      <button type="button" onClick={() => setEditors((n) => n + 1)}>
        mount-editor
      </button>
      {editors >= 1 && <EditorStandIn noteId={noteId} testId="editor-a" />}
      {editors >= 2 && <EditorStandIn noteId={noteId} testId="editor-b" />}
    </div>
  )
}

const renderProbe = (noteId: string): void => {
  renderWithProviders(
    <TabProvider>
      <Probe noteId={noteId} />
    </TabProvider>
  )
}

/**
 * Split, open the note in the newly-created (non-focused) pane, then focus the
 * primary pane again — the exact split-view shape the guard exists for: the
 * canvas is in the focused pane while the note stays mounted and editable in the
 * sibling pane.
 */
async function openNoteInOtherPane(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText('split'))
  expect(screen.getByTestId('group-count')).toHaveTextContent('2')
  await user.click(screen.getByText('open-note'))
  await user.click(screen.getByText('focus-primary'))
  // Prove the scenario is real: two groups exist, and the note is the active
  // tab of the group that is NOT currently focused. If the split or the
  // refocus silently no-op, noteLocation resolves to 'focused' or 'not-open'
  // instead of 'other', and this assertion fails.
  expect(screen.getByTestId('note-location')).toHaveTextContent('other')
}

async function mountEditor(
  user: ReturnType<typeof userEvent.setup>,
  binding: 'fragment' | 'fail-open' | 'connecting',
  testId = 'editor-a'
): Promise<void> {
  await user.click(screen.getByText('mount-editor'))
  await waitFor(() => expect(screen.getByTestId(`${testId}-binding`)).toHaveTextContent(binding))
}

describe('useNoteEditLock', () => {
  beforeEach(() => {
    ipc.mode = 'resolve'
    ipc.settle = []
  })

  it('does not lock when the note is not open in any visible pane', () => {
    renderProbe('note-idle')
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('does not lock a card whose note is live in the OTHER pane once the fragment is live', async () => {
    // The relax: a never-signed-in user in perfect health. The tab and the card
    // acquire ONE registry entry, so both bind the same fragment and the
    // whole-markdown save is suppressed on both — there is nothing to clobber.
    const user = userEvent.setup()
    renderProbe('note-live')
    await mountEditor(user, 'fragment')
    await openNoteInOtherPane(user)
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('locks when the other pane holds the note but its binding FAILED OPEN', async () => {
    // The signed-in fail-open nothing covered before: connect() rejected, so the
    // entry published a null fragment for the life of the slot with no rebind
    // and every editor on this note is a whole-markdown saver again. A session
    // predicate cannot see this — the session is fine.
    const user = userEvent.setup()
    ipc.mode = 'reject'
    renderProbe('note-failopen')
    await mountEditor(user, 'fail-open')
    await openNoteInOtherPane(user)
    expect(screen.getByTestId('lock')).toHaveTextContent('note-open-in-tab')
  })

  it('locks while the binding is still connecting, then releases when it settles live', async () => {
    // Pending is not yet safe: it may settle into the fail-open above. It is
    // also not a flap — ContentArea holds its own render behind the same
    // isReady, so this window is the tab's loading skeleton and it ends in ONE
    // transition, which this test drives for real.
    const user = userEvent.setup()
    ipc.mode = 'pending'
    renderProbe('note-connecting')
    await mountEditor(user, 'connecting')
    await openNoteInOtherPane(user)
    expect(screen.getByTestId('lock')).toHaveTextContent('note-open-in-tab')

    await act(async () => {
      ipc.settle.forEach((resolve) => resolve())
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('editor-a-binding')).toHaveTextContent('fragment')
    )
    // The lock released without any tab or claim change: the only input that
    // moved is the registry's published snapshot, reaching the overlay through
    // useLiveFragmentQuery's subscription.
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('hands a consumer memoized on the lock context a NEW context when the fragment settles', async () => {
    // The overlay does not call lockReasonForCard on every render — it renders
    // from a useMemo keyed on the lock context. So "the decision changed" is not
    // enough; the context object itself has to change identity, or the card list
    // is never rebuilt and the badge never clears. Driving the real overlay
    // component here would mean un-mocking use-note-edit-lock in a suite that
    // also stubs Excalidraw, the tabs context and the entity loader — so this
    // reproduces the exact memo shape (deps include the context) against the
    // real hook instead, which is the property that memo depends on.
    const user = userEvent.setup()
    ipc.mode = 'pending'
    renderProbe('note-memo')
    await mountEditor(user, 'connecting')
    await openNoteInOtherPane(user)
    expect(screen.getByTestId('lock')).toHaveTextContent('note-open-in-tab')
    expect(screen.getByTestId('lock-memoized')).toHaveTextContent('note-open-in-tab')

    await act(async () => {
      ipc.settle.forEach((resolve) => resolve())
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('editor-a-binding')).toHaveTextContent('fragment')
    )
    // Nothing about the tabs changed, so `visibleNoteTabIds` keeps its identity:
    // the ONLY thing that can invalidate this memo is the query function taking a
    // new identity with the registry's version.
    await waitFor(() => expect(screen.getByTestId('lock-memoized')).toHaveTextContent('null'))
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('locks when nothing in this window holds the note bound at all', async () => {
    // No slot: the tab is visible but no editor has bound the note here yet
    // (mount race), so nothing proves the next editor will not fail open.
    const user = userEvent.setup()
    renderProbe('note-noslot')
    await openNoteInOtherPane(user)
    expect(screen.getByTestId('lock')).toHaveTextContent('note-open-in-tab')
  })

  it('locks against another card’s claim even when the fragment is live', async () => {
    // The claim is the one-active-card invariant, not a safety answer:
    // canvas-card-overlay refuses the second activation regardless, so this
    // reason must not sit behind the fragment short-circuit.
    const user = userEvent.setup()
    noteCardClaims.claim('note-claimed', 'card-2')
    renderProbe('note-claimed')
    await mountEditor(user, 'fragment')
    expect(screen.getByTestId('lock')).toHaveTextContent('note-active-on-another-card')
    noteCardClaims.release('note-claimed', 'card-2')
  })

  it('asking the lock does not register a second registry consumer (#1495 hazard)', async () => {
    // useNoteEditLock is mounted from the first render here, BEFORE any editor —
    // exactly the order the canvas overlay produces. If it acquired instead of
    // peeking, it would own the slot and the note's sole real editor would
    // report non-owner, silently killing that editor's task auto-conversion.
    const user = userEvent.setup()
    renderProbe('note-owner')
    await mountEditor(user, 'fragment')
    expect(screen.getByTestId('editor-a-owner')).toHaveTextContent('true')
    // Control: ownership CAN be lost here — a genuine second consumer takes the
    // non-owner slot — so 'true' above is a real property, not a constant.
    await user.click(screen.getByText('mount-editor'))
    await waitFor(() =>
      expect(screen.getByTestId('editor-b-binding')).toHaveTextContent('fragment')
    )
    expect(screen.getByTestId('editor-b-owner')).toHaveTextContent('false')
    expect(screen.getByTestId('editor-a-owner')).toHaveTextContent('true')
  })

  it('never locks a non-note card', () => {
    // Same entityId as the "open" note on purpose: only note cards are guarded,
    // because task and event cards autosave field-level patches rather than a
    // whole-body last-write-wins markdown save.
    const taskCard: CanvasCardRef = { ...cardFor('note-task'), entityType: 'task' }
    expect(
      lockReasonForCard(
        { hasLiveFragment: () => false, visibleNoteTabIds: new Set(['note-task']) },
        taskCard
      )
    ).toBeNull()
  })
})
