/**
 * Linking Approval Dialog (T117)
 *
 * Shown on existing device when new device scans QR code.
 * Allows user to approve or reject the linking request.
 */

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
import { Loader2, Smartphone } from 'lucide-react'

interface LinkingApprovalDialogProps {
  isOpen: boolean
  deviceInfo?: { name: string; platform: string }
  onApprove: () => void
  onReject: () => void
  isLoading?: boolean
}

function getPlatformLabel(platform: string): string {
  switch (platform.toLowerCase()) {
    case 'macos':
      return 'macOS'
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return platform || 'Unknown'
  }
}

export function LinkingApprovalDialog({
  isOpen,
  deviceInfo,
  onApprove,
  onReject,
  isLoading = false
}: LinkingApprovalDialogProps): React.JSX.Element {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onReject()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Link new device?</AlertDialogTitle>
          <AlertDialogDescription>
            A new device wants to access your account.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-4">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Smartphone className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="font-medium">{deviceInfo?.name ?? 'New device'}</p>
              <p className="text-sm text-muted-foreground">
                {getPlatformLabel(deviceInfo?.platform ?? '')}
              </p>
            </div>
          </div>

          <p className="text-sm text-muted-foreground mt-4">
            Only approve if you initiated this on your other device.
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onReject} disabled={isLoading}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={onApprove} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Approving...
              </>
            ) : (
              'Approve Link'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default LinkingApprovalDialog
