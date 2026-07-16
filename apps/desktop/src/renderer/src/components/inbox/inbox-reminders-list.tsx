import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'

import {
  ChevronRight,
  CheckSquare,
  Calendar,
  FileText,
  Bell,
  Link2,
  Image,
  Mic,
  Video,
  Scissors,
  FilePdf,
  Share2
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatCompactRelativeTime } from '@/lib/inbox-utils'
import type { ReminderPanel, ReminderPanelEntry } from '@/lib/reminder-panel'

interface InboxRemindersListProps {
  panel: ReminderPanel
  onOpen: (entry: ReminderPanelEntry) => void
}

const ICON_CLASS = 'size-3.5 shrink-0 text-muted-foreground/60'

function EntryIcon({ entry }: { entry: ReminderPanelEntry }): React.JSX.Element {
  if (entry.kind === 'reminder-target') {
    switch (entry.nav.targetType) {
      case 'task':
        return <CheckSquare className={ICON_CLASS} />
      case 'journal':
        return <Calendar className={ICON_CLASS} />
      default:
        return <FileText className={ICON_CLASS} />
    }
  }
  switch (entry.item.type) {
    case 'link':
      return <Link2 className={ICON_CLASS} />
    case 'note':
      return <FileText className={ICON_CLASS} />
    case 'image':
      return <Image className={ICON_CLASS} />
    case 'voice':
      return <Mic className={ICON_CLASS} />
    case 'video':
      return <Video className={ICON_CLASS} />
    case 'clip':
      return <Scissors className={ICON_CLASS} />
    case 'pdf':
      return <FilePdf className={ICON_CLASS} />
    case 'social':
      return <Share2 className={ICON_CLASS} />
    default:
      return <Bell className={ICON_CLASS} />
  }
}

function entryTitle(entry: ReminderPanelEntry, fallback: string): string {
  if (entry.kind === 'reminder-target') {
    return entry.nav.targetTitle || fallback
  }
  return entry.item.title || fallback
}

function formatUpcoming(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

interface SectionProps {
  title: string
  count: number
  children: React.ReactNode
}

function Section({ title, count, children }: SectionProps): React.JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState(false)
  return (
    <section>
      <button
        type="button"
        onClick={() => setIsCollapsed((prev) => !prev)}
        className="flex items-center gap-1.5 w-full text-start py-2 px-2 cursor-pointer group"
      >
        <ChevronRight
          className={cn(
            'w-2.5 h-2.5 text-muted-foreground/40 transition-transform duration-200',
            !isCollapsed && 'rotate-90'
          )}
        />
        <span className="text-xs font-semibold tracking-[0.02em] text-muted-foreground">
          {title}
        </span>
        <span className="text-[11px] leading-[14px] text-muted-foreground/50 tabular-nums">
          {count}
        </span>
      </button>
      {!isCollapsed && <div className="space-y-px">{children}</div>}
    </section>
  )
}

interface ReminderRowProps {
  entry: ReminderPanelEntry
  isPast: boolean
  fallbackTitle: string
  onOpen: (entry: ReminderPanelEntry) => void
}

function ReminderRow({
  entry,
  isPast,
  fallbackTitle,
  onOpen
}: ReminderRowProps): React.JSX.Element {
  const title = entryTitle(entry, fallbackTitle)
  const time = isPast ? formatCompactRelativeTime(entry.time) : formatUpcoming(entry.time)

  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className={cn(
        'group flex w-full items-center gap-2.5 px-2 py-1.5 rounded-md text-start',
        'transition-colors duration-150 hover:bg-muted cursor-pointer'
      )}
    >
      <EntryIcon entry={entry} />
      <span
        className={cn(
          'grow min-w-0 truncate text-[13px] font-medium',
          isPast ? 'text-muted-foreground' : 'text-foreground/90'
        )}
      >
        {title}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">{time}</span>
    </button>
  )
}

export function InboxRemindersList({ panel, onOpen }: InboxRemindersListProps): React.JSX.Element {
  const { t } = useT('inbox')
  const { upcoming, past } = panel
  const fallbackTitle = t('list.untitledItem')

  return (
    <div className="p-2">
      <Section title={t('reminder.panelUpcoming')} count={upcoming.length}>
        {upcoming.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground/60">{t('reminder.panelEmpty')}</p>
        ) : (
          upcoming.map((entry) => (
            <ReminderRow
              key={entry.key}
              entry={entry}
              isPast={false}
              fallbackTitle={fallbackTitle}
              onOpen={onOpen}
            />
          ))
        )}
      </Section>

      {past.length > 0 && (
        <Section title={t('reminder.panelPast')} count={past.length}>
          {past.map((entry) => (
            <ReminderRow
              key={entry.key}
              entry={entry}
              isPast
              fallbackTitle={fallbackTitle}
              onOpen={onOpen}
            />
          ))}
        </Section>
      )}
    </div>
  )
}
