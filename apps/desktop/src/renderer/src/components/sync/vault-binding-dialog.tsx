import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { VaultBindingChoice, VaultBindingState } from '@memry/contracts/ipc-sync-ops'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

type NeedsDecision = Extract<VaultBindingState, { status: 'needs-decision' }>

interface VaultBindingDialogProps {
  state: NeedsDecision | null
  onChoose: (choice: VaultBindingChoice) => Promise<void>
  onDismiss: () => void
}

/**
 * Asked once when the open vault has content the signed-in account has never
 * seen. Sync waits for the answer; nothing is uploaded or merged before it.
 * Escape dismisses until the next time the vault opens.
 */
export function VaultBindingDialog({
  state,
  onChoose,
  onDismiss
}: VaultBindingDialogProps): React.JSX.Element {
  const { t } = useT('settings')
  const [pending, setPending] = useState<VaultBindingChoice | null>(null)

  const choose = async (choice: VaultBindingChoice): Promise<void> => {
    setPending(choice)
    try {
      await onChoose(choice)
    } finally {
      setPending(null)
    }
  }

  const mergeTarget = state?.mergeTarget ?? null

  return (
    <AlertDialog open={state !== null} onOpenChange={(open) => !open && onDismiss()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-xl tracking-tight">
            {t('vault.binding.dialog.title')}
          </AlertDialogTitle>
          <AlertDialogDescription className="font-serif text-[15px] leading-relaxed">
            {mergeTarget
              ? t('vault.binding.dialog.descriptionWithVaults')
              : t('vault.binding.dialog.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2">
          <Button disabled={pending !== null} onClick={() => void choose('sync')}>
            {t('vault.binding.dialog.addAsNew')}
          </Button>
          {mergeTarget && (
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => void choose('merge')}
            >
              {mergeTarget.name
                ? t('vault.binding.dialog.merge', { name: mergeTarget.name })
                : t('vault.binding.dialog.mergeUnnamed')}
            </Button>
          )}
          <Button variant="ghost" disabled={pending !== null} onClick={() => void choose('local')}>
            {t('vault.binding.dialog.keepLocal')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
