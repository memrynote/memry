import { useState, useEffect, useCallback, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type {
  AccountVaultInfo,
  VaultStatus,
  VaultConfig,
  VaultInfo,
  GetVaultsResponse,
  SandboxInfo,
  SelectVaultResponse,
  IndexRecoveredEvent
} from '../../../preload/index.d'
import {
  vaultService,
  onVaultStatusChanged,
  onVaultIndexProgress,
  onVaultError,
  onVaultIndexRecovered,
  onVaultConfigChanged,
  onVaultListChanged
} from '../services/vault-service'
import { getI18n } from 'react-i18next'
import { clearTabStateForVault } from '@/contexts/tabs/persistence'
import { clearVaultSidebarSnapshot } from '@/lib/vault-sidebar-snapshot'
import { clearTaskOrderForVault } from '@/hooks/use-task-order'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { runVaultLeaveFlushes } from '@/lib/vault-workspace-lifecycle'
import { useVaultScope } from '@/contexts/vault-scope'
import {
  getCachedVaultList,
  getCachedVaultStatus,
  setCachedVaultList,
  setCachedVaultStatus
} from '@/lib/vault-status-cache'
import {
  beginVaultSwitch,
  endVaultSwitch,
  getVaultSwitchState,
  isVaultRevealHeld,
  subscribeVaultSwitchState,
  type VaultSwitchDirection,
  type VaultSwitchSource
} from '@/lib/vault-switch-state'
import { createLogger } from '@/lib/logger'
import { vaultFolderPath } from '@/lib/vault-folder-path'

const log = createLogger('Vault')

/**
 * Writes the edits still in their debounce, which belong to the vault being
 * left. Every call that makes main close the open vault runs this first: the
 * vault's workspace stays mounted (hidden) after a switch, so nothing else would
 * write them before main closes it. Editors first: their flush hands markdown to
 * the page saves the registry then writes.
 */
async function flushVaultBeforeLeaving(): Promise<void> {
  await runVaultLeaveFlushes()
  await flushAllPendingSaves()
}

export interface SwitchVaultOptions {
  /** Display name for the in-between screen; defaults to the folder name. */
  name?: string
  accentColor?: string
  icon?: string
  /** Set by the sidebar gesture so the incoming vault can enter from that side. */
  direction?: VaultSwitchDirection
  source?: VaultSwitchSource
}

/**
 * Hook for vault state management.
 * Provides vault status, loading states, and actions for vault operations.
 *
 * @example
 * ```tsx
 * function VaultSelector() {
 *   const { status, isLoading, error, selectVault } = useVault()
 *
 *   if (isLoading) return <div>Loading...</div>
 *   if (error) return <div>Error: {error}</div>
 *
 *   if (!status?.isOpen) {
 *     return <button onClick={() => selectVault()}>Select Vault</button>
 *   }
 *
 *   return <div>Vault: {status.path}</div>
 * }
 * ```
 */
export function useVault() {
  const scope = useVaultScope()
  // Seeded from the last status any instance applied, so a workspace mounting
  // mid-switch draws its vault on the first frame (see `vault-status-cache`).
  // A scoped instance only takes its own vault's status, as in `applyStatus`.
  const [status, setStatusState] = useState<VaultStatus | null>(() => {
    const cached = getCachedVaultStatus()
    return cached && (scope === null || cached.path === scope) ? cached : null
  })
  const [config, setConfig] = useState<VaultConfig | null>(null)
  const [isLoading, setIsLoading] = useState(() => status === null)
  const [error, setError] = useState<string | null>(null)
  const [recoveryInfo, setRecoveryInfo] = useState<IndexRecoveredEvent | null>(null)
  const latestStatusRef = useRef<VaultStatus | null>(null)

  const setStatus = useCallback((next: VaultStatus) => {
    setCachedVaultStatus(next)
    setStatusState(next)
  }, [])

  /**
   * A switch closes the open vault before it opens the next, and main reports
   * that gap as `isOpen: false`. Passed through, every consumer drops the
   * outgoing vault for a frame or two (App unmounts the workspace, the sidebar
   * loses its pager), which is the flash between vaults. While a switch is in
   * flight the gap is held back; the latest status lands when the switch ends,
   * so a failed switch still surfaces the closed state.
   *
   * Inside a vault workspace, only that vault's status is taken: a workspace
   * kept mounted for a vault the user left must not start rendering the next
   * vault's path, or it would show it for a frame when it is revealed again.
   */
  const applyStatus = useCallback(
    (next: VaultStatus) => {
      if (scope !== null && next.path !== scope) return
      latestStatusRef.current = next
      if (!next.isOpen && getVaultSwitchState().pending) return
      // The pager is still settling: the incoming vault is revealed once it is
      // done, with whatever status is latest by then.
      if (isVaultRevealHeld()) return
      setStatus(next)
    },
    [scope, setStatus]
  )

  useEffect(
    () =>
      subscribeVaultSwitchState(() => {
        const latest = latestStatusRef.current
        if (!latest || isVaultRevealHeld()) return
        if (!latest.isOpen && getVaultSwitchState().pending) return
        setStatus(latest)
      }),
    [setStatus]
  )

  // Load initial status and config
  useEffect(() => {
    const loadInitialState = async () => {
      try {
        const [vaultStatus, vaultConfig] = await Promise.all([
          vaultService.getStatus(),
          vaultService.getConfig()
        ])
        applyStatus(vaultStatus)
        setConfig(vaultConfig)
        setError(extractErrorMessage(vaultStatus.error, ''))
      } catch (err) {
        const message = extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadVaultStatus')
        )
        setError(message)
      } finally {
        setIsLoading(false)
      }
    }

    void loadInitialState()
  }, [applyStatus])

  // Subscribe to vault events
  useEffect(() => {
    const unsubStatus = onVaultStatusChanged((newStatus) => {
      applyStatus(newStatus)
      if (newStatus.error) {
        setError(extractErrorMessage(newStatus.error, ''))
      }
    })

    const unsubProgress = onVaultIndexProgress((_progress) => {
      // Progress is tracked in status.indexProgress, but this event
      // can be used for more granular updates if needed
    })

    const unsubError = onVaultError((errorMsg) => {
      setError(extractErrorMessage(errorMsg, ''))
    })

    // Another window's settings save, or main following a renamed journal folder.
    const unsubConfig = onVaultConfigChanged(setConfig)

    let recoveryClearTimer: ReturnType<typeof setTimeout> | undefined

    const unsubRecovered = onVaultIndexRecovered((event) => {
      setRecoveryInfo(event)
      // Auto-clear recovery info after 10 seconds
      clearTimeout(recoveryClearTimer)
      recoveryClearTimer = setTimeout(() => setRecoveryInfo(null), 10000)
    })

    return () => {
      unsubStatus()
      unsubProgress()
      unsubError()
      unsubConfig()
      unsubRecovered()
      clearTimeout(recoveryClearTimer)
    }
  }, [applyStatus])

  /**
   * Select a vault folder. Shows folder picker if no path provided.
   */
  const selectVault = useCallback(async (path?: string): Promise<SelectVaultResponse> => {
    setIsLoading(true)
    setError(null)

    try {
      await flushVaultBeforeLeaving()
      const result = await vaultService.select(path)

      if (!result.success) {
        setError(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSelectVault')
          )
        )
      } else {
        // Refresh config after vault selection
        const newConfig = await vaultService.getConfig()
        setConfig(newConfig)
      }

      return result
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSelectVault')
      )
      setError(message)
      return { success: false, vault: null, error: message }
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * Close the current vault.
   */
  const closeVault = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    setError(null)

    try {
      await flushVaultBeforeLeaving()
      await vaultService.close()
      setConfig(null)
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCloseVault')
      )
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * Leaves the open vault for `vaultPath` through `open`, the call after which
   * main has closed it and opened the next. With no `vaultPath` the edits are
   * still written first, but no switch is marked.
   */
  const runSwitch = useCallback(
    async (
      vaultPath: string | null,
      options: SwitchVaultOptions,
      open: () => Promise<SelectVaultResponse>
    ): Promise<SelectVaultResponse> => {
      log.info('Vault switch requested', {
        source: options.source ?? 'unknown',
        from: latestStatusRef.current?.path ?? null,
        to: vaultPath,
        refused: getVaultSwitchState().pending !== null
      })
      // One switch at a time. Starting another would overwrite the running
      // switch's target, and its `endVaultSwitch` would then clear this one's.
      if (getVaultSwitchState().pending) {
        return {
          success: false,
          vault: null,
          error: getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSwitchVault')
        }
      }
      setIsLoading(true)
      setError(null)
      // Marks the closed-vault gap as a switch, so App keeps the shell up instead
      // of onboarding, and the incoming vault restores its whole tab session.
      if (vaultPath !== null) {
        beginVaultSwitch(
          {
            path: vaultPath,
            name: options.name ?? (vaultPath.split(/[\\/]/).pop() || vaultPath),
            accentColor: options.accentColor,
            icon: options.icon
          },
          options.direction ?? null
        )
      }
      let switched = false

      try {
        await flushVaultBeforeLeaving()
        const result = await open()
        switched = result.success

        if (!result.success) {
          setError(
            extractErrorMessage(
              result.error,
              getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSwitchVault')
            )
          )
        } else {
          const newConfig = await vaultService.getConfig()
          setConfig(newConfig)
        }

        return result
      } catch (err) {
        const message = extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSwitchVault')
        )
        setError(message)
        return { success: false, vault: null, error: message }
      } finally {
        if (vaultPath !== null) endVaultSwitch(switched)
        setIsLoading(false)
      }
    },
    []
  )

  /**
   * Switch to a different vault.
   */
  const switchVault = useCallback(
    (vaultPath: string, options: SwitchVaultOptions = {}): Promise<SelectVaultResponse> =>
      runSwitch(vaultPath, options, () => vaultService.switch(vaultPath)),
    [runSwitch]
  )

  /**
   * Download an account vault into `parentPath` (default: main's choice) and
   * open it. Main closes the open vault, so this is a switch like
   * `switchVault`. The switch names the folder the download is expected to
   * make; main takes the next free name when that one appeared meanwhile. A
   * stale suggestion can name the open vault itself, and a switch to the open
   * path would not mark it as left, so that download starts no switch.
   */
  const downloadVault = useCallback(
    (
      vault: AccountVaultInfo,
      parentPath?: string,
      options: SwitchVaultOptions = {}
    ): Promise<SelectVaultResponse> => {
      const folder = vault.suggestedPath.split(/[\\/]/).pop() || vault.suggestedPath
      const target = parentPath ? `${parentPath}/${folder}` : vault.suggestedPath
      const leaving = target === latestStatusRef.current?.path ? null : target
      return runSwitch(leaving, { name: vault.name ?? folder, ...options }, () =>
        vaultService.downloadRemote(vault.vaultUuid, parentPath)
      )
    },
    [runSwitch]
  )

  /**
   * Create `<parentPath>/<name>` and open it. Main closes the open vault, so this
   * is a switch like `switchVault`.
   */
  const createVault = useCallback(
    (parentPath: string, name: string): Promise<SelectVaultResponse> =>
      runSwitch(vaultFolderPath(parentPath, name), { name, source: 'menu' }, () =>
        vaultService.create(parentPath, name)
      ),
    [runSwitch]
  )

  /**
   * Update vault configuration.
   *
   * @returns the error message when the update was refused, else null
   */
  const updateConfig = useCallback(
    async (updates: Partial<VaultConfig>): Promise<string | null> => {
      try {
        const newConfig = await vaultService.updateConfig(updates)
        setConfig(newConfig)
        return null
      } catch (err) {
        const message = extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToUpdateConfig')
        )
        setError(message)
        return message
      }
    },
    []
  )

  /**
   * Trigger manual reindex.
   */
  const reindex = useCallback(async (): Promise<void> => {
    setError(null)

    try {
      await vaultService.reindex()
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToReindex')
      )
      setError(message)
    }
  }, [])

  /**
   * Clear error state.
   */
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  /**
   * Clear recovery info state.
   */
  const clearRecoveryInfo = useCallback(() => {
    setRecoveryInfo(null)
  }, [])

  return {
    // State
    status,
    config,
    isLoading,
    error,
    recoveryInfo,

    // Computed
    isOpen: status?.isOpen ?? false,
    isIndexing: status?.isIndexing ?? false,
    indexProgress: status?.indexProgress ?? 0,
    indexBuilt: status?.indexBuilt,
    indexTotal: status?.indexTotal,
    vaultPath: status?.path ?? null,

    // Actions
    selectVault,
    closeVault,
    switchVault,
    downloadVault,
    createVault,
    updateConfig,
    reindex,
    clearError,
    clearRecoveryInfo
  }
}

