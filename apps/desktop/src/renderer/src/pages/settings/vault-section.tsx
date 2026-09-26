import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { RefreshCw } from '@/lib/icons'
import { useStorageUsage } from '@/hooks/use-storage-usage'
import { useAccountVaults } from '@/hooks/use-account-vaults'
import { extractErrorMessage } from '@/lib/ipc-error'
import { formatBytes } from '@/lib/format'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  SETTINGS_GROUP_LABEL,
  SETTINGS_LIST
} from '@/components/settings/settings-primitives'
import { LargeNotesWarning } from '@/components/settings/large-notes-warning'
import { DownloadVaultDialog } from '@/components/download-vault-dialog'
import { VaultActivitySettings } from '@/components/settings/vault-activity'
import type { SettingsFocusTarget } from '@/contexts/settings-modal-context'
import type { AccountVaultInfo } from '../../../../preload/index.d'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useT } from '@memry/i18n/renderer'

const STORAGE_COLORS: Record<string, string> = {
  notes: '#6366f1',
  attachments: '#f97316',
  crdt: '#22c55e',
  other: '#8c8c8c'
}

interface VaultSettingsProps {
  /** Forwarded to the activity log, which scrolls itself into view for `vault-activity`. */
  focusTarget?: SettingsFocusTarget | null
  focusRequestId?: number
}

