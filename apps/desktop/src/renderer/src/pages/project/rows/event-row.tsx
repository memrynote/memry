import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Calendar } from '@/lib/icons'
import type { ProjectLinkedEvent } from '@memry/rpc/tasks'
import { HubRow } from './hub-row'

interface EventRowProps {
  event: ProjectLinkedEvent
  /** Receives the whole event — the caller needs `startAt` to focus the day. */
  onOpen: (event: ProjectLinkedEvent) => void
}

export const EventRow = ({ event, onOpen }: EventRowProps): React.JSX.Element => {
  const { t, i18n } = useT('tasks')

  const when = useMemo(() => {
    const start = new Date(event.startAt)
    const date = new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric'
    }).format(start)
    if (event.isAllDay) return date
    const time = new Intl.DateTimeFormat(i18n.language, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(start)
    return `${date} · ${time}`
  }, [event.startAt, event.isAllDay, i18n.language])

  return (
    <HubRow
      leading={<Calendar className="size-4 text-muted-foreground" aria-hidden="true" />}
      onOpen={() => onOpen(event)}
      openLabel={t('projectHub.rows.openEvent', { title: event.title })}
      trailing={<span>{when}</span>}
    >
      <span className="truncate text-sm">{event.title}</span>
    </HubRow>
  )
}
