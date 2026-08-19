/**
 * What the Inbox tab remembers, and how it is read back.
 *
 * `Tab.viewState` is one flat `Record<string, unknown>` per tab, shared with the
 * one-shot navigation nonces other surfaces write into this tab
 * (`focusInboxItemId` / `focusedAt` / `focusCaptureAt`, consumed once through a
 * nonce guard). Everything the Inbox persists for itself therefore lives under
 * its own prefixed names, collected here so a collision is visible — and
 * testable — in one place.
 *
 * The values survive a session restore and can have been written by an older
 * build, so every reader is total: anything unrecognised returns `undefined`
 * and the caller falls back to its default.
 */

import type { InboxItemType } from '@memry/contracts/inbox-api'
import type { InboxView } from '@/components/inbox/inbox-segment-control'

/** Keys written by OTHER surfaces into an inbox tab. Never write these. */
export const INBOX_NAV_KEYS = ['focusInboxItemId', 'focusedAt', 'focusCaptureAt'] as const

export const INBOX_VIEW_STATE_KEYS = {
  /** Which sub-view is showing. */
  view: 'inboxView',
  /** Item types the list is filtered to, as an array — `viewState` is serialised. */
  typeFilter: 'inboxTypeFilter',
  /** Whether snoozed items and reminders are shown. */
  showSnoozed: 'inboxShowSnoozed',
  /** Item open in the list pane's detail panel. */
  detailItemId: 'inboxDetailItemId',
  /** Item open in the archived pane's own, independent detail panel. */
  archivedDetailItemId: 'inboxArchivedDetailItemId'
} as const

/**
 * The three panes each own a scroller, and a tab holds one scroll record, so
 * every pane stamps which one it is. Without that, opening Insights would drop
 * the list's offset onto it.
 */
export const INBOX_SCROLL_KEYS = {
  list: 'inbox-list',
  archived: 'inbox-archived',
  insights: 'inbox-insights'
} as const

const INBOX_VIEWS: InboxView[] = ['inbox', 'archived', 'insights']

export const INBOX_ITEM_TYPES: InboxItemType[] = [
  'link',
  'note',
  'image',
  'voice',
  'video',
  'clip',
  'pdf',
  'social',
  'reminder'
]

export const parseInboxView = (raw: unknown): InboxView | undefined =>
  typeof raw === 'string' && (INBOX_VIEWS as string[]).includes(raw)
    ? (raw as InboxView)
    : undefined

/** Unknown type names are dropped rather than rejecting the whole filter. */
export const parseTypeFilter = (raw: unknown): InboxItemType[] | undefined =>
  Array.isArray(raw)
    ? raw.filter(
        (value): value is InboxItemType =>
          typeof value === 'string' && (INBOX_ITEM_TYPES as string[]).includes(value)
      )
    : undefined

export const parseBoolean = (raw: unknown): boolean | undefined =>
  typeof raw === 'boolean' ? raw : undefined

/** `null` is a value here — it means "no item open", not "nothing stored". */
export const parseItemId = (raw: unknown): string | null | undefined =>
  raw === null || typeof raw === 'string' ? raw : undefined
