import { useCallback, useEffect, useState } from 'react'
import type { AccountVaultInfo } from '@memry/contracts/vault-api'
import { useT } from '@memry/i18n/renderer'
import { vaultService } from '@/services/vault-service'
import { extractErrorMessage } from '@/lib/ipc-error'

const KEY = 'phaseF.componentsVaultOnboarding.flow'

export type LoadState =
  | { kind: 'loading' }
  // Empty message: render the localized generic failure instead.
  | { kind: 'error'; message: string }
  | { kind: 'ready'; vaults: AccountVaultInfo[]; defaultParent: string }

/** The account's vaults plus the default download folder. */
export function useAccountVaults(): { load: LoadState; reload: () => void } {
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
    // oxlint-disable-next-line react/set-state-in-effect -- synchronizes local state with an external source (IPC fetch / layout measurement) on this trigger
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
export function useOpenAccountVault(onOpened: () => void): OpenAccountVault {
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
