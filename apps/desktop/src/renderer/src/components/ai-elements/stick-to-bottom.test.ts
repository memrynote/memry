/**
 * jsdom reports `scrollHeight` as 0 and `scrollTop` as a plain writable number,
 * so "did the transcript end up at the bottom" is not a question this
 * environment can answer. These tests drive the decision instead.
 */

import { describe, expect, it } from 'vitest'

import {
  BOTTOM_THRESHOLD_PX,
  conversationScrollAction,
  isAtBottom,
  parseConversationScroll,
  scrollStateFor
} from './stick-to-bottom'

const metrics = (
  scrollTop: number
): { scrollTop: number; scrollHeight: number; clientHeight: number } => ({
  scrollTop,
  scrollHeight: 2000,
  clientHeight: 500
})

/** The exact bottom of the scroller modelled above. */
const BOTTOM = 1500

describe('isAtBottom', () => {
  it('counts the exact end as the bottom', () => {
    expect(isAtBottom(metrics(BOTTOM))).toBe(true)
  })

  it('tolerates the last row being a hair short of flush', () => {
    // Sub-pixel rounding means an exact comparison never holds, and a reader
    // one pixel off the end has not scrolled up.
    expect(isAtBottom(metrics(BOTTOM - BOTTOM_THRESHOLD_PX))).toBe(true)
  })

  it('treats a deliberate scroll up as not at the bottom', () => {
    expect(isAtBottom(metrics(BOTTOM - BOTTOM_THRESHOLD_PX - 1))).toBe(false)
    expect(isAtBottom(metrics(0))).toBe(false)
  })
})

describe('scrollStateFor', () => {
  it('stores a policy at the bottom and a position above it', () => {
    expect(scrollStateFor(metrics(BOTTOM))).toBe('bottom')
    expect(scrollStateFor(metrics(300))).toBe(300)
  })

  it('stores the top as a position, not as "nothing"', () => {
    // Scrolling all the way up to re-read the start of a conversation is the
    // clearest possible "stop following the stream".
    expect(scrollStateFor(metrics(0))).toBe(0)
  })
})

describe('conversationScrollAction', () => {
  it('sticks to the bottom on a first open', () => {
    expect(conversationScrollAction({ stored: null, restored: false })).toEqual({ kind: 'stick' })
  })

  it('keeps sticking while the reader is at the bottom', () => {
    // Live streaming: every token re-renders the transcript and must keep the
    // newest message in view.
    expect(conversationScrollAction({ stored: 'bottom', restored: false })).toEqual({
      kind: 'stick'
    })
    expect(conversationScrollAction({ stored: 'bottom', restored: true })).toEqual({
      kind: 'stick'
    })
  })

  it('restores a scrolled-up position on the way into the tab', () => {
    expect(conversationScrollAction({ stored: 420, restored: false })).toEqual({
      kind: 'restore',
      offset: 420
    })
  })

  it('stops touching the scroller once the reader is parked', () => {
    // The bug this replaces: an unconditional jump to the bottom on every
    // children change hauled the reader down mid-sentence on every token.
    expect(conversationScrollAction({ stored: 420, restored: true })).toEqual({ kind: 'none' })
  })

  it('restores a stored `0`, which truthiness would have thrown away', () => {
    expect(conversationScrollAction({ stored: 0, restored: false })).toEqual({
      kind: 'restore',
      offset: 0
    })
  })
})

describe('parseConversationScroll', () => {
  it('accepts the policy, a position, and "never scrolled"', () => {
    expect(parseConversationScroll('bottom')).toBe('bottom')
    expect(parseConversationScroll(420)).toBe(420)
    expect(parseConversationScroll(0)).toBe(0)
    expect(parseConversationScroll(null)).toBeNull()
  })

  it('rejects what an older or broken build could have written', () => {
    expect(parseConversationScroll(undefined)).toBeUndefined()
    expect(parseConversationScroll('top')).toBeUndefined()
    expect(parseConversationScroll(-1)).toBeUndefined()
    expect(parseConversationScroll(Number.NaN)).toBeUndefined()
    expect(parseConversationScroll({ offset: 420 })).toBeUndefined()
  })
})
