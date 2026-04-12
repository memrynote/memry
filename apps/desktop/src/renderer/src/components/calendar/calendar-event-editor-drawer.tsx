import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

export interface CalendarEventDraft {
  title: string
  description: string
  location: string
  isAllDay: boolean
  startAt: string
  endAt: string
}

interface CalendarEventEditorDrawerProps {
  open: boolean
  mode: 'create' | 'edit'
  draft: CalendarEventDraft
  isSaving: boolean
  onClose: () => void
  onDraftChange: (draft: CalendarEventDraft) => void
  onSave: () => void
}

export function CalendarEventEditorDrawer({
  open,
  mode,
  draft,
  isSaving,
  onClose,
  onDraftChange,
  onSave
}: CalendarEventEditorDrawerProps): React.JSX.Element {
  const inputType = draft.isAllDay ? 'date' : 'datetime-local'

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader className="border-b border-border/70">
          <SheetTitle>{mode === 'create' ? 'New Event' : 'Edit Event'}</SheetTitle>
          <SheetDescription>
            {mode === 'create'
              ? 'Create a Memry calendar event.'
              : 'Update the event details stored in Memry.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="calendar-event-title">
              Title
            </label>
            <Input
              id="calendar-event-title"
              value={draft.title}
              onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="calendar-event-description">
              Description
            </label>
            <Textarea
              id="calendar-event-description"
              value={draft.description}
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="calendar-event-location">
              Location
            </label>
            <Input
              id="calendar-event-location"
              value={draft.location}
              onChange={(event) => onDraftChange({ ...draft, location: event.target.value })}
            />
          </div>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-border/70 px-3 py-3 text-sm text-foreground">
            <span>All day</span>
            <input
              type="checkbox"
              checked={draft.isAllDay}
              onChange={(event) => {
                if (event.target.checked) {
                  onDraftChange({
                    ...draft,
                    isAllDay: true,
                    startAt: draft.startAt.slice(0, 10),
                    endAt: draft.endAt ? draft.endAt.slice(0, 10) : draft.startAt.slice(0, 10)
                  })
                  return
                }

                const startDate = draft.startAt || new Date().toISOString().slice(0, 10)
                const endDate = draft.endAt || startDate
                onDraftChange({
                  ...draft,
                  isAllDay: false,
                  startAt: `${startDate}T09:00`,
                  endAt: `${endDate}T10:00`
                })
              }}
            />
          </label>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="calendar-event-start">
              Start
            </label>
            <Input
              id="calendar-event-start"
              type={inputType}
              value={draft.startAt}
              onChange={(event) => onDraftChange({ ...draft, startAt: event.target.value })}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="calendar-event-end">
              End
            </label>
            <Input
              id="calendar-event-end"
              type={inputType}
              value={draft.endAt}
              onChange={(event) => onDraftChange({ ...draft, endAt: event.target.value })}
            />
          </div>
        </div>

        <SheetFooter className="border-t border-border/70">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="button" onClick={onSave} disabled={isSaving || draft.title.trim().length === 0}>
            {isSaving ? 'Saving...' : mode === 'create' ? 'Create Event' : 'Save Changes'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export default CalendarEventEditorDrawer