export function VaultSettings({ focusTarget, focusRequestId }: VaultSettingsProps) {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const { data, loading, refresh } = useStorageUsage()
  const { accountVaults, refresh: refreshAccountVaults } = useAccountVaults()
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [currentVaultUuid, setCurrentVaultUuid] = useState<string | null>(null)
  const [currentVaultName, setCurrentVaultName] = useState<string | null>(null)
  const [vaultToDownload, setVaultToDownload] = useState<AccountVaultInfo | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [vaultToDelete, setVaultToDelete] = useState<{ uuid: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    window.api.vault
      .getStatus()
      .then((status) => {
        if (status?.path) setVaultPath(status.path)
      })
      .catch(() => null)
  }, [])

  // The vault registry knows which server vault each local folder belongs to.
  // Without it the section can only compare paths, and a vault that is open but
  // absent from the account looks indistinguishable from a synced one.
  useEffect(() => {
    window.api.vault
      .getAll?.()
      .then((result) => {
        const current = result?.vaults?.find((v) => v.path === result.currentVault)
        setCurrentVaultUuid(current?.vaultUuid ?? null)
        setCurrentVaultName(current?.name ?? null)
      })
      .catch(() => null)
  }, [])

  useEffect(() => {
    void refreshAccountVaults()
  }, [refreshAccountVaults])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await refresh()
    setIsRefreshing(false)
  }, [refresh])

  const handleReveal = useCallback(async () => {
    if (!vaultPath) return
    await window.api.vault.reveal()
  }, [vaultPath])

  const handleConfirmDelete = useCallback(async () => {
    if (!vaultToDelete) return
    setDeleting(true)
    try {
      await window.api.vault.deleteFromAccount(vaultToDelete.uuid)
      setVaultToDelete(null)
      await refreshAccountVaults()
    } catch (err) {
      setDeleteError(extractErrorMessage(err, t('vault.accountVaults.deleteFailed')))
    } finally {
      setDeleting(false)
    }
  }, [vaultToDelete, refreshAccountVaults, t])

  const handleSwitchTo = useCallback(
    async (path: string) => {
      setSwitchError(null)
      try {
        const result = await window.api.vault.switch(path)
        if (!result.success) {
          setSwitchError(result.error ?? t('vault.accountVaults.unsyncedSwitchFailed'))
        }
      } catch (err) {
        setSwitchError(extractErrorMessage(err, t('vault.accountVaults.unsyncedSwitchFailed')))
      }
    },
    [t]
  )

  // Sync refuses a vault that is not in the account (402 vault limit on paid
  // plans, silent no-op otherwise), and the list below only ever showed account
  // vaults — so the vault actually open could be missing from it with no sign.
  const isUnsyncedVault =
    !!currentVaultUuid &&
    accountVaults.length > 0 &&
    !accountVaults.some((vault) => vault.vaultUuid === currentVaultUuid)
  const suggestedVault = isUnsyncedVault
    ? (accountVaults.find((vault) => vault.localPath !== null) ?? accountVaults[0])
    : null
  const suggestedLocalPath = suggestedVault?.localPath ?? null

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('vault.header.title')} subtitle={t('vault.header.subtitle')} />

      <div className="flex flex-col pb-8">
        <h4 className={SETTINGS_GROUP_LABEL}>{t('vault.v2.groups.thisVault')}</h4>
        <div className={SETTINGS_LIST}>
          <div className="flex min-h-14 items-center justify-between gap-4 border-b border-border py-2.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[13px]/4 text-foreground">
                {currentVaultName ?? t('vault.vaultPath')}
              </span>
              <span className="truncate font-mono text-xs/4 text-muted-foreground">
                {vaultPath ?? '~/Documents/memry'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleReveal()}
              disabled={!vaultPath}
              className="shrink-0 text-xs/4 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
            >
              {t('vault.reveal')}
            </button>
          </div>

          <div
            className="flex flex-col gap-2.5 border-b border-border py-3"
            data-testid="vault-storage"
          >
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13px]/4 text-foreground">{t('vault.storage.title')}</span>
              {data && !loading && (
                <span className="flex items-center gap-2">
                  <span className="text-xs/4 text-muted-foreground tabular-nums">
                    {t('vault.storage.used', {
                      used: formatBytes(data.used),
                      limit: formatBytes(data.limit)
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRefresh()}
                    disabled={isRefreshing}
                    aria-label={t('vault.storage.refreshAria')}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw className={`size-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                  </button>
                </span>
              )}
            </div>

            {loading ? (
              <p className="text-xs/4 text-muted-foreground">{t('vault.loadingStorage')}</p>
            ) : data ? (
              <>
                <div
                  className="flex h-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={data.used}
                  aria-valuemax={data.limit}
                  aria-label={t('vault.storage.usageAria', {
                    used: formatBytes(data.used),
                    limit: formatBytes(data.limit)
                  })}
                >
                  {Object.entries(data.breakdown).map(([key, bytes]) => {
                    const pct = data.limit > 0 ? (bytes / data.limit) * 100 : 0
                    if (pct < 0.5) return null
                    return (
                      <div
                        key={key}
                        className="h-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c'
                        }}
                      />
                    )
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {Object.entries(data.breakdown).map(([key, bytes]) => (
                    <span key={key} className="inline-flex items-center gap-1.5 text-xs/4">
                      <span
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c' }}
                      />
                      <span className="text-muted-foreground">
                        {t(`vault.storage.categories.${key}`, { defaultValue: key })}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatBytes(bytes)}
                      </span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs/4 text-muted-foreground">{t('vault.signInStorage')}</p>
            )}
          </div>

          {/* Renders nothing unless a note is at or over the per-note sync ceiling. */}
          <LargeNotesWarning />
        </div>
      </div>

      <SettingsGroup label={t('vault.groups.accountVaults')}>
        {isUnsyncedVault && suggestedVault && (
          <div className="flex flex-col gap-2 py-3">
            <p className="inline-flex items-center gap-2 text-[13px]/4 text-foreground">
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
              {t('vault.accountVaults.unsyncedTitle')}
            </p>
            <p className="text-xs/4 text-muted-foreground">
              {accountVaults.length === 1
                ? t('vault.accountVaults.unsyncedBodyOne', {
                    name: suggestedVault.name ?? suggestedVault.vaultUuid
                  })
                : t('vault.accountVaults.unsyncedBodyMany')}
            </p>
            {suggestedLocalPath ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 self-start px-3 text-xs/4"
                onClick={() => void handleSwitchTo(suggestedLocalPath)}
              >
                {t('vault.accountVaults.unsyncedOpen')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 self-start px-3 text-xs/4"
                onClick={() => setVaultToDownload(suggestedVault)}
              >
                {t('vault.accountVaults.unsyncedDownload')}
              </Button>
            )}
            {switchError && <p className="text-xs/4 text-destructive">{switchError}</p>}
          </div>
        )}

        {accountVaults.length === 0 ? (
          <div className="py-3">
            <p className="text-xs/4 text-muted-foreground">{t('vault.accountVaults.empty')}</p>
          </div>
        ) : (
          accountVaults.map((vault) => {
            const isActive = currentVaultUuid
              ? vault.vaultUuid === currentVaultUuid
              : !!vault.localPath && vault.localPath === vaultPath
            const name = vault.name ?? vault.vaultUuid
            return (
              <SettingRow
                key={vault.vaultUuid}
                label={name}
                description={
                  isActive
                    ? t('vault.accountVaults.activeHint')
                    : (vault.localPath ??
                      `${t('vault.accountVaults.cloudOnly')} · ${t('vault.accountVaults.itemsCount', { count: vault.itemCount })}`)
                }
              >
                <button
                  type="button"
                  disabled={isActive}
                  onClick={() => {
                    setDeleteError(null)
                    setVaultToDelete({ uuid: vault.vaultUuid, name })
                  }}
                  aria-label={`Delete ${name} from account`}
                  className="text-xs/4 text-destructive transition-colors hover:text-destructive/80 disabled:text-muted-foreground disabled:opacity-50"
                >
                  {t('vault.accountVaults.delete')}
                </button>
              </SettingRow>
            )
          })
        )}
      </SettingsGroup>

      <VaultActivitySettings focusTarget={focusTarget} focusRequestId={focusRequestId} />

      <DownloadVaultDialog
        vault={vaultToDownload}
        onClose={() => {
          setVaultToDownload(null)
          void refreshAccountVaults()
        }}
      />

      <AlertDialog
        open={!!vaultToDelete}
        onOpenChange={(o) => {
          if (!o) {
            setVaultToDelete(null)
            setDeleteError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('vault.accountVaults.deleteTitle', { name: vaultToDelete?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('vault.accountVaults.deleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-xs/4 text-destructive px-1">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmDelete()
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('vault.accountVaults.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
