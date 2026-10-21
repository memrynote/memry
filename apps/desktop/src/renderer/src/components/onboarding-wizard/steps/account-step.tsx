import { useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useAuth } from '@/contexts/auth-context'
import { Loader2 } from '@/lib/icons'
import { SetupWizard } from '@/pages/settings/setup-wizard'
import { useDeviceLabel } from '../wizard-ui'
import type { StepProps } from './basic-steps'

/**
 * Sign-in, code, recovery phrase and device unlock all run through the same
 * SetupWizard Settings uses. This step only decides where the user goes after:
 * a new account continues to the plan, an existing one to its vaults.
 */
export function AccountStep({ state, dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const auth = useAuth()
  const { status, wizardStep } = auth.state
  // A new account always shows its recovery phrase before it is authenticated.
  const createdAccount = useRef(false)
  if (wizardStep === 'recovery-display') createdAccount.current = true
  // Already signed in on arrival (an empty account starting a vault): nothing to decide.
  const signedInHere = useRef(status !== 'authenticated')

  const rerouted = useRef(false)
  const existingAccount =
    state.path === 'new' && (wizardStep === 'linking-choice' || wizardStep === 'recovery-input')

  useEffect(() => {
    if (!existingAccount) return
    rerouted.current = true
    dispatch({ type: 'reroute-to-returning' })
  }, [existingAccount, dispatch])

  useEffect(() => {
    if (status !== 'authenticated') return
    if (state.path === 'new' && signedInHere.current && !createdAccount.current) {
      // Signed in on a device this account already knows: no phrase step ran.
      dispatch({ type: 'reroute-to-returning' })
      dispatch({ type: 'next' })
      return
    }
    dispatch({ type: 'next' })
  }, [status, state.path, dispatch])

  return (
    <div className="flex w-full max-w-[420px] flex-col pt-8">
      {rerouted.current && status !== 'authenticated' && (
        <p className="pb-5 text-center text-[13px] leading-[19px] text-text-secondary">
          {t('onboardingWizard.account.existingAccount', { device })}
        </p>
      )}
      {status === 'checking' || status === 'idle' ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-4 animate-spin text-text-tertiary" />
        </div>
      ) : (
        <SetupWizard showProgress={false} />
      )}
    </div>
  )
}
