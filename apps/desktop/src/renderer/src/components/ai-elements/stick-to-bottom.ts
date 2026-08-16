/**
 * What an agent transcript remembers, and what it does with it.
 *
 * The transcript is the one surface where plain restore is the WRONG answer.
 * A conversation grows from the bottom while it streams, so "the offset you
 * left" stops meaning anything the moment another token arrives — a reader
 * sitting at the newest message would be left further and further above it.
 * What the user actually wants remembered is a POLICY:
 *
 * - at the bottom  → stay at the bottom, including through streaming
 * - scrolled up    → stay exactly there, and stop being dragged down
 *
 * That is why this is the documented exception in
 * `hooks/use-tab-auto-position.ts`: sticking to the bottom is auto-positioning,
 * and here it is also a thing the tab can store. The rule itself still holds —
 * a stored numeric offset (the user having scrolled up) beats it, exactly like
 * a stored offset beats auto-positioning everywhere else.
 */

/** Tab `viewState` key. Entity-stamped, so one tab reused for another
 * conversation does not inherit the previous transcript's position. */
export const AGENT_CONVERSATION_SCROLL_KEY = 'agentConversationScroll'

/**
 * How close to the end still counts as "at the bottom". Sub-pixel rounding and
 * a partially visible last row mean an exact comparison never holds, and a
 * reader one pixel off the end has not scrolled up.
 */
export const BOTTOM_THRESHOLD_PX = 24

/** `'bottom'` is a policy, a number is a position. */
export type ConversationScrollState = 'bottom' | number

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Total: `viewState` survives a restore and can have been written by an older
 * build. `null` is a value — "this tab has never been scrolled" — and is what
 * lets a first open stick to the bottom without claiming the user asked for it.
 */
export function parseConversationScroll(raw: unknown): ConversationScrollState | null | undefined {
  if (raw === null) return null
  if (raw === 'bottom') return 'bottom'
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  return undefined
}

export function isAtBottom(metrics: ScrollMetrics): boolean {
  const distance = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop
  return distance <= BOTTOM_THRESHOLD_PX
}

/** What the user's current position means, as something worth storing. */
export function scrollStateFor(metrics: ScrollMetrics): ConversationScrollState {
  return isAtBottom(metrics) ? 'bottom' : metrics.scrollTop
}

export type ConversationScrollAction =
  { kind: 'stick' } | { kind: 'restore'; offset: number } | { kind: 'none' }

export interface ConversationScrollInput {
  /** The live policy: what is stored, updated the moment the user scrolls. */
  stored: ConversationScrollState | null
  /** Whether the stored offset has already been applied, or overridden. */
  restored: boolean
}

/**
 * Decided on every re-render of the transcript — which, while a turn is
 * running, is once per streamed token.
 *
 * `none` is the whole point of the exception: once the user is parked at an
 * offset, every subsequent token must leave the scroller alone. The previous
 * behaviour was an unconditional jump to the bottom on every children change,
 * with no notion of the user having scrolled at all.
 */
export function conversationScrollAction({
  stored,
  restored
}: ConversationScrollInput): ConversationScrollAction {
  if (stored === null || stored === 'bottom') return { kind: 'stick' }
  if (restored) return { kind: 'none' }
  return { kind: 'restore', offset: stored }
}
