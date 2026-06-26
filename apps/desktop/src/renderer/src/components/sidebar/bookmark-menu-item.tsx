/**
 * BookmarkMenuItem
 * A context-menu row that toggles a bookmark for any sidebar item
 * (note, folder, tag, …). Self-manages its state via useIsBookmarked, so it
 * only checks bookmark status when the menu it lives in is opened.
 */

import { Star } from '@/lib/icons'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useIsBookmarked } from '@/hooks/use-bookmarks'
import { useT } from '@memry/i18n/renderer'

interface BookmarkMenuItemProps {
  /** Bookmark item type (e.g. 'note', 'folder', 'tag') */
  itemType: string
  /** Id of the item to bookmark (note id, folder path, tag name) */
  itemId: string
}

export function BookmarkMenuItem({ itemType, itemId }: BookmarkMenuItemProps): React.JSX.Element {
  const { t } = useT('notes')
  const { isBookmarked, toggle } = useIsBookmarked(itemType, itemId)

  return (
    <ContextMenuItem onClick={() => void toggle()}>
      <Star className="me-2 h-4 w-4" />
      {isBookmarked ? t('tree.actions.removeFromBookmarks') : t('tree.actions.bookmark')}
    </ContextMenuItem>
  )
}

export default BookmarkMenuItem
