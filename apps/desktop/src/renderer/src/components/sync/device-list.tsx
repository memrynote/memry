import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Monitor,
  Smartphone,
  Laptop,
  MoreHorizontal,
  Pencil,
  Loader2,
  ChevronDown,
  ChevronUp,
  QrCode
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { deviceService } from '@/services/device-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

interface Device {
  id: string
  name: string
  platform: string
  isCurrentDevice: boolean
  lastSyncAt?: number
  linkedAt: number
}

interface DeviceListProps {
  onLinkDevice?: () => void
}

const PLATFORM_ICONS: Record<string, typeof Monitor> = {
  macos: Laptop,
  windows: Monitor,
  linux: Monitor,
  ios: Smartphone,
  android: Smartphone
}

const platformLabel = (platform: string): string => {
  const labels: Record<string, string> = {
    macos: 'macOS',
    windows: 'Windows',
    linux: 'Linux',
    ios: 'iOS',
    android: 'Android'
  }
  return labels[platform] ?? platform
}

const COLLAPSED_LIMIT = 3

export function DeviceList({ onLinkDevice }: DeviceListProps): React.JSX.Element {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Device | null>(null)
  const [renameTarget, setRenameTarget] = useState<Device | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const fetchDevices = useCallback(async () => {
    try {
      const result = await deviceService.getDevices()
      setDevices(result.devices)
    } catch {
      toast.error(t('devices.toasts.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void fetchDevices()
  }, [fetchDevices])

  const handleRemove = useCallback(async () => {
    if (!removeTarget) return
    setBusy(true)
    try {
      const result = await deviceService.removeDevice({ deviceId: removeTarget.id })
      if (result.success) {
        toast.success(t('devices.toasts.removed', { name: removeTarget.name }))
        setRemoveTarget(null)
        void fetchDevices()
      } else {
        toast.error(result.error ?? t('devices.toasts.removeFailed'))
      }
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('devices.toasts.removeFailed')))
    } finally {
      setBusy(false)
    }
  }, [removeTarget, fetchDevices, t])

  const handleRename = useCallback(async () => {
    if (!renameTarget || !newName.trim()) return
    setBusy(true)
    try {
      const result = await deviceService.renameDevice({
        deviceId: renameTarget.id,
        newName: newName.trim()
      })
      if (result.success) {
        toast.success(t('devices.toasts.renamed', { name: newName.trim() }))
        setRenameTarget(null)
        setNewName('')
        void fetchDevices()
      } else {
        toast.error(result.error ?? t('devices.toasts.renameFailed'))
      }
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('devices.toasts.renameFailed')))
    } finally {
      setBusy(false)
    }
  }, [renameTarget, newName, fetchDevices, t])

  const openRenameDialog = (device: Device): void => {
    setRenameTarget(device)
    setNewName(device.name)
  }

  const hasMore = devices.length > COLLAPSED_LIMIT
  const visibleDevices = useMemo(
    () => (expanded ? devices : devices.slice(0, COLLAPSED_LIMIT)),
    [devices, expanded]
  )
  const hiddenCount = devices.length - COLLAPSED_LIMIT

  if (loading) {
    return (
      <output
        className="flex items-center gap-2 py-4 text-xs text-muted-foreground"
        aria-label={t('devices.loadingAria')}
      >
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        {t('devices.loading')}
      </output>
    )
  }

  if (devices.length === 0) {
    return (
      <div className="flex flex-col rounded-lg border border-border overflow-clip">
        <div className="flex items-center justify-center h-12 px-4 text-xs text-muted-foreground">
          {t('devices.none')}
        </div>
        {onLinkDevice && (
          <>
            <div className="h-px bg-border shrink-0" />
            <button
              type="button"
              onClick={onLinkDevice}
              className="flex items-center gap-2.5 h-12 px-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <QrCode className="w-4 h-4" />
              {t('devices.linkNew')}
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col rounded-lg border border-border overflow-clip">
        {visibleDevices.map((device, i) => {
          const Icon = PLATFORM_ICONS[device.platform] ?? Monitor
          const syncLabel = device.lastSyncAt
            ? t('devices.lastSeen', {
                time: formatDistanceToNow(device.lastSyncAt, { addSuffix: false })
              })
            : t('devices.linked', {
                time: formatDistanceToNow(device.linkedAt, { addSuffix: false })
              })

          return (
            <Fragment key={device.id}>
              {i > 0 && <div className="h-px bg-border shrink-0" />}
              <div className="flex items-center justify-between h-12 px-4 shrink-0 group">
                <div className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex flex-col gap-px">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px]/4 font-medium text-foreground">
                        {device.name}
                      </span>
                      {device.isCurrentDevice && (
                        <span className="rounded-[10px] px-1.5 py-px text-[10px]/3.5 font-medium bg-green-500/15 text-green-600 dark:text-green-400">
                          {t('devices.thisDevice')}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px]/3.5 text-muted-foreground">
                      {t('devices.platformMeta', {
                        platform: platformLabel(device.platform),
                        detail: syncLabel
                      })}
                    </span>
                  </div>
                </div>

                {!device.isCurrentDevice && (
                  <div className="flex items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label={t('devices.renameAria', { name: device.name })}
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openRenameDialog(device)}>
                          <Pencil className="w-4 h-4 me-2" />
                          {t('devices.rename')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <button
                      type="button"
                      onClick={() => setRemoveTarget(device)}
                      className="text-xs text-destructive hover:text-destructive/80 transition-colors"
                    >
                      {t('devices.revoke')}
                    </button>
                  </div>
                )}
              </div>
            </Fragment>
          )
        })}

        {hasMore && (
          <>
            <div className="h-px bg-border shrink-0" />
            <button
              type="button"
              className="flex items-center justify-center gap-1.5 h-10 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              aria-label={
                expanded ? t('devices.showLess') : t('devices.showMoreAria', { count: hiddenCount })
              }
            >
              {expanded ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  {t('devices.showLess')}
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  {t('devices.showMore', { count: hiddenCount })}
                </>
              )}
            </button>
          </>
        )}

        {onLinkDevice && (
          <>
            <div className="h-px bg-border shrink-0" />
            <button
              type="button"
              onClick={onLinkDevice}
              className="flex items-center gap-2.5 h-12 px-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <QrCode className="w-4 h-4" />
              {t('devices.linkNew')}
            </button>
          </>
        )}
      </div>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('devices.dialogs.revokeTitle', { name: removeTarget?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('devices.dialogs.revokeDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRemove()}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? t('devices.dialogs.revoking') : t('devices.dialogs.revokeDevice')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('devices.dialogs.renameTitle')}</DialogTitle>
            <DialogDescription>{t('devices.dialogs.renameDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={100}
            placeholder={t('devices.dialogs.namePlaceholder')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) void handleRename()
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={busy}>
              {tCommon('button.cancel')}
            </Button>
            <Button onClick={() => void handleRename()} disabled={busy || !newName.trim()}>
              {busy ? t('devices.dialogs.renaming') : tCommon('button.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
