import { InboxChannels } from '@memry/contracts/ipc-channels'
import { subscribe } from '../lib/ipc'

export const inboxEvents = {
  /** Subscribe to the daily inbox review reminder firing */
  onInboxReviewDue: (callback: (event: { count: number }) => void): (() => void) =>
    subscribe<{ count: number }>(InboxChannels.events.REVIEW_DUE, callback),

  /** Subscribe to the review notification click — open the inbox */
  onInboxReviewOpen: (callback: () => void): (() => void) =>
    subscribe<unknown>(InboxChannels.events.REVIEW_OPEN, () => callback())
}
