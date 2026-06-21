import type React from 'react'
import { useBookmarks } from '@/hooks/use-bookmarks'
import { useTabActions } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { useT } from '@memry/i18n/renderer'

export function BookmarksWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const itemType = typeof config.itemType === 'string' ? config.itemType : undefined
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { bookmarks, isLoading, error } = useBookmarks({ itemType })
  const { openTab } = useTabActions()

  if (isLoading)
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )

  if (error)
    return <div className="text-xs text-muted-foreground">{t('home.widget.loadError')}</div>

  if (bookmarks.length === 0)
    return <div className="text-xs text-muted-foreground">{t('home.noBookmarksYet')}</div>

  return (
    <ul className="flex flex-col gap-1">
      {bookmarks.slice(0, limit).map((b) => (
        <li key={b.id}>
          <button
            type="button"
            data-testid="bookmark-item"
            data-item-id={b.itemId}
            data-item-type={b.itemType}
            className="w-full truncate rounded-md px-2 py-1 text-start text-sm hover:bg-muted/60"
            onClick={() =>
              openTab(
                b.itemType === 'task'
                  ? {
                      type: 'tasks',
                      title: b.itemTitle ?? t('home.widget.untitled'),
                      icon: 'check-square',
                      path: '/tasks',
                      entityId: b.itemId,
                      isPinned: false,
                      isModified: false,
                      isDeleted: false,
                      isPreview: true
                    }
                  : {
                      type: 'note',
                      title: b.itemTitle ?? t('home.widget.untitled'),
                      icon: 'file-text',
                      path: `/notes/${b.itemId}`,
                      entityId: b.itemId,
                      isPinned: false,
                      isModified: false,
                      isDeleted: false,
                      isPreview: true
                    }
              )
            }
          >
            {b.itemTitle ?? t('home.widget.untitled')}
          </button>
        </li>
      ))}
    </ul>
  )
}
