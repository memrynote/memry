import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { RefreshCw } from '@/lib/icons'
import { useStorageUsage } from '@/hooks/use-storage-usage'
import { formatBytes } from '@/lib/format'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow
} from '@/components/settings/settings-primitives'

const STORAGE_COLORS: Record<string, string> = {
  notes: '#6366f1',
  attachments: '#f97316',
  crdt: '#22c55e',
  other: '#8c8c8c'
}

const STORAGE_LABELS: Record<string, string> = {
  notes: 'Notes',
  attachments: 'Attachments',
  crdt: 'CRDT',
  other: 'Other'
}

export function VaultSettings() {
  const { data, loading, refresh } = useStorageUsage()
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

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

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="Vault" subtitle="Vault configuration and storage" />

      <SettingsGroup label="Storage Usage">
        {loading ? (
          <div className="py-3 px-4">
            <p className="text-xs/4 text-muted-foreground">Loading storage info...</p>
          </div>
        ) : data ? (
          <div className="py-3 px-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[13px]/4 text-foreground">
                {formatBytes(data.used)} of {formatBytes(data.limit)} used
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
                    className="h-full first:rounded-l-full last:rounded-r-full"
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
                    {STORAGE_LABELS[key] ?? key}
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
            <p className="text-xs/4 text-muted-foreground">Sign in to view storage usage</p>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup label="Location">
        <SettingRow label="Vault Path" description={vaultPath ?? '~/Documents/memry'}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReveal}
            disabled={!vaultPath}
            className="h-7 px-3 text-xs/4"
          >
            Reveal
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
