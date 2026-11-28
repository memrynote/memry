import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Calendar } from '@/lib/icons'
import type { ProjectLinkedEvent } from '@memry/rpc/tasks'
import { HubRow, HUB_ROW_TITLE } from './hub-row'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { isHour12 } from '@/lib/time-format'

interface EventRowProps {
  event: ProjectLinkedEvent
  /** Receives the whole event — the caller needs `startAt` to focus the day. */
  onOpen: (event: ProjectLinkedEvent) => void
}

export const EventRow = ({ event, onOpen }: EventRowProps): React.JSX.Element => {
  const { t, i18n } = useT('tasks')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()

  const when = useMemo(() => {
    const start = new Date(event.startAt)
    const date = new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric'
    }).format(start)
    if (event.isAllDay) return date
    const time = new Intl.DateTimeFormat(i18n.language, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: isHour12(clockFormat)
    }).format(start)
    return `${date} · ${time}`
  }, [event.startAt, event.isAllDay, i18n.language, clockFormat])

  return (
    <HubRow
      leading={<Calendar className="size-4 text-muted-foreground" aria-hidden="true" />}
      onOpen={() => onOpen(event)}
      openLabel={t('projectHub.rows.openEvent', { title: event.title })}
      trailing={<span>{when}</span>}
    >
      <span className={HUB_ROW_TITLE}>{event.title}</span>
    </HubRow>
  )
}
