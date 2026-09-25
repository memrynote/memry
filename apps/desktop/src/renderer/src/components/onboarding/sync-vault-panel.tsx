import { useCallback, useEffect, useState } from 'react'
import type { AccountVaultInfo } from '@memry/contracts/vault-api'
import { Loader2 } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { SetupWizard } from '@/pages/settings/setup-wizard'
import { vaultService } from '@/services/vault-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { OnboardingStep } from './onboarding-step'

interface SyncVaultPanelProps {
  onBack: () => void
  onOpened: () => void
  /** Account has no vaults yet (fresh sign-up): continue in the create form */
  onCreateVault: () => void
}

/**
 * "Open from Memrynote Sync": the same sign-in / sign-up wizard Settings uses,
 * then — once the account is unlocked — a single-choice list of the account's
 * vaults. Signing in here happens with no vault open; main registers the
 * install-wide identity and the chosen vault binds on first open.
 */
export function SyncVaultPanel({
  onBack,
  onOpened,
  onCreateVault
}: SyncVaultPanelProps): React.JSX.Element {
  const { state } = useAuth()

  if (state.status === 'authenticated') {
    return (
      <AccountVaultPicker
        email={state.email}
        onBack={onBack}
        onOpened={onOpened}
        onCreateVault={onCreateVault}
      />
    )
  }

  return (
    <OnboardingStep onBack={onBack}>
      {state.status === 'checking' || state.status === 'idle' ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-4 animate-spin text-text-tertiary" />
        </div>
      ) : (
        <SetupWizard />
      )}
    </OnboardingStep>
  )
}

type LoadState =
  | { kind: 'loading' }
  // Empty message: render the localized generic failure instead.
  | { kind: 'error'; message: string }
  | { kind: 'ready'; vaults: AccountVaultInfo[] }

