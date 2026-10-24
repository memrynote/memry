import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { CalendarPicker } from './calendar-picker'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { setDefaultGoogleCalendar } from '@/services/calendar-service'
import { useGoogleCalendars } from '@/hooks/use-google-calendars'
import { getI18n } from 'react-i18next'

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
  const { t } = useT('calendar')
  const { t: tCommon } = useT('common')
  // User's pick (null = stay with whatever primary resolves to). When the
  // user hasn't touched the picker, we fall back to data.primary at render
  // time so the button reflects the preselected primary without an effect.
  const [override, setOverride] = useState<string | null | undefined>(undefined)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = override !== undefined ? override : (data?.primary?.id ?? null)

  async function persist(calendarId: string | null): Promise<void> {
    setIsSaving(true)
    setError(null)
    try {
      await setDefaultGoogleCalendar({ calendarId, markOnboardingComplete: true })
      await onCompleted()
      onOpenChange(false)
    } catch (err) {
      setError(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'calendar')('phaseI.errors.couldNotSaveDefaultCalendarTryAgain')
        )
      )
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
          aria-label={t('onboarding-dialog.aria')}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2',
            'rounded-md border bg-popover p-6 text-popover-foreground shadow-lg outline-none'
          )}
        >
          <DialogPrimitive.Title className="mb-1 text-lg font-semibold">
            {t('onboarding-dialog.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-4 text-sm text-muted-foreground">
            {t('onboarding-dialog.body')}
          </DialogPrimitive.Description>

          <CalendarPicker
            calendars={data?.calendars ?? []}
            value={selected}
            onChange={setOverride}
            isLoading={isLoading}
            disabled={isSaving}
            defaultOptionLabel={t('onboarding-dialog.default-calendar-label')}
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
              {t('onboarding-dialog.skip')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void persist(selected)}
              disabled={isSaving || isLoading}
            >
              {isSaving ? tCommon('state.saving') : t('onboarding-dialog.use-this-calendar')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
