import type React from 'react'
import { useNotesList } from '@/hooks/use-notes-query'
import { useTabActions } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import { FileImage, FileText } from '@/lib/icons'
import { formatRelative } from '@/components/folder-view/note-card-pieces'
import { extractFolderFromPath } from '@/components/notes-tree-utils'
import { WidgetRow, WidgetEmptyState } from './widget-list'
import { useT } from '@memry/i18n/renderer'

export function RecentlyEditedWidget({ size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { notes, isLoading, error } = useNotesList({ sortBy: 'modified', sortOrder: 'desc' })
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

  if (notes.length === 0) return <WidgetEmptyState icon={FileText} label={t('home.noNotesYet')} />

  return (
    <ul className="flex flex-col gap-0.5">
      {notes.slice(0, limit).map((n) => {
        const folder = extractFolderFromPath(n.path)
        const time = n.modified ? formatRelative(n.modified.toISOString()) : ''
        const meta = folder
          ? t('home.widget.recentMetaWithFolder', { folder, time })
          : t('home.widget.recentMeta', { time })
        return (
          <WidgetRow key={n.id}>
            <button
              type="button"
              data-testid="recent-note"
              data-note-id={n.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-muted/60 active:bg-muted focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
              onClick={() =>
                openTab({
                  type: 'note',
                  title: n.title,
                  icon: 'file-text',
                  path: `/notes/${n.id}`,
                  entityId: n.id,
                  isPinned: false,
                  isModified: false,
                  isDeleted: false,
                  isPreview: true
                })
              }
            >
              {n.emoji ? (
                <span className="shrink-0 text-sm leading-none">{n.emoji}</span>
              ) : n.fileType === 'image' ? (
                <FileImage className="size-4 shrink-0 text-muted-foreground/70" />
              ) : (
                <FileText className="size-4 shrink-0 text-muted-foreground/70" />
              )}
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate text-[13px] font-medium leading-tight text-foreground/90">
                  {n.title}
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
