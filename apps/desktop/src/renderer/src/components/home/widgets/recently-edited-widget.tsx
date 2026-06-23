import type React from 'react'
import { useNotesList } from '@/hooks/use-notes-query'
import { useTabActions } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import { FileImage, FileText } from '@/lib/icons'
import { formatRelative } from '@/components/folder-view/note-card-pieces'
import { useT } from '@memry/i18n/renderer'

export function RecentlyEditedWidget({ size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { notes, isLoading, error } = useNotesList({ sortBy: 'modified', sortOrder: 'desc' })
  const { openTab } = useTabActions()

  if (isLoading)
    return (
      <div className="flex flex-col gap-1" aria-hidden="true">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )

  if (error)
    return (
      <div className="text-xs text-muted-foreground" title={extractErrorMessage(error)}>
        {t('home.widget.loadError')}
      </div>
    )

  if (notes.length === 0)
    return <div className="text-xs text-muted-foreground">{t('home.noNotesYet')}</div>

  return (
    <ul className="flex flex-col gap-1">
      {notes.slice(0, limit).map((n) => (
        <li key={n.id}>
          <button
            type="button"
            data-testid="recent-note"
            data-note-id={n.id}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-muted/60"
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
              <FileImage className="size-[15px] shrink-0 text-muted-foreground/70" />
            ) : (
              <FileText className="size-[15px] shrink-0 text-muted-foreground/70" />
            )}
            <span className="truncate text-[13px] font-medium text-foreground/90">{n.title}</span>
            <span className="flex-1" />
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
              {n.modified ? formatRelative(n.modified.toISOString()) : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