/**
 * Hook for getting the list of all known vaults.
 */
export function useVaultList() {
  // Seeded like `useVault`: the incoming workspace's sidebar needs the list on
  // its first frame to draw the pager and the indicator, not a frame later.
  const [vaults, setVaults] = useState<VaultInfo[]>(() => getCachedVaultList()?.vaults ?? [])
  const [currentVault, setCurrentVault] = useState<string | null>(
    () => getCachedVaultList()?.currentVault ?? null
  )
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(
    () => getCachedVaultList()?.sandbox ?? null
  )
  const [isLoading, setIsLoading] = useState(() => getCachedVaultList() === null)

  const apply = useCallback((result: GetVaultsResponse) => {
    setCachedVaultList(result)
    setVaults(result.vaults)
    setCurrentVault(result.currentVault)
    setSandbox(result.sandbox)
  }, [])

  useEffect(() => {
    const loadVaults = async () => {
      try {
        apply(await vaultService.getAll())
      } finally {
        setIsLoading(false)
      }
    }

    void loadVaults()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- dependency is an intentional re-run trigger (token/identity), not read by the effect
  }, [apply])

  const refresh = useCallback(async () => {
    apply(await vaultService.getAll())
  }, [apply])

  // An icon changed here or arrived from another device.
  useEffect(() => onVaultListChanged(() => void refresh()), [refresh])

  const removeVault = useCallback(
    async (path: string) => {
      await vaultService.remove(path)
      // The removed vault's tabs would otherwise sit on the origin's quota
      // forever, competing with the tab state of vaults the user still opens.
      clearTabStateForVault(path)
      clearVaultSidebarSnapshot(path)
      clearTaskOrderForVault(path)
      await refresh()
    },
    [refresh]
  )

  return {
    vaults,
    currentVault,
    sandbox,
    isLoading,
    refresh,
    removeVault
  }
}
