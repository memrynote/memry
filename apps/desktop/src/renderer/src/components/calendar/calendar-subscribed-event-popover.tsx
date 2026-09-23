import { useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'

import { Link } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { AnchorRect } from './types'
import { POPOVER_WIDTH, computePopoverPosition } from './popover-position'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const DAY_MS = 24 * 60 * 60 * 1000

interface SubscribedEventTarget {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
}

function whenLabel(item: CalendarProjectionItem, locale: string): string {
  const start = new Date(item.startAt)
  if (item.isAllDay) {
    // All-day items are stored at UTC midnight with an exclusive end.
    const format = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    })
    const lastDay = item.endAt ? new Date(new Date(item.endAt).getTime() - DAY_MS) : start
    return lastDay > start ? format.formatRange(start, lastDay) : format.format(start)
  }
  const format = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
  return item.endAt ? format.formatRange(start, new Date(item.endAt)) : format.format(start)
}

/**
 * Events from a subscribed feed have no write path, so selecting one shows
 * what it is and where it comes from instead of opening an editor.
 */
function SubscribedEventPopover({
  item,
  anchorRect,
  onDismiss
}: SubscribedEventTarget & { onDismiss: () => void }): React.JSX.Element {
  const { t, i18n } = useT('calendar')
  const containerRef = useRef<HTMLDivElement>(null)
  const { top, left } = computePopoverPosition(anchorRect, { estimatedHeight: 180 })

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return
      onDismiss()
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  const kindLabel = t('subscribedEvent.kind')

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={kindLabel}
      data-testid="calendar-subscribed-event-popover"
      style={{ position: 'fixed', top, left, width: POPOVER_WIDTH }}
      className={cn(
        'z-50 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg',
        'flex flex-col gap-3'
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Link className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {item.source.title ? `${kindLabel} · ${item.source.title}` : kindLabel}
          </span>
        </div>
        <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
        <p className="text-xs text-muted-foreground">{whenLabel(item, i18n.language)}</p>
        {item.descriptionPreview && (
          <p className="line-clamp-3 text-xs text-muted-foreground">{item.descriptionPreview}</p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t('subscribedEvent.readOnly')}</p>
    </div>
  )
}

/** Renders nothing until a subscribed event is selected. */
export function CalendarSubscribedEventPopover({
  target,
  onDismiss
}: {
  target: SubscribedEventTarget | null
  onDismiss: () => void
}): React.JSX.Element | null {
  return target ? <SubscribedEventPopover {...target} onDismiss={onDismiss} /> : null
}

export default CalendarSubscribedEventPopover
