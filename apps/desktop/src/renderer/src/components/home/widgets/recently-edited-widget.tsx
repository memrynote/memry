import type React from 'react'
import { useNotesList } from '@/hooks/use-notes-query'
import { useTabActions } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

export function RecentlyEditedWidget({ size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { notes, isLoading } = useNotesList({ sortBy: 'modified', sortOrder: 'desc' })
  const { openTab } = useTabActions()

  if (isLoading) return <div className="text-xs text-muted-foreground">{t('state.loading')}</div>

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
            className="w-full truncate text-start text-sm hover:underline"
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
            {n.title}
          </button>
        </li>
      ))}
    </ul>
  )
}
