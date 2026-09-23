import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useT } from '@memry/i18n/renderer'
import { calendarColorHex } from '@memry/contracts/calendar-colors'

import { X } from '@/lib/icons'

import { useAnchoredPopoverPosition } from './popover-position'
import { CalendarEventForm } from './calendar-event-form'
import { CALENDAR_CARD_CLASS, CARD_ICON_BUTTON_CLASS, CalendarCardHeader } from './calendar-card'
import type { AnchorRect, CalendarEventDraft } from './types'
import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'

export interface CalendarEventReadOnlyMetadata {
  attendees: CalendarAttendee[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  conferenceData: CalendarConferenceData | null
}

interface CalendarEventPopoverProps {
  anchorRect: AnchorRect
  mode: 'create' | 'edit'
  /** Saved event id; absent/null while the popover is drafting a new, unsaved event. */
  eventId?: string | null
  draft: CalendarEventDraft
  isSaving: boolean
  onDraftChange: (next: CalendarEventDraft) => void
  onSave: () => void | Promise<void>
  onDismiss: () => void
  /** M5: read-only rich metadata (attendees/reminders/visibility/Meet link) shown below the form. */
  readOnlyMetadata?: CalendarEventReadOnlyMetadata
}

const EVENT_POPOVER_WIDTH = 320

export function CalendarEventPopover({
  anchorRect,
  mode,
  eventId,
  draft,
  isSaving,
  onDraftChange,
  onSave,
  onDismiss,
  readOnlyMetadata
}: CalendarEventPopoverProps): React.JSX.Element {
  const { t } = useT('calendar')

  const position = useAnchoredPopoverPosition(anchorRect, {
    width: EVENT_POPOVER_WIDTH,
    estimatedHeight: 420
  })
  const title = mode === 'create' ? t('form.create-calendar-event') : t('form.edit-calendar-event')
  const dotColor = draft.color ? calendarColorHex(draft.color) : 'var(--cal-indigo-rail)'

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
          data-testid="event-edit-popover"
          aria-label={title}
          onOpenAutoFocus={(e) => {
            // The form focuses the title input itself on mount.
            e.preventDefault()
          }}
          onPointerDownOutside={(e) => {
            const target = e.target as HTMLElement | null
            if (target?.closest('[data-radix-popper-content-wrapper]')) {
              e.preventDefault()
            }
          }}
          onInteractOutside={(e) => {
            const target = e.target as HTMLElement | null
            if (target?.closest('[data-radix-popper-content-wrapper]')) {
              e.preventDefault()
            }
          }}
          className={CALENDAR_CARD_CLASS}
          ref={position.ref}
          style={position.style}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('form.event-editor-description')}
          </DialogPrimitive.Description>

          <CalendarCardHeader
            dotStyle={{ backgroundColor: dotColor }}
            label={mode === 'create' ? t('time.new-event') : t('event-card.kind')}
            actions={
              <DialogPrimitive.Close
                className={CARD_ICON_BUTTON_CLASS}
                aria-label={t('event-card.close')}
                title={t('event-card.close')}
              >
                <X className="size-3.5" />
              </DialogPrimitive.Close>
            }
          />

          <CalendarEventForm
            mode={mode}
            eventId={eventId}
            draft={draft}
            isSaving={isSaving}
            onDraftChange={onDraftChange}
            onSave={onSave}
            onDismiss={onDismiss}
            readOnlyMetadata={readOnlyMetadata}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export default CalendarEventPopover
