import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { CalendarDays, CheckSquare, Loader2, RefreshCw, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { connectGoogleCalendarProvider } from '@/services/calendar-service'

export const GOOGLE_STATUS_QUERY_KEY = ['calendar', 'google', 'status'] as const

// ponytail: same brand mark as sync/oauth-buttons.tsx; a static G logo used twice
// isn't worth a shared component + extra import churn.
export function GoogleIcon(): React.JSX.Element {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

interface GoogleCalendarConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The OAuth hand-off shared by every "connect Google Calendar" entry point —
 * the calendar toolbar pill and the agent composer's connected-tools tray. It
 * owns the mutation so callers only decide when to open it; on success it
 * invalidates the status/sources/range queries, which is what makes the
 * prompting surfaces disappear.
 */
export function GoogleCalendarConnectDialog({
  open,
  onOpenChange
}: GoogleCalendarConnectDialogProps): React.JSX.Element {
  const { t } = useT('calendar')
  const queryClient = useQueryClient()

  const connectMutation = useMutation({
    mutationFn: async () => {
      const result = await connectGoogleCalendarProvider()
      if (!result.success) {
        throw new Error(result.error ?? t('connect-prompt.error'))
      }
      return result
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: GOOGLE_STATUS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['calendar', 'google', 'sources'] }),
        queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      ])
    }
  })

  const bullets = [
    { Icon: CalendarDays, text: t('connect-prompt.bullets.events') },
    { Icon: RefreshCw, text: t('connect-prompt.bullets.sync') },
    { Icon: CheckSquare, text: t('connect-prompt.bullets.schedule') }
  ]

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <DialogPrimitive.Content
            data-testid="google-calendar-connect-prompt"
            aria-label={t('connect-prompt.aria')}
            className={cn(
              'w-[420px] max-w-full rounded-md border bg-popover p-6',
              'text-popover-foreground shadow-lg outline-none'
            )}
          >
            <DialogPrimitive.Close
              className="absolute end-4 top-4 rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground"
              aria-label={t('connect-prompt.dismiss')}
            >
              <X className="size-4" />
            </DialogPrimitive.Close>

            <div className="mb-4 flex flex-col items-center text-center">
              <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted">
                <CalendarDays className="size-5 text-muted-foreground" />
              </div>
              <DialogPrimitive.Title className="text-lg font-semibold">
                {t('connect-prompt.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                {t('connect-prompt.body')}
              </DialogPrimitive.Description>
            </div>

            <ul className="mb-5 flex flex-col gap-3">
              {bullets.map(({ Icon, text }) => (
                <li key={text} className="flex items-center gap-3 text-sm text-foreground">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span>{text}</span>
                </li>
              ))}
            </ul>

            {connectMutation.error && (
              <p role="alert" className="mb-3 text-xs text-destructive">
                {extractErrorMessage(connectMutation.error, t('connect-prompt.error'))}
              </p>
            )}

            <Button
              type="button"
              className="w-full gap-2.5"
              disabled={connectMutation.isPending}
              onClick={() => connectMutation.mutate()}
            >
              {connectMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <GoogleIcon />
              )}
              {t('connect-prompt.continue')}
            </Button>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
