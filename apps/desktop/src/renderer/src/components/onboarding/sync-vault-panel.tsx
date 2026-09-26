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
import { FolderField } from './folder-field'
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

const KEY = 'phaseF.componentsVaultOnboarding.flow'

type LoadState =
  | { kind: 'loading' }
  // Empty message: render the localized generic failure instead.
  | { kind: 'error'; message: string }
  | { kind: 'ready'; vaults: AccountVaultInfo[]; defaultParent: string }

/** The account's vaults plus the default download folder. */
function useAccountVaults(): { load: LoadState; reload: () => void } {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const fetchVaults = useCallback(async (): Promise<void> => {
    setLoad({ kind: 'loading' })
    try {
      const [vaults, defaultParent] = await Promise.all([
        vaultService.listAccount(),
        vaultService.getDefaultParent()
      ])
      setLoad({ kind: 'ready', vaults, defaultParent })
    } catch (err) {
      setLoad({ kind: 'error', message: extractErrorMessage(err, '') })
    }
  }, [])
  useEffect(() => {
    void fetchVaults()
  }, [fetchVaults])
  return { load, reload: () => void fetchVaults() }
}

interface OpenAccountVault {
  opening: boolean
  openError: string | null
  setOpenError: (message: string | null) => void
  open: (vault: AccountVaultInfo, parent: string | null) => Promise<void>
}

/** Open the local copy when there is one, otherwise download into `parent`. */
function useOpenAccountVault(onOpened: () => void): OpenAccountVault {
  const { t } = useT('common')
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const open = async (vault: AccountVaultInfo, parent: string | null): Promise<void> => {
    if (opening) return
    setOpening(true)
    setOpenError(null)
    try {
      const result = vault.localPath
        ? await vaultService.switch(vault.localPath)
        : await vaultService.downloadRemote(vault.vaultUuid, parent ?? undefined)
      if (result.success) onOpened()
      else setOpenError(extractErrorMessage(result.error, t(`${KEY}.openFailed`)))
    } catch (err) {
      setOpenError(extractErrorMessage(err, t(`${KEY}.openFailed`)))
    } finally {
      setOpening(false)
    }
  }

  return { opening, openError, setOpenError, open }
}

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
  const { load, reload } = useAccountVaults()

  if (load.kind === 'ready' && load.vaults.length === 0) {
    return (
      <OnboardingStep
        onBack={onBack}
        title={t(`${KEY}.noVaultsTitle`)}
        subtitle={t(`${KEY}.noVaultsDesc`)}
        footer={
          <Button size="sm" onClick={onCreateVault}>
            {t(`${KEY}.createCta`)}
          </Button>
        }
      >
        {null}
      </OnboardingStep>
    )
  }

  if (load.kind === 'ready') {
    return (
      <AccountVaultChooser
        email={email}
        vaults={load.vaults}
        defaultParent={load.defaultParent}
        onBack={onBack}
        onOpened={onOpened}
      />
    )
  }

  return (
    <OnboardingStep
      onBack={onBack}
      title={t(`${KEY}.chooseTitle`)}
      subtitle={t(`${KEY}.chooseSubtitle`, { email: email ?? '' })}
    >
      {load.kind === 'loading' ? (
        <div className="flex items-center gap-2 py-4 text-xs leading-4 text-text-tertiary">
          <Loader2 className="size-3.5 animate-spin" />
          {t(`${KEY}.loadingVaults`)}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-xs leading-4 text-destructive">
            {load.message || t(`${KEY}.loadFailed`)}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t(`${KEY}.retry`)}
          </Button>
        </div>
      )}
    </OnboardingStep>
  )
}

function AccountVaultChooser({
  email,
  vaults,
  defaultParent,
  onBack,
  onOpened
}: {
  email: string | null
  vaults: AccountVaultInfo[]
  defaultParent: string
  onBack: () => void
  onOpened: () => void
}): React.JSX.Element {
  const { t } = useT('common')
  const [selected, setSelected] = useState(vaults[0]?.vaultUuid ?? null)
  const [parent, setParent] = useState(defaultParent)
  const { opening, openError, setOpenError, open } = useOpenAccountVault(onOpened)
  const selectedVault = vaults.find((vault) => vault.vaultUuid === selected) ?? null

  return (
    <OnboardingStep
      onBack={onBack}
      title={t(`${KEY}.chooseTitle`)}
      subtitle={t(`${KEY}.chooseSubtitle`, { email: email ?? '' })}
      footer={
        <>
          <span className="me-auto text-xs leading-4 text-text-tertiary">
            {t(`${KEY}.otherVaultsHint`)}
          </span>
          <Button
            size="sm"
            disabled={!selectedVault || opening}
            onClick={() => selectedVault && void open(selectedVault, parent)}
          >
            {opening && <Loader2 className="animate-spin" />}
            {opening ? t(`${KEY}.opening`) : t(`${KEY}.openVault`)}
          </Button>
        </>
      }
    >
      <div
        role="radiogroup"
        aria-label={t(`${KEY}.chooseTitle`)}
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
        <FolderField
          label={t(`${KEY}.downloadTo`)}
          path={parent}
          disabled={opening}
          onChange={setParent}
          onError={setOpenError}
        />
      )}
      {openError && (
        <p role="alert" className="text-xs leading-4 text-destructive">
          {openError}
        </p>
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
