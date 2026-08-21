import type React from 'react'
import type { InboxListInput } from '@memry/rpc/inbox'
import { useInboxList } from '@/hooks/use-inbox-queries'
import { useArchiveInboxItem } from '@/hooks/use-inbox-mutations'
import { useTabActions } from '@/contexts/tabs/context'
import { Archive, Inbox } from '@/lib/icons/icon-map'
import { Skeleton } from '@/components/ui/skeleton'
import { InboxTypeIcon } from '@/components/inbox/inbox-type-icon'
import { formatTimeAgo } from '@/services/inbox-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { inboxWidgetLimit } from '@/lib/home/inbox-widget-filter'
import { WidgetRow, WidgetEmptyState } from './widget-list'
import type { InboxItemType } from '@/types'
import { useT } from '@memry/i18n/renderer'

// Triage decision: Archive only. useFileInboxItem requires a destination
// (folder path / noteId) that has no sensible default in a config-less widget —
// filing needs the picker UI from the full Inbox page. Archive is a clean
// one-call mutation (mutate(id)) and is the safe quick-triage action here.

export function InboxWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const { t: tInbox } = useT('inbox')
  const limit = inboxWidgetLimit(size)
  const type = typeof config.type === 'string' ? (config.type as InboxListInput['type']) : undefined
  const { items, isLoading, error } = useInboxList(type ? { type } : {})
  const { openTab } = useTabActions()
  const archive = useArchiveInboxItem()

  const typeLabels: Record<InboxItemType, string> = {
    link: tInbox('type.link'),
    note: tInbox('type.note'),
    image: tInbox('type.image'),
    voice: tInbox('type.voice'),
    video: tInbox('type.video'),
    clip: tInbox('type.clip'),
    pdf: tInbox('type.pdf'),
    social: tInbox('type.social'),
    reminder: tInbox('type.reminder')
  }

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
    return <WidgetEmptyState icon={Inbox} label={tInbox('empty.noItemsYet')} />

  return (
    <ul className="flex flex-col gap-0.5">
      {items.slice(0, limit).map((item) => (
        <WidgetRow key={item.id} className="group/row flex items-center gap-1">
          <button
            type="button"
            data-testid="inbox-item"
            data-inbox-id={item.id}
            data-inbox-type={item.type}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-muted/60 active:bg-muted focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
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
            <span className="sr-only">{typeLabels[item.type]}</span>
            <InboxTypeIcon type={item.type} className="shrink-0" />
            {item.thumbnailUrl && (
              <img
                src={item.thumbnailUrl}
                alt=""
                loading="lazy"
                className="size-7 shrink-0 rounded-md object-cover ring-1 ring-border/50"
              />
            )}
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
              {item.title || t('home.widget.untitled')}
            </span>
            <span className="shrink-0 text-[11px] text-text-tertiary tabular-nums">
              {formatTimeAgo(item.createdAt)}
            </span>
          </button>
          {/* Quick action reveals on row hover/focus — keeps rows calm at rest, still keyboard-reachable. */}
          <button
            type="button"
            data-testid="inbox-archive"
            aria-label={tInbox('quickActions.archiveItem')}
            className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:bg-muted/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)] motion-safe:active:scale-90"
            onClick={() => archive.mutate(item.id)}
          >
            <Archive className="size-3.5" />
          </button>
        </WidgetRow>
      ))}
    </ul>
  )
}
