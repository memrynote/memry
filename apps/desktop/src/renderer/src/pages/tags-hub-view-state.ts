/**
 * What a Tags hub tab remembers.
 *
 * Narrow on purpose. The categories, their order and every tag's placement are
 * the hub's DATA — owned by `useTagCategories` and written back through IPC.
 * The only things the tab has to hold are the transient in-page search and
 * which lens (categories or A-Z) the list is read through, both lenses over
 * that data rather than part of it.
 */

export const TAGS_HUB_VIEW_STATE_KEYS = {
  /** In-page search text. */
  query: 'tagsHubQuery',
  /** Which lens the list is shown through: `'categories'` or `'az'`. */
  view: 'tagsHubView'
} as const

export type TagsHubView = 'categories' | 'az'

export const DEFAULT_TAGS_HUB_VIEW: TagsHubView = 'categories'

/** One scroller, so the unkeyed slot would do — named for readability. */
export const TAGS_HUB_SCROLL_KEY = 'tags-hub'

/**
 * Total, like every other view-state reader: an empty string is a real value
 * ("the user cleared the box") and is not the same as nothing stored.
 */
export const parseTagsHubQuery = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : undefined

/**
 * Tab state written by an older build has no view, and a newer build may have
 * stored a view this one does not know; both fall back to the default instead
 * of failing.
 */
export const parseTagsHubView = (raw: unknown): TagsHubView | undefined =>
  raw === 'categories' || raw === 'az' ? raw : undefined
