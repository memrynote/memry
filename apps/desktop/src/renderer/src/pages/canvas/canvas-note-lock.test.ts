import { describe, it, expect } from 'vitest'
import type { TabGroup } from '@/contexts/tabs'
import {
  collectVisibleNoteTabIds,
  createNoteCardClaims,
  evaluateNoteLock
} from './canvas-note-lock'

const group = (
  id: string,
  tabs: Array<{ id: string; type: string; entityId?: string }>,
  activeTabId: string | null
): TabGroup =>
  ({
    id,
    tabs: tabs.map((t) => ({
      ...t,
      title: t.id,
      icon: '',
      path: '',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      openedAt: 0,
      lastAccessedAt: 0
    })),
    activeTabId,
    isActive: false,
    back: [],
    forward: []
  }) as unknown as TabGroup

describe('collectVisibleNoteTabIds', () => {
  it('collects the entityId of each group’s ACTIVE note tab', () => {
    const groups = {
      a: group('a', [{ id: 't1', type: 'note', entityId: 'n1' }], 't1'),
      b: group('b', [{ id: 't2', type: 'note', entityId: 'n2' }], 't2')
    }
    expect(collectVisibleNoteTabIds(groups)).toEqual(new Set(['n1', 'n2']))
  })

  it('ignores background tabs — only the active tab of a pane is mounted', () => {
    const groups = {
      a: group(
        'a',
        [
          { id: 't1', type: 'note', entityId: 'n1' },
          { id: 't2', type: 'canvas', entityId: 'c1' }
        ],
        't2'
      )
    }
    expect(collectVisibleNoteTabIds(groups)).toEqual(new Set())
  })

  it('ignores non-note active tabs', () => {
    const groups = {
      a: group('a', [{ id: 't1', type: 'canvas', entityId: 'c1' }], 't1')
    }
    expect(collectVisibleNoteTabIds(groups)).toEqual(new Set())
  })

  it('ignores note tabs with no entityId', () => {
    const groups = {
      b: group('b', [{ id: 't2', type: 'note' }], 't2')
    }
    expect(collectVisibleNoteTabIds(groups)).toEqual(new Set())
  })
})

describe('evaluateNoteLock', () => {
  const base = {
    fragmentLive: false,
    visibleNoteTabIds: new Set<string>(),
    claimedBy: null as string | null,
    cardElementId: 'card-1',
    noteId: 'n1'
  }

  it('does not lock against a tab when this window holds a live fragment (co-edit is safe)', () => {
    // The relax #1504 exists for: both editors bind the same fragment, so the
    // whole-markdown save is suppressed on both and neither can clobber.
    expect(
      evaluateNoteLock({ ...base, fragmentLive: true, visibleNoteTabIds: new Set(['n1']) })
    ).toBeNull()
  })

  it('still locks against a tab when the fragment is not live (fail-open / connecting / no slot)', () => {
    // The signed-in fail-open the session predicate could not see: a live
    // session, a note whose own connect() rejected, both editors whole-markdown
    // savers. `fragmentLive: false` is the ONLY input; the session is not asked.
    expect(
      evaluateNoteLock({ ...base, fragmentLive: false, visibleNoteTabIds: new Set(['n1']) })
    ).toBe('note-open-in-tab')
  })

  it('locks a second card even with a live fragment (the claim is an invariant, not a safety answer)', () => {
    // canvas-card-overlay refuses the second activation through
    // noteCardClaims.claim regardless of the fragment, so this reason must not
    // sit behind the safety short-circuit or the refusal would be silent.
    expect(evaluateNoteLock({ ...base, fragmentLive: true, claimedBy: 'card-2' })).toBe(
      'note-active-on-another-card'
    )
  })

  it('locks when the note is the active tab of a visible pane', () => {
    expect(evaluateNoteLock({ ...base, visibleNoteTabIds: new Set(['n1']) })).toBe(
      'note-open-in-tab'
    )
  })

  it('locks when another card already claims the note', () => {
    expect(evaluateNoteLock({ ...base, claimedBy: 'card-2' })).toBe('note-active-on-another-card')
  })

  it('does not lock a card against its own claim (re-activation stays allowed)', () => {
    expect(evaluateNoteLock({ ...base, claimedBy: 'card-1' })).toBeNull()
  })

  it('does not lock when nothing else holds the note', () => {
    expect(evaluateNoteLock(base)).toBeNull()
  })

  it('prefers the tab reason when both conditions hold', () => {
    expect(
      evaluateNoteLock({ ...base, visibleNoteTabIds: new Set(['n1']), claimedBy: 'card-2' })
    ).toBe('note-open-in-tab')
  })
})

describe('note card claims', () => {
  it('grants a free note to the first claimant and refuses the second', () => {
    const claims = createNoteCardClaims()
    expect(claims.claim('n1', 'card-1')).toBe(true)
    expect(claims.claim('n1', 'card-2')).toBe(false)
    expect(claims.claimedBy('n1')).toBe('card-1')
  })

  it('re-claiming by the same card is idempotent', () => {
    const claims = createNoteCardClaims()
    expect(claims.claim('n1', 'card-1')).toBe(true)
    expect(claims.claim('n1', 'card-1')).toBe(true)
  })

  it('releases only for the owner, then the note is claimable again', () => {
    const claims = createNoteCardClaims()
    claims.claim('n1', 'card-1')
    claims.release('n1', 'card-2')
    expect(claims.claimedBy('n1')).toBe('card-1')
    claims.release('n1', 'card-1')
    expect(claims.claimedBy('n1')).toBeNull()
    expect(claims.claim('n1', 'card-2')).toBe(true)
  })

  it('releasing an unclaimed note is a no-op', () => {
    const claims = createNoteCardClaims()
    expect(() => claims.release('n1', 'card-1')).not.toThrow()
    expect(claims.claimedBy('n1')).toBeNull()
  })

  it('keeps claims independent per note', () => {
    const claims = createNoteCardClaims()
    claims.claim('n1', 'card-1')
    expect(claims.claim('n2', 'card-2')).toBe(true)
    expect(claims.claimedBy('n1')).toBe('card-1')
  })
})
