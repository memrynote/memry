import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Database, Import, RefreshCw } from '@/lib/icons'
import { useStorageUsage } from '@/hooks/use-storage-usage'
import { formatBytes } from '@/lib/format'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow
} from '@/components/settings/settings-primitives'
import { useT } from '@memry/i18n/renderer'
import { notesService, type ImportSourceType } from '@/services/notes-service'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'

const STORAGE_COLORS: Record<string, string> = {
  notes: '#6366f1',
  attachments: '#f97316',
  crdt: '#22c55e',
  other: '#8c8c8c'
}

export function VaultSettings() {
  const { t } = useT('settings')
  const { data, loading, refresh } = useStorageUsage()
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [importingSource, setImportingSource] = useState<ImportSourceType | null>(null)

  useEffect(() => {
    window.api.vault
      .getStatus()
      .then((status) => {
        if (status?.path) setVaultPath(status.path)
      })
      .catch(() => null)
  }, [])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await refresh()
    setIsRefreshing(false)
  }, [refresh])

  const handleReveal = useCallback(async () => {
    if (!vaultPath) return
    await window.api.vault.reveal()
  }, [vaultPath])

  const importSourceLabel = useCallback(
    (sourceType: ImportSourceType) => {
      switch (sourceType) {
        case 'obsidian':
          return t('vault.import.sources.obsidian')
        case 'notion':
          return t('vault.import.sources.notion')
        default:
          return t('vault.import.sources.files')
      }
    },
    [t]
  )

  const handleImport = useCallback(
    async (sourceType: ImportSourceType) => {
      setImportingSource(sourceType)
      try {
        const selected = await notesService.showImportDialog(sourceType)
        if (selected.canceled || selected.filePaths.length === 0) return

        const result = await notesService.importFiles(selected.filePaths, '', sourceType)
        const source = importSourceLabel(sourceType)

        if (result.imported > 0) {
          toast.success(t('vault.import.toasts.success', { count: result.imported, source }))
        }
        if (result.failed > 0) {
          toast.error(t('vault.import.toasts.partial', { count: result.failed, source }), {
            description: result.errors.join('\n')
          })
        }
      } catch (err) {
        toast.error(extractErrorMessage(err, t('vault.import.toasts.failed')))
      } finally {
        setImportingSource(null)
      }
    },
    [importSourceLabel, t]
  )

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

      <SettingsGroup label={t('vault.groups.import')}>
        <SettingRow
          label={t('vault.import.obsidian.label')}
          description={t('vault.import.obsidian.description')}
        >
          <Button
            variant="outline"
            size="sm"
            aria-label={t('vault.import.obsidian.aria')}
            onClick={() => void handleImport('obsidian')}
            disabled={importingSource !== null}
            className="h-7 ps-3 pe-3 text-xs/4 gap-1.5"
          >
            <Import className="w-3.5 h-3.5" />
            {importingSource === 'obsidian'
              ? t('vault.import.importing')
              : t('vault.import.obsidian.action')}
          </Button>
        </SettingRow>
        <SettingRow
          label={t('vault.import.notion.label')}
          description={t('vault.import.notion.description')}
        >
          <Button
            variant="outline"
            size="sm"
            aria-label={t('vault.import.notion.aria')}
            onClick={() => void handleImport('notion')}
            disabled={importingSource !== null}
            className="h-7 ps-3 pe-3 text-xs/4 gap-1.5"
          >
            <Database className="w-3.5 h-3.5" />
            {importingSource === 'notion'
              ? t('vault.import.importing')
              : t('vault.import.notion.action')}
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
