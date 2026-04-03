import type { InboxListInput } from '@/services/inbox-service'

export const DEFAULT_PAGE_SIZE = 50
export const ITEM_STALE_TIME = 30 * 1000
export const STATS_STALE_TIME = 60 * 1000

export const inboxKeys = {
  all: ['inbox'] as const,
  lists: () => [...inboxKeys.all, 'list'] as const,
  list: (options?: InboxListInput) => [...inboxKeys.lists(), options] as const,
  items: () => [...inboxKeys.all, 'items'] as const,
  item: (id: string) => [...inboxKeys.items(), id] as const,
  stats: () => [...inboxKeys.all, 'stats'] as const,
  patterns: () => [...inboxKeys.all, 'patterns'] as const,
  tags: () => [...inboxKeys.all, 'tags'] as const,
  snoozed: () => [...inboxKeys.all, 'snoozed'] as const,
  suggestions: (itemId: string) => [...inboxKeys.all, 'suggestions', itemId] as const,
  staleThreshold: () => [...inboxKeys.all, 'staleThreshold'] as const,
  archived: (options?: { search?: string }) => [...inboxKeys.all, 'archived', options] as const,
  filingHistory: () => [...inboxKeys.all, 'filingHistory'] as const
}
