import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'

import { POPOVER_WIDTH, computePopoverPosition } from './popover-position'
import { CalendarEventForm } from './calendar-event-form'
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
  draft: CalendarEventDraft
  isSaving: boolean
  onDraftChange: (next: CalendarEventDraft) => void
  onSave: () => void | Promise<void>
  onDismiss: () => void
  /** M5: read-only rich metadata (attendees/reminders/visibility/Meet link) shown below the form. */
  readOnlyMetadata?: CalendarEventReadOnlyMetadata
}

export function CalendarEventPopover({
  anchorRect,
  mode,
  draft,
  isSaving,
  onDraftChange,
  onSave,
  onDismiss,
  readOnlyMetadata
}: CalendarEventPopoverProps): React.JSX.Element {
  const { t } = useT('calendar')

  const { top, left } = computePopoverPosition(anchorRect, { estimatedHeight: 440 })
  const title = mode === 'create' ? t('form.create-calendar-event') : t('form.edit-calendar-event')

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
          className={cn(
            'fixed z-50 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none'
          )}
          style={{ top, left, width: POPOVER_WIDTH }}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('form.event-editor-description')}
          </DialogPrimitive.Description>

          <CalendarEventForm
            mode={mode}
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
