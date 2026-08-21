import type React from 'react'
import { useBookmarks } from '@/hooks/use-bookmarks'
import { useTabActions } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { CheckSquare, FileText, BookOpen, Bookmark } from '@/lib/icons/icon-map'
import { WidgetRow, WidgetEmptyState } from './widget-list'
import { useT } from '@memry/i18n/renderer'

const ICON_BY_TYPE: Record<string, typeof FileText> = {
  task: CheckSquare,
  note: FileText,
  journal: BookOpen
}

export function BookmarksWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const itemType = typeof config.itemType === 'string' ? config.itemType : undefined
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { bookmarks, isLoading, error } = useBookmarks({ itemType })
  const { openTab } = useTabActions()

  if (isLoading)
    return (
      <div className="flex flex-col gap-1" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )

  if (error)
    return (
      <div className="text-xs text-destructive" role="alert">
        {t('home.widget.loadError')}
      </div>
    )

  if (bookmarks.length === 0)
    return <WidgetEmptyState icon={Bookmark} label={t('home.noBookmarksYet')} />

  return (
    <ul className="flex flex-col gap-0.5">
      {bookmarks.slice(0, limit).map((b) => {
        const Icon = ICON_BY_TYPE[b.itemType] ?? FileText
        const typeLabel = b.itemType.charAt(0).toUpperCase() + b.itemType.slice(1)
        return (
          <WidgetRow key={b.id}>
            <button
              type="button"
              data-testid="bookmark-item"
              data-item-id={b.itemId}
              data-item-type={b.itemType}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-[13px] hover:bg-muted/60 active:bg-muted focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
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
              <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              <span className="sr-only">{typeLabel}</span>
              <span className="truncate font-medium text-foreground/90">
                {b.itemTitle ?? t('home.widget.untitled')}
              </span>
            </button>
          </WidgetRow>
        )
      })}
    </ul>
  )
}
