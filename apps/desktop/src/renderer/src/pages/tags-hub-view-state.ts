/**
 * What a Tags hub tab remembers.
 *
 * Narrow on purpose. The categories, their order and every tag's placement are
 * the hub's DATA — owned by `useTagCategories` and written back through IPC.
 * The only thing the tab has to hold is the transient in-page search, which is
 * a lens over that data rather than part of it.
 */

export const TAGS_HUB_VIEW_STATE_KEYS = {
  /** In-page search text. */
  query: 'tagsHubQuery'
} as const

/** One scroller, so the unkeyed slot would do — named for readability. */
export const TAGS_HUB_SCROLL_KEY = 'tags-hub'

/**
 * Total, like every other view-state reader: an empty string is a real value
 * ("the user cleared the box") and is not the same as nothing stored.
 */
export const parseTagsHubQuery = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : undefined
