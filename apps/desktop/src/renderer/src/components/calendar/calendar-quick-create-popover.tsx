import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'

interface CalendarQuickCreatePopoverProps {
  anchorRect: { x: number; y: number; width: number; height: number }
  startAt: string
  endAt: string
  isAllDay: boolean
  onSave: (draft: CalendarEventDraft) => void | Promise<void>
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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  function buildDraft(): CalendarEventDraft {
    return { title, description: '', location, isAllDay, startAt, endAt }
  }

  async function submit(): Promise<void> {
    if (!title.trim() || isSubmitting) return
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      await onSave(buildDraft())
    } catch (error) {
      setErrorMessage(extractErrorMessage(error, 'Could not create event. Try again.'))
      setIsSubmitting(false)
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' && title.trim()) {
      void submit()
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
          disabled={isSubmitting}
          className="mb-2"
        />

        <Input
          placeholder="Add location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          disabled={isSubmitting}
          className="mb-3"
        />

        {errorMessage && (
          <p
            data-testid="quick-create-error"
            role="alert"
            className="mb-3 text-xs text-destructive"
          >
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-between">
          <button
            type="button"
            className="text-xs text-primary underline-offset-2 hover:underline"
            onClick={() => onOpenFullEditor(buildDraft())}
          >
            Add details
          </button>

          <Button size="sm" disabled={!title.trim() || isSubmitting} onClick={() => void submit()}>
            {isSubmitting ? 'Saving…' : 'Save'}
          </Button>
        </div>

        <PopoverArrow />
      </PopoverContent>
    </Popover>
  )
}
