import type React from 'react'
import { useInboxList, useInboxStats } from '@/hooks/use-inbox-queries'
import { useTabActions } from '@/contexts/tabs/context'
import {
  computeInboxFooter,
  inboxWidgetLimit,
  resolveInboxFilter
} from '@/lib/home/inbox-widget-filter'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { ArrowRight } from '@/lib/icons/icon-map'
import { useT } from '@memry/i18n/renderer'

export function InboxWidgetFooter({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const { openTab } = useTabActions()
  const resolved = resolveInboxFilter(config)
  const { total } = useInboxList(resolved.kind === 'type' ? { type: resolved.type } : {})
  const { stats } = useInboxStats()
  const { olderCount, oldestDays } = computeInboxFooter({
    total,
    shown: inboxWidgetLimit(size),
    oldestDays: stats?.oldestItemDays ?? 0
  })

  return (
    <div className="flex items-center justify-between border-t px-4 py-2.5 text-[12px]">
      {olderCount > 0 ? (
        <span className="text-[var(--text-tertiary)]">
          {t('home.widget.inboxOlder', { count: olderCount })} ·{' '}
          {t('home.widget.inboxOldest', { count: oldestDays })}
        </span>
      ) : (
        <span />
      )}
      <button
        type="button"
        data-testid="inbox-triage"
        onClick={() =>
          openTab({
            type: 'inbox',
            title: t('home.widget.inbox'),
            icon: 'inbox',
            path: '/inbox',
            isPinned: false,
            isModified: false,
            isDeleted: false,
            isPreview: false
          })
        }
        className="inline-flex shrink-0 items-center gap-1 font-semibold text-[var(--tint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
      >
        {t('home.widget.triageInbox')}
        <ArrowRight className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
