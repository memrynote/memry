import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { POPOVER_WIDTH, computePopoverPosition } from './popover-position'
import type { AnchorRect, CalendarEventDraft } from './types'
import { getI18n } from 'react-i18next'

interface CalendarQuickCreateDialogProps {
  anchorRect: AnchorRect
  startAt: string
  endAt: string
  isAllDay: boolean
  onSave: (draft: CalendarEventDraft) => void | Promise<void>
  onDismiss: () => void
}

function formatTime(value: string): string {
  const date = new Date(value)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function parseDateValue(value: string): Date | null {
  const [year, month, day] = value.split('T')[0].split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function formatDateShort(value: string, locale: string): string {
  const date = parseDateValue(value)
  if (!date) return value
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)
}

function formatDatetimeDisplay(
  startAt: string,
  endAt: string,
  isAllDay: boolean,
  locale: string
): string {
  const startDate = startAt.split('T')[0]
  const endDate = endAt.split('T')[0]

  if (isAllDay) {
    const startLabel = formatDateShort(startAt, locale)
    if (startDate === endDate) return startLabel
    return `${startLabel} – ${formatDateShort(endAt, locale)}`
  }

  const year = startAt.split('-')[0]
  const startMonthDay = formatDateShort(startAt, locale)
  return `${startMonthDay}, ${year}  ${formatTime(startAt)} – ${formatTime(endAt)}`
}

export function CalendarQuickCreateDialog({
  anchorRect,
  startAt,
  endAt,
  isAllDay,
  onSave,
  onDismiss
}: CalendarQuickCreateDialogProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const { t, i18n } = useT('calendar')
  const { t: tCommon } = useT('common')

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  function buildDraft(): CalendarEventDraft {
    return {
      title,
      description: '',
      isAllDay,
      startAt,
      endAt,
      targetCalendarId: null,
      projectId: null
    }
  }

  async function submit(): Promise<void> {
    if (!title.trim() || isSubmitting) return
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      await onSave(buildDraft())
    } catch (error) {
      setErrorMessage(
        extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'calendar')('phaseI.errors.couldNotCreateEventTryAgain')
        )
      )
      setIsSubmitting(false)
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' && title.trim()) {
      void submit()
    }
  }

  const datetimeLabel = formatDatetimeDisplay(startAt, endAt, isAllDay, i18n.language)
  const { top, left } = computePopoverPosition(anchorRect)

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
      modal={false}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-testid="quick-create-popover"
          aria-label={t('form.create-calendar-event')}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            titleRef.current?.focus()
          }}
          className={cn(
            'fixed z-50 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none'
          )}
          style={{ top, left, width: POPOVER_WIDTH }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t('form.create-calendar-event')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('form.quick-create-description')}
          </DialogPrimitive.Description>
          <p className="mb-3 text-xs text-muted-foreground">{datetimeLabel}</p>

          <Input
            ref={titleRef}
            placeholder={t('form.new-event-placeholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            disabled={isSubmitting}
            className="mb-2"
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

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              disabled={isSubmitting}
            >
              {tCommon('button.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="quick-create-save"
              disabled={!title.trim() || isSubmitting}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                void submit()
              }}
              onClick={() => void submit()}
            >
              {isSubmitting ? tCommon('state.saving') : tCommon('button.save')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
