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
      toast.error('Failed to load devices')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchDevices()
  }, [fetchDevices])

  const handleRemove = useCallback(async () => {
    if (!removeTarget) return
    setBusy(true)
    try {
      const result = await deviceService.removeDevice({ deviceId: removeTarget.id })
      if (result.success) {
        toast.success(`Removed "${removeTarget.name}"`)
        setRemoveTarget(null)
        void fetchDevices()
      } else {
        toast.error(result.error ?? 'Failed to remove device')
      }
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, 'Failed to remove device'))
    } finally {
      setBusy(false)
    }
  }, [removeTarget, fetchDevices])

  const handleRename = useCallback(async () => {
    if (!renameTarget || !newName.trim()) return
    setBusy(true)
    try {
      const result = await deviceService.renameDevice({
        deviceId: renameTarget.id,
        newName: newName.trim()
      })
      if (result.success) {
        toast.success(`Renamed to "${newName.trim()}"`)
        setRenameTarget(null)
        setNewName('')
        void fetchDevices()
      } else {
        toast.error(result.error ?? 'Failed to rename device')
      }
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, 'Failed to rename device'))
    } finally {
      setBusy(false)
    }
  }, [renameTarget, newName, fetchDevices])

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
      <div
        className="flex items-center gap-2 py-4 text-xs text-muted-foreground"
        role="status"
        aria-label="Loading devices"
      >
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        Loading devices...
      </div>
    )
  }

  if (devices.length === 0) {
    return (
      <div className="flex flex-col rounded-lg border border-border overflow-clip">
        <div className="flex items-center justify-center h-12 px-4 text-xs text-muted-foreground">
          No devices linked yet
        </div>
        {onLinkDevice && (
          <>
            <div className="h-px bg-border shrink-0" />
            <button
              onClick={onLinkDevice}
              className="flex items-center gap-2.5 h-12 px-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <QrCode className="w-4 h-4" />
              Link new device
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
            ? `Last seen ${formatDistanceToNow(device.lastSyncAt, { addSuffix: false })} ago`
            : `Linked ${formatDistanceToNow(device.linkedAt, { addSuffix: false })} ago`

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
                          This device
                        </span>
                      )}
                    </div>
                    <span className="text-[11px]/3.5 text-muted-foreground">
                      {platformLabel(device.platform)} &middot; {syncLabel}
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
                          aria-label={`Rename ${device.name}`}
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openRenameDialog(device)}>
                          <Pencil className="w-4 h-4 mr-2" />
                          Rename
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <button
                      onClick={() => setRemoveTarget(device)}
                      className="text-xs text-destructive hover:text-destructive/80 transition-colors"
                    >
                      Revoke
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
              className="flex items-center justify-center gap-1.5 h-10 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? 'Show fewer devices'
                  : `Show ${hiddenCount} more ${hiddenCount === 1 ? 'device' : 'devices'}`
              }
            >
              {expanded ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  {hiddenCount} more {hiddenCount === 1 ? 'device' : 'devices'}
                </>
              )}
            </button>
          </>
        )}

        {onLinkDevice && (
          <>
            <div className="h-px bg-border shrink-0" />
            <button
              onClick={onLinkDevice}
              className="flex items-center gap-2.5 h-12 px-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <QrCode className="w-4 h-4" />
              Link new device
            </button>
          </>
        )}
      </div>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke &ldquo;{removeTarget?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This device will lose access to your synced data. It will need to be linked again to
              restore sync. Local data on that device will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? 'Revoking...' : 'Revoke device'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename device</DialogTitle>
            <DialogDescription>Choose a name to identify this device.</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={100}
            placeholder="Device name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) void handleRename()
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void handleRename()} disabled={busy || !newName.trim()}>
              {busy ? 'Renaming...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
