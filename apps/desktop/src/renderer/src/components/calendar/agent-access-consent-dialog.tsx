import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useT } from '@memry/i18n/renderer'
import { GOOGLE_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import { Button } from '@/components/ui/button'
import { useAgentAccessConsent } from '@/hooks/use-agent-access-consent'
import { cn } from '@/lib/utils'

export interface AgentAccessConsentDialogProps {
  /** Providers this vault has calendars from. No calendars, no question. */
  providerIds: string[]
}

/**
 * Asked once per provider (#1394), the first time a user with calendars from
 * it opens the calendar. For Google this is the Workspace Limited Use prompt,
 * with its original copy. Both buttons are an answer —
 * there is no dismiss, and Escape/outside clicks are suppressed, because an
 * unanswered prompt is exactly what makes us ask again on the next visit.
 *
 * Owns its consent state instead of taking it as props: nothing else drives
 * this dialog, and the calendar page is already at its line budget.
 */
export function AgentAccessConsentDialog({
  providerIds
}: AgentAccessConsentDialogProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const { promptProvider, isSaving, error, decide } = useAgentAccessConsent(providerIds)

  if (!promptProvider) return null

  const providerName =
    promptProvider === 'ics'
      ? t('agent-access-dialog.provider-names.ics')
      : promptProvider === 'caldav'
        ? t('agent-access-dialog.provider-names.caldav')
        : promptProvider === 'apple-eventkit'
          ? t('agent-access-dialog.provider-names.apple-eventkit')
          : promptProvider
  const copy =
    promptProvider === GOOGLE_CALENDAR_PROVIDER
      ? {
          aria: t('agent-access-dialog.aria'),
          title: t('agent-access-dialog.title'),
          body: t('agent-access-dialog.body'),
          footnote: t('agent-access-dialog.footnote')
        }
      : {
          aria: t('agent-access-dialog.provider.aria', { provider: providerName }),
          title: t('agent-access-dialog.provider.title', { provider: providerName }),
          body: t('agent-access-dialog.provider.body'),
          footnote: t('agent-access-dialog.provider.footnote')
        }

  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-testid="agent-access-consent-dialog"
          data-provider={promptProvider}
          aria-label={copy.aria}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className={cn(
            // start-1/2 flips to right:50% in RTL, so the centering translate has
            // to flip with it — hence the rtl: override on translate-x.
            'fixed start-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 rtl:translate-x-1/2 -translate-y-1/2',
            'rounded-md border bg-popover p-6 text-popover-foreground shadow-lg outline-none'
          )}
        >
          <DialogPrimitive.Title className="mb-1 text-lg font-semibold">
            {copy.title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-2 text-sm text-muted-foreground">
            {copy.body}
          </DialogPrimitive.Description>
          <p className="text-xs/4 text-muted-foreground">{copy.footnote}</p>

          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void decide(false)}
              disabled={isSaving}
            >
              {t('agent-access-dialog.deny')}
            </Button>
            <Button type="button" size="sm" onClick={() => void decide(true)} disabled={isSaving}>
              {t('agent-access-dialog.allow')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
