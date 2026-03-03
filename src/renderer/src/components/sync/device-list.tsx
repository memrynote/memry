import { useState, useEffect, useCallback, useMemo } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Monitor,
  Smartphone,
  Laptop,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Shield,
  ChevronDown,
  ChevronUp
} from 'lucide-react'
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

export function DeviceList(): React.JSX.Element {
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
        className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
        role="status"
        aria-label="Loading devices"
      >
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        Loading devices...
      </div>
    )
  }

  if (devices.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No devices linked yet.</p>
  }

  return (
    <>
      <div className="space-y-1">
        {visibleDevices.map((device) => {
          const Icon = PLATFORM_ICONS[device.platform] ?? Monitor
          const syncLabel = device.lastSyncAt
            ? `Synced ${formatDistanceToNow(device.lastSyncAt, { addSuffix: true })}`
            : `Linked ${formatDistanceToNow(device.linkedAt, { addSuffix: true })}`

          return (
            <div
              key={device.id}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted shrink-0">
                <Icon className="w-4 h-4 text-muted-foreground" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{device.name}</span>
                  {device.isCurrentDevice && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/10 text-primary shrink-0">
                      <Shield className="w-3 h-3" />
                      This device
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {platformLabel(device.platform)} &middot; {syncLabel}
                </p>
              </div>

              {!device.isCurrentDevice && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label={`Actions for ${device.name}`}
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openRenameDialog(device)}>
                      <Pencil className="w-4 h-4 mr-2" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setRemoveTarget(device)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )
        })}

        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs text-muted-foreground hover:text-foreground"
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
                <ChevronUp className="w-3.5 h-3.5 mr-1.5" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5 mr-1.5" />
                {hiddenCount} more {hiddenCount === 1 ? 'device' : 'devices'}
              </>
            )}
          </Button>
        )}
      </div>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove &ldquo;{removeTarget?.name}&rdquo;?</AlertDialogTitle>
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
              {busy ? 'Removing...' : 'Remove device'}
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
