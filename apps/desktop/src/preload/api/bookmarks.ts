import { BookmarksChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'

export const bookmarksApi = {
  create: (input: { itemType: string; itemId: string }) =>
    invoke(BookmarksChannels.invoke.CREATE, input),
  delete: (id: string) => invoke(BookmarksChannels.invoke.DELETE, id),
  get: (id: string) => invoke(BookmarksChannels.invoke.GET, id),
  list: (options?: {
    itemType?: string
    sortBy?: 'position' | 'createdAt'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }) => invoke(BookmarksChannels.invoke.LIST, options ?? {}),
  isBookmarked: (input: { itemType: string; itemId: string }) =>
    invoke(BookmarksChannels.invoke.IS_BOOKMARKED, input),
  toggle: (input: { itemType: string; itemId: string }) =>
    invoke(BookmarksChannels.invoke.TOGGLE, input),
  reorder: (bookmarkIds: string[]) => invoke(BookmarksChannels.invoke.REORDER, { bookmarkIds }),
  listByType: (itemType: string) => invoke(BookmarksChannels.invoke.LIST_BY_TYPE, itemType),
  getByItem: (input: { itemType: string; itemId: string }) =>
    invoke(BookmarksChannels.invoke.GET_BY_ITEM, input),
  bulkDelete: (bookmarkIds: string[]) =>
    invoke(BookmarksChannels.invoke.BULK_DELETE, { bookmarkIds }),
  bulkCreate: (items: Array<{ itemType: string; itemId: string }>) =>
    invoke(BookmarksChannels.invoke.BULK_CREATE, { items })
}

export const bookmarkEvents = {
  onBookmarkCreated: (
    callback: (event: { bookmark?: unknown; id?: string }) => void
  ): (() => void) =>
    subscribe<{ bookmark?: unknown; id?: string }>(BookmarksChannels.events.CREATED, callback),

  /**
   * Emitted only by the sync handler, when an inbound merge changed an existing
   * bookmark row (a reorder done on another device). Payload is `{ id }`.
   */
  onBookmarkUpdated: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(BookmarksChannels.events.UPDATED, callback),

  onBookmarkDeleted: (
    callback: (event: { id: string; itemType?: string; itemId?: string }) => void
  ): (() => void) =>
    subscribe<{ id: string; itemType?: string; itemId?: string }>(
      BookmarksChannels.events.DELETED,
      callback
    ),

  onBookmarksReordered: (callback: (event: { bookmarkIds: string[] }) => void): (() => void) =>
    subscribe<{ bookmarkIds: string[] }>(BookmarksChannels.events.REORDERED, callback)
}
