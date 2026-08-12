import { useState, useCallback } from 'react'
import { useT } from '@memry/i18n/renderer'
import { LINK_FAILURE_SETUP_SESSION_EXPIRED } from '@memry/contracts/ipc-devices'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from '@/lib/icons'
import { useAuth } from '@/contexts/auth-context'
import { extractErrorMessage, getIpcErrorCode } from '@/lib/ipc-error'
import { RecoveryPhraseInput } from './recovery-phrase-input'
import { StartFreshPanel, StartFreshTrigger } from './start-fresh-panel'

interface VaultRecoveryDialogProps {
  open: boolean
  onRecovered: () => void
  onDismiss: () => void
  onSignOut: () => void
}

/**
 * Shown when the sync runtime detects that this device holds key material that
 * cannot decrypt the vault (VAULT_RECOVERY_NEEDED). Drives the existing
 * recovery-phrase flow (auth linkViaRecovery -> LINK_VIA_RECOVERY) to re-derive
 * the correct master key from the recovery phrase, validated against the server
 * verifier. If the setup token has expired, linkViaRecovery reports it and the
 * user is offered a re-authentication path.
 */
export function VaultRecoveryDialog({
  open,
  onRecovered,
  onDismiss,
  onSignOut
}: VaultRecoveryDialogProps): React.JSX.Element {
  const { t } = useT('settings')
  const { linkViaRecovery } = useAuth()
  const [phase, setPhase] = useState<'intro' | 'input' | 'start-fresh'>('intro')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)

  const handleSubmit = useCallback(
    async (phrase: string) => {
      setIsLoading(true)
      setError(null)
      setSessionExpired(false)
      try {
        await linkViaRecovery(phrase)
        onRecovered()
      } catch (err) {
        // The message arrives already translated from the main process, so it
        // is unusable as a condition — an English regex over it left every
        // non-English user told to sign in again with no control to do it
        // (#1202). The handler's code is locale-independent.
        if (getIpcErrorCode(err) === LINK_FAILURE_SETUP_SESSION_EXPIRED) {
          setSessionExpired(true)
        }
        setError(extractErrorMessage(err, t('setup.recovery.failed')))
      } finally {
        setIsLoading(false)
      }
    },
    [linkViaRecovery, onRecovered, t]
  )

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="sm:max-w-md">
        {phase === 'intro' ? (
          <>
            <AlertDialogHeader>
              <div className="flex items-center gap-3 mb-1">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 dark:bg-amber-400/10">
                  <AlertTriangle
                    className="w-5 h-5 text-amber-600 dark:text-amber-400"
                    aria-hidden="true"
                  />
                </div>
                <AlertDialogTitle className="font-display text-xl tracking-tight">
                  {'This device can’t open your vault'}
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription className="font-serif text-[15px] leading-relaxed">
                {
                  'The key on this device no longer matches your vault, so its items can’t be decrypted. Your data is safe on the server. Enter your recovery phrase to restore the correct key, or sign in again on a device that still has it.'
                }
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={onDismiss}>
                {'Later'}
              </Button>
              <Button
                onClick={() => {
                  setError(null)
                  setSessionExpired(false)
                  setPhase('input')
                }}
              >
                {'Enter recovery phrase'}
              </Button>
            </AlertDialogFooter>
          </>
        ) : phase === 'start-fresh' ? (
          <>
            <AlertDialogHeader className="sr-only">
              <AlertDialogTitle>{t('setup.startFresh.title')}</AlertDialogTitle>
            </AlertDialogHeader>
            <StartFreshPanel onConfirm={onSignOut} onCancel={() => setPhase('input')} />
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display text-xl tracking-tight">
                {'Restore your vault key'}
              </AlertDialogTitle>
            </AlertDialogHeader>
            <RecoveryPhraseInput
              onSubmit={(phrase) => void handleSubmit(phrase)}
              isLoading={isLoading}
              error={error}
              onBack={() => setPhase('intro')}
            />
            {sessionExpired && (
              <AlertDialogFooter>
                <Button variant="outline" onClick={onSignOut}>
                  {'Sign in again'}
                </Button>
              </AlertDialogFooter>
            )}
            <StartFreshTrigger onClick={() => setPhase('start-fresh')} />
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
