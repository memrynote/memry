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

/**
 * The menu-item shape this row can render as. Radix items read their own
 * menu's context, so a `ContextMenuItem` placed inside a DropdownMenu throws —
 * which is why the surrounding menu picks the component instead of this file
 * hard-coding one.
 */
type BookmarkMenuItemComponent = React.ComponentType<{
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  children?: React.ReactNode
}>

interface BookmarkMenuItemProps {
  /** Bookmark item type (e.g. 'note', 'folder', 'tag') */
  itemType: string
  /** Id of the item to bookmark (note id, folder path, tag name) */
  itemId: string
  /** Defaults to the context-menu item, which is where this row started life. */
  component?: BookmarkMenuItemComponent
}

export function BookmarkMenuItem({
  itemType,
  itemId,
  component: Item = ContextMenuItem
}: BookmarkMenuItemProps): React.JSX.Element {
  const { t } = useT('notes')
  const { isBookmarked, toggle } = useIsBookmarked(itemType, itemId)

  return (
    <Item onClick={() => void toggle()}>
      <Star className="me-2 h-4 w-4" />
      {isBookmarked ? t('tree.actions.removeFromBookmarks') : t('tree.actions.bookmark')}
    </Item>
  )
}

export default BookmarkMenuItem
