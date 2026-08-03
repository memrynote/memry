import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { useAgentAccessConsent } from '@/hooks/use-agent-access-consent'
import { cn } from '@/lib/utils'

export interface AgentAccessConsentDialogProps {
  /** Whether this vault has Google calendars imported. No connection, no question. */
  hasImportedSources: boolean
}

/**
 * Google Workspace Limited Use: asked once, the first time a user with a live
 * Google Calendar connection opens the calendar. Both buttons are an answer —
 * there is no dismiss, and Escape/outside clicks are suppressed, because an
 * unanswered prompt is exactly what makes us ask again on the next visit.
 *
 * Owns its consent state instead of taking it as props: nothing else drives
 * this dialog, and the calendar page is already at its line budget.
 */
export function AgentAccessConsentDialog({
  hasImportedSources
}: AgentAccessConsentDialogProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const { isPromptOpen, isSaving, error, decide } = useAgentAccessConsent(hasImportedSources)

  if (!isPromptOpen) return null

  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-testid="agent-access-consent-dialog"
          aria-label={t('agent-access-dialog.aria')}
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
            {t('agent-access-dialog.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-2 text-sm text-muted-foreground">
            {t('agent-access-dialog.body')}
          </DialogPrimitive.Description>
          <p className="text-xs/4 text-muted-foreground">{t('agent-access-dialog.footnote')}</p>

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
