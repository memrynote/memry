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
  SettingRow
} from '@/components/settings/settings-primitives'
import { LargeNotesWarning } from '@/components/settings/large-notes-warning'
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

export function VaultSettings() {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const { data, loading, refresh } = useStorageUsage()
  const { accountVaults, refresh: refreshAccountVaults } = useAccountVaults()
  const [vaultPath, setVaultPath] = useState<string | null>(null)
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

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('vault.header.title')} subtitle={t('vault.header.subtitle')} />

      <SettingsGroup label={t('vault.groups.storageUsage')}>
        {loading ? (
          <div className="py-3 px-4">
            <p className="text-xs/4 text-muted-foreground">{t('vault.loadingStorage')}</p>
          </div>
        ) : data ? (
          <div className="py-3 px-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[13px]/4 text-foreground">
                {t('vault.storage.used', {
                  used: formatBytes(data.used),
                  limit: formatBytes(data.limit)
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleRefresh()}
                disabled={isRefreshing}
                className="h-7 w-7 p-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            <div className="h-2 rounded-full bg-muted overflow-hidden flex">
              {Object.entries(data.breakdown).map(([key, bytes]) => {
                const pct = data.limit > 0 ? (bytes / data.limit) * 100 : 0
                if (pct < 0.5) return null
                return (
                  <div
                    key={key}
                    className="h-full first:rounded-s-full last:rounded-e-full"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c'
                    }}
                  />
                )
              })}
            </div>

            {Object.entries(data.breakdown).map(([key, bytes]) => (
              <div key={key} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c' }}
                  />
                  <span className="text-xs/4 text-muted-foreground">
                    {t(`vault.storage.categories.${key}`, { defaultValue: key })}
                  </span>
                </div>
                <span className="text-xs/4 text-muted-foreground tabular-nums">
                  {formatBytes(bytes)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-3 px-4">
            <p className="text-xs/4 text-muted-foreground">{t('vault.signInStorage')}</p>
          </div>
        )}
      </SettingsGroup>

      {/* Renders nothing unless a note is at or over the per-note sync ceiling. */}
      <LargeNotesWarning />

      <SettingsGroup label={t('vault.groups.accountVaults')}>
        {accountVaults.length === 0 ? (
          <div className="py-3 px-4">
            <p className="text-xs/4 text-muted-foreground">{t('vault.accountVaults.empty')}</p>
          </div>
        ) : (
          accountVaults.map((vault) => {
            const isActive = !!vault.localPath && vault.localPath === vaultPath
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
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isActive}
                  onClick={() => {
                    setDeleteError(null)
                    setVaultToDelete({ uuid: vault.vaultUuid, name })
                  }}
                  aria-label={`Delete ${name} from account`}
                  className="h-7 px-3 text-xs/4 text-destructive border-destructive/30 hover:bg-destructive/10"
                >
                  {t('vault.accountVaults.delete')}
                </Button>
              </SettingRow>
            )
          })
        )}
      </SettingsGroup>

      <SettingsGroup label={t('vault.groups.location')}>
        <SettingRow label={t('vault.vaultPath')} description={vaultPath ?? '~/Documents/memry'}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleReveal()}
            disabled={!vaultPath}
            className="h-7 px-3 text-xs/4"
          >
            {t('vault.reveal')}
          </Button>
        </SettingRow>
      </SettingsGroup>

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
