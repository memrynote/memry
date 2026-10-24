import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

export interface PromoteExternalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (dontAskAgain: boolean) => void | Promise<void>
  isWorking?: boolean
  errorMessage?: string | null
  /**
   * The promoted copy lives in native storage, which the agent may read even when
   * Google-event access is off. Surface that so the user is not opted back in by a
   * gesture that reads as "let me look at this event".
   */
  agentAccessOff?: boolean
}

export function PromoteExternalDialog({
  open,
  onOpenChange,
  onConfirm,
  isWorking = false,
  errorMessage = null,
  agentAccessOff = false
}: PromoteExternalDialogProps): React.JSX.Element | null {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const { t } = useT('calendar')
  const { t: tCommon } = useT('common')

  if (!open) return null

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-testid="promote-external-dialog"
          aria-label={t('promote-dialog.aria')}
          className={cn(
            'fixed start-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rtl:translate-x-1/2',
            'rounded-md border bg-popover p-6 text-popover-foreground shadow-lg outline-none'
          )}
        >
          <DialogPrimitive.Title className="mb-1 text-lg font-semibold">
            {t('promote-dialog.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-4 text-sm text-muted-foreground">
            {t('promote-dialog.body')}
          </DialogPrimitive.Description>

          {agentAccessOff && (
            <p className="mb-4 rounded-md border border-border bg-muted/50 p-3 text-xs text-foreground">
              {t('promote-dialog.agent-notice')}
            </p>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={dontAskAgain}
              onCheckedChange={(value) => setDontAskAgain(value === true)}
              disabled={isWorking}
              aria-label={t('promote-dialog.do-not-ask-again')}
            />
            <span className="text-muted-foreground">{t('promote-dialog.do-not-ask-again')}</span>
          </label>

          {errorMessage && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {errorMessage}
            </p>
          )}

          <div className="mt-6 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isWorking}
            >
              {tCommon('button.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void onConfirm(dontAskAgain)}
              disabled={isWorking}
            >
              {isWorking ? t('state.preparing') : t('promote-dialog.confirm-label')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
