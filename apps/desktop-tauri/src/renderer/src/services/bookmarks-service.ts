/**
 * Bookmarks Service
 *
 * The bookmark commands of Step 30a (`commands/bookmarks.rs`) in the shapes of Electron's
 * `bookmarks:*` channels (`BookmarksClientAPI`): a write answers `{ success, ... }`, or
 * `{ success: false, error }` when the command refuses it.
 */

import type {
  Bookmark,
  BookmarkCreateResponse,
  BookmarkDeletedEvent,
  BookmarkListResponse,
  BookmarkToggleResponse,
  BookmarkWithItem,
  BookmarksClientAPI,
  BookmarksReorderedEvent
} from '@memry/contracts/bookmarks-api'
import {
  commands,
  events,
  type BookmarkListView,
  type BookmarkView,
  type BookmarkWithItemView
} from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { subscribeToEvent } from './tauri-event'

function toItem({ itemMeta, ...row }: BookmarkWithItemView): BookmarkWithItem {
  if (!itemMeta) return row
  return {
    ...row,
    itemMeta: {
      path: itemMeta.path ?? undefined,
      emoji: itemMeta.emoji ?? undefined,
      tags: itemMeta.tags ?? undefined
    }
  }
}

function toList(view: BookmarkListView): BookmarkListResponse {
  return { ...view, bookmarks: view.bookmarks.map(toItem) }
}

function refusal(error: unknown): string | undefined {
  return extractErrorMessage(error, '') || undefined
}

export const bookmarksService: BookmarksClientAPI = {
  async create(input) {
    try {
      return { success: true, bookmark: await commands.bookmarksCreate(input) }
    } catch (error) {
      return {
        success: false,
        bookmark: null,
        error: refusal(error)
      } satisfies BookmarkCreateResponse
    }
  },

  async delete(id) {
    try {
      await commands.bookmarksDelete(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: refusal(error) }
    }
  },

  get: (id) => commands.bookmarksGet(id),

  async list(options) {
    return toList(await commands.bookmarksList(options ?? {}))
  },

  isBookmarked: (input) => commands.bookmarksIsBookmarked(input),

  async toggle(input): Promise<BookmarkToggleResponse> {
    return { success: true, ...(await commands.bookmarksToggle(input)) }
  },

  async reorder(bookmarkIds) {
    try {
      await commands.bookmarksReorder(bookmarkIds)
      return { success: true }
    } catch (error) {
      return { success: false, error: refusal(error) }
    }
  },

  async listByType(itemType) {
    return toList(await commands.bookmarksListByType(itemType))
  },

  getByItem: (input) => commands.bookmarksGetByItem(input),

  async bulkDelete(bookmarkIds) {
    return { success: true, deletedCount: await commands.bookmarksBulkDelete(bookmarkIds) }
  },

  async bulkCreate(items) {
    return { success: true, createdCount: await commands.bookmarksBulkCreate(items) }
  }
}

/** A bookmark was made here. */
export function onBookmarkCreated(callback: (event: { bookmark: Bookmark }) => void): () => void {
  return subscribeToEvent<{ bookmark: BookmarkView }>(events.bookmarkCreatedEvent, callback)
}

/** A bookmark was removed here; the event names its item. */
export function onBookmarkDeleted(callback: (event: BookmarkDeletedEvent) => void): () => void {
  return subscribeToEvent(events.bookmarkDeletedEvent, callback)
}

export function onBookmarksReordered(
  callback: (event: BookmarksReorderedEvent) => void
): () => void {
  return subscribeToEvent(events.bookmarksReorderedEvent, callback)
}
