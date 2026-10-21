import { useEffect } from 'react'
import { VaultOnboarding } from '@/components/vault-onboarding'
import { useVaultList } from '@/hooks/use-vault'
import { startFirstRunWizard, useFirstRunWizardActive } from './first-run-store'
import { OnboardingWizard } from './onboarding-wizard'

/**
 * No known vaults means a fresh install: the first-run wizard runs. Anyone with
 * vaults on this computer keeps the vault picker.
 */
export function FirstRunGate(): React.JSX.Element | null {
  const active = useFirstRunWizardActive()
  const { vaults, isLoading } = useVaultList()
  const fresh = !isLoading && vaults.length === 0

  useEffect(() => {
    if (fresh) startFirstRunWizard()
  }, [fresh])

  if (active || fresh) return <OnboardingWizard />
  if (isLoading) return null
  return <VaultOnboarding />
}
