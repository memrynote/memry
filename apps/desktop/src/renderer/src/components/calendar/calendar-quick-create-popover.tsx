import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'

interface CalendarQuickCreatePopoverProps {
  anchorRect: { x: number; y: number; width: number; height: number }
  startAt: string
  endAt: string
  isAllDay: boolean
  onSave: (draft: CalendarEventDraft) => void
  onDismiss: () => void
  onOpenFullEditor: (draft: CalendarEventDraft) => void
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

function formatTime(value: string): string {
  const date = new Date(value)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function formatDateShort(value: string): string {
  const parts = value.split('T')[0].split('-')
  const month = MONTH_NAMES[parseInt(parts[1], 10) - 1]
  const day = parseInt(parts[2], 10)
  return `${month} ${day}`
}

function formatDatetimeDisplay(startAt: string, endAt: string, isAllDay: boolean): string {
  const startDate = startAt.split('T')[0]
  const endDate = endAt.split('T')[0]

  if (isAllDay) {
    const startLabel = formatDateShort(startAt)
    if (startDate === endDate) return startLabel
    return `${startLabel} – ${formatDateShort(endAt)}`
  }

  const year = startAt.split('-')[0]
  const startMonthDay = formatDateShort(startAt)
  return `${startMonthDay}, ${year}  ${formatTime(startAt)} – ${formatTime(endAt)}`
}

export function CalendarQuickCreatePopover({
  anchorRect,
  startAt,
  endAt,
  isAllDay,
  onSave,
  onDismiss,
  onOpenFullEditor
}: CalendarQuickCreatePopoverProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  function buildDraft(): CalendarEventDraft {
    return { title, description: '', location, isAllDay, startAt, endAt }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' && title.trim()) {
      onSave(buildDraft())
    }
  }

  const datetimeLabel = formatDatetimeDisplay(startAt, endAt, isAllDay)

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: anchorRect.x,
            top: anchorRect.y,
            width: anchorRect.width,
            height: anchorRect.height,
            pointerEvents: 'none'
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        data-testid="quick-create-popover"
        className="w-72 p-4"
      >
        <p className="mb-3 text-xs text-muted-foreground">{datetimeLabel}</p>

        <Input
          ref={titleRef}
          placeholder="New Event"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleTitleKeyDown}
          className="mb-2"
        />

        <Input
          placeholder="Add location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="mb-3"
        />

        <div className="flex items-center justify-between">
          <button
            type="button"
            className="text-xs text-primary underline-offset-2 hover:underline"
            onClick={() => onOpenFullEditor(buildDraft())}
          >
            Add details
          </button>

          <Button size="sm" disabled={!title.trim()} onClick={() => onSave(buildDraft())}>
            Save
          </Button>
        </div>

        <PopoverArrow />
      </PopoverContent>
    </Popover>
  )
}
