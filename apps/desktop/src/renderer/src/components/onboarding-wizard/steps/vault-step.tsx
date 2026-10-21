import { useEffect, useRef, useState } from 'react'
import type { AccountVaultInfo } from '@memry/contracts/vault-api'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { FolderField } from '@/components/onboarding/folder-field'
import { useAccountVaults, useOpenAccountVault } from '@/components/onboarding/use-account-vaults'
import { useAuth } from '@/contexts/auth-context'
import { Loader2 } from '@/lib/icons'
import { applyReturningUser } from '../apply-onboarding'
import { ContinueButton, OptionCard, OptionList, StepHeading, useDeviceLabel } from '../wizard-ui'
import type { StepProps } from './basic-steps'

const K = 'onboardingWizard.vault'

/** The returning user's last step: pick a vault, or skip the pick when there is one. */
export function VaultStep({ dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const email = useAuth().state.email ?? ''
  const { load, reload } = useAccountVaults()
  const { opening, openError, open } = useOpenAccountVault(applyReturningUser)
  const [selected, setSelected] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const autoOpened = useRef(false)

  const vaults = load.kind === 'ready' ? load.vaults : []
  const defaultParent = load.kind === 'ready' ? load.defaultParent : null
  const selectedVault: AccountVaultInfo | undefined =
    vaults.find((vault) => vault.vaultUuid === selected) ?? vaults[0]

  // One vault: nothing to choose, download it to the default place.
  useEffect(() => {
    if (load.kind !== 'ready' || load.vaults.length !== 1 || autoOpened.current) return
    autoOpened.current = true
    void open(load.vaults[0], load.defaultParent)
  }, [load, open])

  const heading = <StepHeading title={t(`${K}.title`)} body={t(`${K}.body`, { email, device })} />

  if (load.kind === 'loading' || (vaults.length === 1 && !openError)) {
    return (
      <>
        {heading}
        <div className="flex justify-center py-10" role="status">
          <Loader2 className="size-4 animate-spin text-text-tertiary motion-reduce:animate-none" />
        </div>
      </>
    )
  }

  if (load.kind === 'error') {
    return (
      <>
        {heading}
        <div className="flex flex-col items-center gap-3 pt-6">
          <p role="alert" className="text-xs text-destructive">
            {t(`${K}.loadFailed`)}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t(`${K}.retry`)}
          </Button>
        </div>
      </>
    )
  }

  if (vaults.length === 0) {
    return (
      <>
        {heading}
        <p className="max-w-[440px] pt-6 text-center text-[13px] leading-[19px] text-text-secondary">
          {t(`${K}.noVaults`, { device })}
        </p>
        <div className="pt-6">
          <ContinueButton
            label={t(`${K}.startNew`)}
            onClick={() => dispatch({ type: 'switch-to-new' })}
          />
        </div>
      </>
    )
  }

  return (
    <>
      {heading}
      <OptionList
        role="radiogroup"
        label={t(`${K}.title`)}
        className="w-full max-w-[520px] gap-1.5 pt-6"
      >
        {vaults.map((vault) => (
          <OptionCard
            key={vault.vaultUuid}
            kind="radio"
            compact
            disabled={opening}
            selected={vault.vaultUuid === selectedVault?.vaultUuid}
            onSelect={() => setSelected(vault.vaultUuid)}
            title={vault.name ?? vault.vaultUuid.slice(0, 8)}
            description={t(`${K}.items`, { count: vault.itemCount })}
          />
        ))}
      </OptionList>
      {selectedVault && !selectedVault.localPath && (
        <div className="w-full max-w-[520px] pt-4">
          <FolderField
            label={t(`${K}.downloadTo`)}
            path={parent ?? defaultParent}
            disabled={opening}
            onChange={setParent}
            onError={setPickError}
          />
        </div>
      )}
      <div className="flex flex-col items-center gap-3 pt-6">
        <ContinueButton
          label={t('onboardingWizard.keys.continue')}
          loading={opening}
          disabled={!selectedVault || opening}
          onClick={() => selectedVault && void open(selectedVault, parent ?? defaultParent)}
        />
        {(openError || pickError) && (
          <p role="alert" className="max-w-[420px] text-center text-xs text-destructive">
            {openError ? t(`${K}.openFailed`) : pickError}
          </p>
        )}
        <p className="max-w-[420px] text-center text-xs leading-[17px] text-text-tertiary">
          {t(`${K}.otherVaults`)}
        </p>
      </div>
    </>
  )
}
