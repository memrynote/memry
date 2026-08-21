import type React from 'react'
import { useRecentlyOpened } from '@/hooks/use-recently-opened'
import { useTabActions } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import { FileImage, FileText } from '@/lib/icons'
import { formatRelative } from '@/components/folder-view/note-card-pieces'
import { extractFolderFromPath } from '@/components/notes-tree-utils'
import { WidgetRow, WidgetEmptyState } from './widget-list'
import { useT } from '@memry/i18n/renderer'

/**
 * Sibling of the "Recently edited" widget, for the notes you looked at but did
 * not change — those never surface anywhere else. A note you opened *and*
 * edited appears in both lists; the row meta ("opened …" vs "edited …") is
 * what tells the two apart.
 */
export function RecentlyOpenedWidget({ size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { items, isLoading, error } = useRecentlyOpened(limit)
  const { openTab } = useTabActions()

  if (isLoading)
    return (
      <div className="flex flex-col gap-0.5" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )

  if (error)
    return (
      <div className="text-xs text-destructive" role="alert" title={extractErrorMessage(error)}>
        {t('home.widget.loadError')}
      </div>
    )

  if (items.length === 0)
    return <WidgetEmptyState icon={FileText} label={t('home.widget.noRecentlyOpened')} />

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const folder = extractFolderFromPath(item.path)
        const time = formatRelative(item.openedAt)
        const meta = folder
          ? t('home.widget.openedMetaWithFolder', { folder, time })
          : t('home.widget.openedMeta', { time })
        return (
          <WidgetRow key={item.itemId}>
            <button
              type="button"
              data-testid="recently-opened-note"
              data-note-id={item.itemId}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-muted/60 active:bg-muted focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
              onClick={() =>
                openTab({
                  type: 'note',
                  title: item.title,
                  icon: 'file-text',
                  path: `/notes/${item.itemId}`,
                  entityId: item.itemId,
                  isPinned: false,
                  isModified: false,
                  isDeleted: false,
                  isPreview: true
                })
              }
            >
              {item.emoji ? (
                <span className="shrink-0 text-sm leading-none">{item.emoji}</span>
              ) : item.fileType === 'image' ? (
                <FileImage className="size-4 shrink-0 text-muted-foreground/70" />
              ) : (
                <FileText className="size-4 shrink-0 text-muted-foreground/70" />
              )}
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate text-[13px] font-medium leading-tight text-foreground/90">
                  {item.title}
                </span>
                <span className="truncate text-[11px] leading-tight text-text-tertiary">
                  {meta}
                </span>
              </span>
            </button>
          </WidgetRow>
        )
      })}
    </ul>
  )
}