function AccountVaultPicker({
  email,
  onBack,
  onOpened,
  onCreateVault
}: {
  email: string | null
  onBack: () => void
  onOpened: () => void
  onCreateVault: () => void
}): React.JSX.Element {
  const { t } = useT('common')
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const fetchVaults = useCallback(async (): Promise<void> => {
    setLoad({ kind: 'loading' })
    try {
      const [vaults, defaultParent] = await Promise.all([
        vaultService.listAccount(),
        vaultService.getDefaultParent()
      ])
      setLoad({ kind: 'ready', vaults })
      setSelected((current) => current ?? vaults[0]?.vaultUuid ?? null)
      setParent((current) => current ?? defaultParent)
    } catch (err) {
      setLoad({ kind: 'error', message: extractErrorMessage(err, '') })
    }
  }, [])

  useEffect(() => {
    void fetchVaults()
  }, [fetchVaults])

  const vaults = load.kind === 'ready' ? load.vaults : []
  const selectedVault = vaults.find((vault) => vault.vaultUuid === selected) ?? null

  const chooseParent = async (): Promise<void> => {
    try {
      const { path } = await window.api.syncLinking.pickVaultFolder()
      if (path) setParent(path)
    } catch (err) {
      setOpenError(extractErrorMessage(err, t('phaseF.componentsVaultOnboarding.flow.openFailed')))
    }
  }

  const open = async (): Promise<void> => {
    if (!selectedVault || opening) return
    setOpening(true)
    setOpenError(null)
    try {
      const result = selectedVault.localPath
        ? await vaultService.switch(selectedVault.localPath)
        : await vaultService.downloadRemote(selectedVault.vaultUuid, parent ?? undefined)
      if (result.success) {
        onOpened()
        return
      }
      setOpenError(
        extractErrorMessage(result.error, t('phaseF.componentsVaultOnboarding.flow.openFailed'))
      )
    } catch (err) {
      setOpenError(extractErrorMessage(err, t('phaseF.componentsVaultOnboarding.flow.openFailed')))
    } finally {
      setOpening(false)
    }
  }

  if (load.kind === 'ready' && vaults.length === 0) {
    return (
      <OnboardingStep
        onBack={onBack}
        title={t('phaseF.componentsVaultOnboarding.flow.noVaultsTitle')}
        subtitle={t('phaseF.componentsVaultOnboarding.flow.noVaultsDesc')}
        footer={
          <Button size="sm" onClick={onCreateVault}>
            {t('phaseF.componentsVaultOnboarding.flow.createCta')}
          </Button>
        }
      >
        {null}
      </OnboardingStep>
    )
  }

  return (
    <OnboardingStep
      onBack={onBack}
      title={t('phaseF.componentsVaultOnboarding.flow.chooseTitle')}
      subtitle={t('phaseF.componentsVaultOnboarding.flow.chooseSubtitle', { email: email ?? '' })}
      footer={
        load.kind === 'ready' ? (
          <>
            <span className="me-auto text-xs leading-4 text-text-tertiary">
              {t('phaseF.componentsVaultOnboarding.flow.otherVaultsHint')}
            </span>
            <Button size="sm" disabled={!selectedVault || opening} onClick={() => void open()}>
              {opening && <Loader2 className="animate-spin" />}
              {opening
                ? t('phaseF.componentsVaultOnboarding.flow.opening')
                : t('phaseF.componentsVaultOnboarding.flow.openVault')}
            </Button>
          </>
        ) : undefined
      }
    >
      {load.kind === 'loading' && (
        <div className="flex items-center gap-2 py-4 text-xs leading-4 text-text-tertiary">
          <Loader2 className="size-3.5 animate-spin" />
          {t('phaseF.componentsVaultOnboarding.flow.loadingVaults')}
        </div>
      )}

      {load.kind === 'error' && (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-xs leading-4 text-destructive">
            {load.message || t('phaseF.componentsVaultOnboarding.flow.loadFailed')}
          </p>
          <Button variant="outline" size="sm" onClick={() => void fetchVaults()}>
            {t('phaseF.componentsVaultOnboarding.flow.retry')}
          </Button>
        </div>
      )}

      {load.kind === 'ready' && (
        <>
          <div
            role="radiogroup"
            aria-label={t('phaseF.componentsVaultOnboarding.flow.chooseTitle')}
            className="flex flex-col gap-0.5 -mx-2"
          >
            {vaults.map((vault) => (
              <AccountVaultRow
                key={vault.vaultUuid}
                vault={vault}
                checked={vault.vaultUuid === selected}
                disabled={opening}
                onSelect={() => setSelected(vault.vaultUuid)}
              />
            ))}
          </div>

          {selectedVault && !selectedVault.localPath && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs leading-4 font-medium text-text-secondary">
                {t('phaseF.componentsVaultOnboarding.flow.downloadTo')}
              </span>
              <div className="flex items-center h-9 gap-2 rounded-md border border-input ps-3 pe-1">
                <span className="grow shrink basis-0 min-w-0 truncate font-mono text-xs text-foreground">
                  {parent ?? ''}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={opening}
                  onClick={() => void chooseParent()}
                >
                  {t('phaseF.componentsVaultOnboarding.flow.change')}
                </Button>
              </div>
            </div>
          )}

          {openError && (
            <p role="alert" className="text-xs leading-4 text-destructive">
              {openError}
            </p>
          )}
        </>
      )}
    </OnboardingStep>
  )
}

function AccountVaultRow({
  vault,
  checked,
  disabled,
  onSelect
}: {
  vault: AccountVaultInfo
  checked: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useT('common')
  const name =
    vault.name ??
    `${t('phaseF.componentsVaultOnboarding.flow.untitledVault')} · ${vault.vaultUuid.slice(0, 8)}`
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-center w-full gap-3 rounded-lg px-2 py-2.5 text-start transition-colors disabled:opacity-60',
        checked ? 'bg-surface-active' : 'hover:bg-accent'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-4 shrink-0 rounded-full border transition-colors',
          checked ? 'border-[5px] border-foreground' : 'border-text-tertiary'
        )}
      />
      <span className="flex flex-col grow shrink basis-0 min-w-0 gap-0.5">
        <span className="font-heading font-medium text-[13px] leading-4 text-foreground truncate">
          {name}
        </span>
        <span className="text-xs leading-4 text-text-tertiary">
          {t('phaseF.componentsVaultOnboarding.flow.items', { count: vault.itemCount })}
        </span>
      </span>
      {vault.localPath && (
        <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-[11px] leading-[14px] text-text-secondary">
          {t('phaseF.componentsVaultOnboarding.flow.onThisComputer')}
        </span>
      )}
    </button>
  )
}
