/**
 * Device Linking Modal
 *
 * Modal wrapper for the device linking flow on an existing device.
 * Shows QR code generation. Approval handling is delegated to GlobalLinkingApproval in App.tsx.
 *
 * @module components/sync/linking-modal
 */

import { useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { QRLinking } from './qr-linking'

// =============================================================================
// Types
// =============================================================================

interface LinkingModalProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Callback when the modal is closed */
  onClose: () => void
}

// =============================================================================
// Component
// =============================================================================

/**
 * Modal for initiating device linking from an existing device.
 *
 * This modal only displays the QR code for scanning by a new device.
 * When a new device scans the QR and sends a linking request, the approval
 * dialog is shown by GlobalLinkingApproval in App.tsx to avoid duplicate handlers.
 */
export function LinkingModal({ isOpen, onClose }: LinkingModalProps) {
  // Handle close - also resets state
  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  // Handle linking request callback from QRLinking (informational only)
  const handleLinkingRequest = useCallback(
    (_event: { sessionId: string; deviceName: string; devicePlatform: string }) => {
      // GlobalLinkingApproval in App.tsx handles the actual approval dialog.
      // This callback is just for potential local UI updates if needed.
    },
    []
  )

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="sr-only">
          <DialogTitle>Link a New Device</DialogTitle>
        </DialogHeader>
        <QRLinking onCancel={handleClose} onLinkingRequest={handleLinkingRequest} />
      </DialogContent>
    </Dialog>
  )
}

export default LinkingModal
