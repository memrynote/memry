import type React from 'react'
import type { InboxListInput } from '@memry/rpc/inbox'
import { useInboxList } from '@/hooks/use-inbox-queries'
import { useArchiveInboxItem } from '@/hooks/use-inbox-mutations'
import { useTabActions } from '@/contexts/tabs/context'
import { Archive } from '@/lib/icons/icon-map'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

// Triage decision: Archive only. useFileInboxItem requires a destination
// (folder path / noteId) that has no sensible default in a config-less widget —
// filing needs the picker UI from the full Inbox page. Archive is a clean
// one-call mutation (mutate(id)) and is the safe quick-triage action here.

export function InboxWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const { t: tInbox } = useT('inbox')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const type = typeof config.type === 'string' ? (config.type as InboxListInput['type']) : undefined
  const { items, isLoading, error } = useInboxList(type ? { type } : {})
  const { openTab } = useTabActions()
  const archive = useArchiveInboxItem()

  if (isLoading)
    return (
      <ul className="flex flex-col gap-1" aria-busy="true" aria-label={t('state.loading')}>
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i} className="flex items-center gap-1">
            <Skeleton className="h-4 w-full" />
          </li>
        ))}
      </ul>
    )

  if (error)
    return (
      <div className="text-xs text-destructive" role="alert">
        {extractErrorMessage(error, t('home.widget.loadError'))}
      </div>
    )

  if (items.length === 0)
    return <div className="text-xs text-muted-foreground">{tInbox('empty.noItemsYet')}</div>

  return (
    <ul className="flex flex-col gap-1">
      {items.slice(0, limit).map((item) => (
        <li key={item.id} className="flex items-center gap-1">
          <button
            type="button"
            data-testid="inbox-item"
            data-inbox-id={item.id}
            data-inbox-type={item.type}
            className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-start text-sm hover:bg-muted/60"
            onClick={() =>
              openTab({
                type: 'inbox',
                title: item.title || t('home.widget.untitled'),
                icon: 'inbox',
                path: '/inbox',
                entityId: item.id,
                viewState: { focusInboxItemId: item.id },
                isPinned: false,
                isModified: false,
                isDeleted: false,
                isPreview: true
              })
            }
          >
            {item.title || t('home.widget.untitled')}
          </button>
          <button
            type="button"
            data-testid="inbox-archive"
            aria-label={tInbox('triage.action.archive')}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={() => archive.mutate(item.id)}
          >
            <Archive className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}
