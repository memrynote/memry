import { useEffect, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { CalendarPicker } from './calendar-picker'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { setDefaultGoogleCalendar } from '@/services/calendar-service'
import { useGoogleCalendars } from '@/hooks/use-google-calendars'

export interface GoogleCalendarOnboardingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCompleted: () => void | Promise<void>
}

export function GoogleCalendarOnboardingDialog({
  open,
  onOpenChange,
  onCompleted
}: GoogleCalendarOnboardingDialogProps): React.JSX.Element | null {
  const { data, isLoading } = useGoogleCalendars(open)
  const [selected, setSelected] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && data?.primary) {
      setSelected((prev) => prev ?? data.primary!.id)
    }
  }, [open, data?.primary])

  async function persist(calendarId: string | null): Promise<void> {
    setIsSaving(true)
    setError(null)
    try {
      await setDefaultGoogleCalendar({ calendarId, markOnboardingComplete: true })
      await onCompleted()
      onOpenChange(false)
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save default calendar. Try again.'))
    } finally {
      setIsSaving(false)
    }
  }

  if (!open) return null

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-testid="google-calendar-onboarding-dialog"
          aria-label="Pick your default Google calendar"
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2',
            'rounded-md border bg-popover p-6 text-popover-foreground shadow-lg outline-none'
          )}
        >
          <DialogPrimitive.Title className="mb-1 text-lg font-semibold">
            Which calendar should new Memry events go to?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-4 text-sm text-muted-foreground">
            Pick the Google calendar Memry should use by default. You can still override it per
            event.
          </DialogPrimitive.Description>

          <CalendarPicker
            calendars={data?.calendars ?? []}
            value={selected}
            onChange={setSelected}
            isLoading={isLoading}
            disabled={isSaving}
            defaultOptionLabel="Use the Memry-managed calendar"
          />

          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void persist(null)}
              disabled={isSaving}
            >
              Skip
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void persist(selected)}
              disabled={isSaving || isLoading}
            >
              {isSaving ? 'Saving…' : 'Use this calendar'}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
