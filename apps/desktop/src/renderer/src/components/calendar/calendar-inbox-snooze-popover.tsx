import { useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { SnoozePicker } from '@/components/snooze/snooze-picker'
import { Inbox, Bell, Clock } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { AnchorRect } from './types'
import { POPOVER_WIDTH, computePopoverPosition } from './popover-position'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface CalendarInboxSnoozePopoverProps {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
  onOpenInInbox: (itemId: string) => void
  onUnsnooze: (itemId: string) => void | Promise<void>
  onReschedule: (itemId: string, snoozeUntil: string) => void | Promise<void>
  onDismiss: () => void
}

function isInsidePopperPortal(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('[data-radix-popper-content-wrapper], [role="dialog"]'))
}

export function CalendarInboxSnoozePopover({
  item,
  anchorRect,
  onOpenInInbox,
  onUnsnooze,
  onReschedule,
  onDismiss
}: CalendarInboxSnoozePopoverProps): React.JSX.Element {
  const { t } = useT('calendar')
  const containerRef = useRef<HTMLDivElement>(null)
  const { top, left } = computePopoverPosition(anchorRect, { estimatedHeight: 220 })

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current) return
      if (containerRef.current.contains(event.target as Node)) return
      // SnoozePicker's Radix DropdownMenu/Dialog render in a portal outside this
      // tree. Treat clicks on those as inside so the popover doesn't dismiss
      // mid-interaction.
      if (isInsidePopperPortal(event.target)) return
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

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t('phaseI.inboxSnoozePopover.title')}
      data-testid="calendar-inbox-snooze-popover"
      style={{ position: 'fixed', top, left, width: POPOVER_WIDTH }}
      className={cn(
        'z-50 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg',
        'flex flex-col gap-3'
      )}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
        {item.descriptionPreview ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{item.descriptionPreview}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => onOpenInInbox(item.sourceId)}
        >
          <Inbox className="me-2 h-4 w-4" />
          {t('phaseI.inboxSnoozePopover.openInInbox')}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => void onUnsnooze(item.sourceId)}
        >
          <Bell className="me-2 h-4 w-4" />
          {t('phaseI.inboxSnoozePopover.unsnoozeNow')}
        </Button>

        <SnoozePicker
          onSnooze={(snoozeUntil) => void onReschedule(item.sourceId, snoozeUntil)}
          trigger={
            <Button type="button" variant="ghost" size="sm" className="justify-start">
              <Clock className="me-2 h-4 w-4" />
              {t('phaseI.inboxSnoozePopover.reschedule')}
            </Button>
          }
        />
      </div>
    </div>
  )
}

export default CalendarInboxSnoozePopover
