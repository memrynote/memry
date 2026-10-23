import type React from 'react'
import { useInboxList } from '@/hooks/use-inbox-queries'
import {
  INBOX_WIDGET_TYPES,
  resolveInboxFilter,
  type InboxWidgetType
} from '@/lib/home/inbox-widget-filter'
import type { WidgetComponentProps, WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { ChevronDown, Filter } from '@/lib/icons/icon-map'
import { useT } from '@memry/i18n/renderer'

const TYPE_LABEL_KEYS: Record<InboxWidgetType, string> = {
  link: 'type.link',
  note: 'type.note',
  image: 'type.image',
  voice: 'type.voice',
  clip: 'type.clip',
  pdf: 'type.pdf',
  social: 'type.social',
  reminder: 'type.reminder'
}

export function InboxHeaderFilter({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { t } = useT('common')
  const { t: tInbox } = useT('inbox')
  const resolved = resolveInboxFilter(config)
  const label =
    resolved.kind === 'type'
      ? tInbox(TYPE_LABEL_KEYS[resolved.type])
      : t('home.widget.inboxAllTypes')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-card px-2 text-[11px] font-semibold text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
        >
          <Filter className="size-3" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 text-[var(--text-tertiary)]" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onChange({ ...config, type: undefined })}>
          {t('home.widget.inboxAllTypes')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {INBOX_WIDGET_TYPES.map((type) => (
          <DropdownMenuItem key={type} onSelect={() => onChange({ ...config, type })}>
            {tInbox(TYPE_LABEL_KEYS[type])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function InboxHeaderCount({ config }: WidgetComponentProps): React.JSX.Element | null {
  const resolved = resolveInboxFilter(config)
  const { total, isLoading } = useInboxList(resolved.kind === 'type' ? { type: resolved.type } : {})
  if (isLoading) return null
  return (
    <span className="font-mono text-[11px] font-semibold text-[var(--text-tertiary)]">{total}</span>
  )
}
