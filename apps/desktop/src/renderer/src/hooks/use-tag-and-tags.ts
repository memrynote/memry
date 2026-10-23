/**
 * Writer for a tag tab's ANDed tag selection.
 *
 * The selection is READ from the scope `TabContent` builds (see
 * `FOLDER_VIEW_STATE_KEYS.tagAndTags`), never mirrored into local component
 * state — the sidebar's Ctrl/Cmd-click writes the same tab view state from
 * outside the page, and a second copy would immediately go stale.
 *
 * @module hooks/use-tag-and-tags
 */

import { useCallback } from 'react'
import { useTabActionsOptional } from '@/contexts/tabs'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { FOLDER_VIEW_STATE_KEYS, parseTagAndTags } from '@/pages/folder-view-state'
import { sanitizeAndTags, tagKey, toggleAndTag } from '@/lib/tag-filter-selection'

export interface UseTagAndTagsResult {
  setAndTags: (next: string[]) => void
  toggleTag: (tag: string) => void
  clearAndTags: () => void
}

export function useTagAndTags(primaryTag: string, andTags: string[]): UseTagAndTagsResult {
  const identity = useTabIdentity()
  const actions = useTabActionsOptional()
  const dispatch = actions?.dispatch

  const setAndTags = useCallback(
    (next: string[]): void => {
      if (!identity || !dispatch) return
      dispatch({
        type: 'SAVE_TAB_STATE',
        payload: {
          tabId: identity.tabId,
          groupId: identity.groupId,
          viewState: {
            [FOLDER_VIEW_STATE_KEYS.tagAndTags]: sanitizeAndTags(primaryTag, next)
          }
        }
      })
    },
    [dispatch, identity, primaryTag]
  )

  const toggleTag = useCallback(
    (tag: string): void => setAndTags(toggleAndTag(primaryTag, andTags, tag)),
    [andTags, primaryTag, setAndTags]
  )

  const clearAndTags = useCallback((): void => setAndTags([]), [setAndTags])

  return { setAndTags, toggleTag, clearAndTags }
}

/**
 * Ctrl/Cmd-click from outside the page: toggle a tag in the ACTIVE tag tab's
 * AND filter.
 *
 * Returns false when the active tab is not a tag page (nothing to narrow) or
 * when the tag is that page's own primary tag, so the caller can fall back to
 * plain navigation instead of swallowing the click.
 */
export function useToggleTagOnActiveTagTab(): (tag: string) => boolean {
  const actions = useTabActionsOptional()
  const saveTabState = actions?.saveTabState
  const getActiveTabSnapshot = actions?.getActiveTabSnapshot

  return useCallback(
    (tag: string): boolean => {
      if (!saveTabState || !getActiveTabSnapshot) return false
      const tab = getActiveTabSnapshot()
      if (!tab || tab.type !== 'tag' || !tab.entityId) return false
      if (tagKey(tag) === tagKey(tab.entityId)) return false

      const current = parseTagAndTags(tab.viewState?.[FOLDER_VIEW_STATE_KEYS.tagAndTags]) ?? []
      saveTabState(tab.id, {
        viewState: {
          [FOLDER_VIEW_STATE_KEYS.tagAndTags]: toggleAndTag(tab.entityId, current, tag)
        }
      })
      return true
    },
    [getActiveTabSnapshot, saveTabState]
  )
}
