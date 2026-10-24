'use client'

import { useState } from 'react'
import { Loader2 } from '@/lib/icons'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { AccountVaultInfo } from '../../../preload/index.d'
import { useT } from '@memry/i18n/renderer'

interface DownloadVaultDialogProps {
  vault: AccountVaultInfo | null
  onClose: () => void
}

export function DownloadVaultDialog({ vault, onClose }: DownloadVaultDialogProps) {
  const { t } = useT('common')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [lastVaultUuid, setLastVaultUuid] = useState(vault?.vaultUuid)
  if (vault?.vaultUuid !== lastVaultUuid) {
    setLastVaultUuid(vault?.vaultUuid)
    setParentPath(null)
    setDownloading(false)
    setError(null)
  }

  if (!vault) return null

  const folderName = vault.suggestedPath.split('/').pop() ?? vault.vaultUuid.slice(0, 8)
  const displayPath = parentPath ? `${parentPath}/${folderName}` : vault.suggestedPath

  const handleChangeLocation = async (): Promise<void> => {
    const { path } = await window.api.syncLinking.pickVaultFolder()
    if (path) setParentPath(path)
  }

  const handleDownload = async (): Promise<void> => {
    setDownloading(true)
    setError(null)
    try {
      const result = await window.api.vault.downloadRemote(vault.vaultUuid, parentPath ?? undefined)
      if (!result.success) {
        setError(result.error ?? t('phaseF.componentsVaultSwitcher.downloadFailed'))
        setDownloading(false)
        return
      }
      onClose()
    } catch (err) {
      setError(extractErrorMessage(err, t('phaseF.componentsVaultSwitcher.downloadFailed')))
      setDownloading(false)
    }
  }

  return (
    <AlertDialog open={!!vault} onOpenChange={(o) => !o && !downloading && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('phaseF.componentsVaultSwitcher.downloadVaultTitle', {
              name: vault.name ?? t('phaseF.componentsVaultSwitcher.untitledVault')
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('phaseF.componentsVaultSwitcher.itemsCount', { count: vault.itemCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('phaseF.componentsVaultSwitcher.downloadLocation')}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate rounded border px-2 py-1 text-xs" dir="ltr">
              {displayPath}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleChangeLocation()}
              disabled={downloading}
            >
              {t('phaseF.componentsVaultSwitcher.changeLocation')}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={downloading}>
            {t('phaseF.componentsVaultSwitcher.cancel')}
          </Button>
          <Button onClick={() => void handleDownload()} disabled={downloading}>
            {downloading && <Loader2 className="size-3.5 animate-spin" />}
            {t('phaseF.componentsVaultSwitcher.download')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
