/**
 * QR Code Display Component for Device Linking (T115 + T119)
 *
 * Displays a QR code for linking a new device to an existing account.
 * Includes a 5-minute expiration timer with visual feedback.
 *
 * @module components/sync/qr-linking
 */

import { useState, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Loader2, Copy, Check, RefreshCw, AlertCircle, QrCode, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  useGenerateLinkingQR,
  useCancelLinking,
  useLinkingEvents
} from '@/hooks/use-device-linking'

// =============================================================================
// Types
// =============================================================================

interface QRLinkingProps {
  /** Called when user cancels the linking flow */
  onCancel: () => void
  /** Called when a new device requests to link (triggers approval dialog) */
  onLinkingRequest?: (event: {
    sessionId: string
    deviceName: string
    devicePlatform: string
  }) => void
  className?: string
}

type QRState = 'generating' | 'active' | 'expired' | 'error'

// =============================================================================
// Expiration Timer Component (T119)
// =============================================================================

interface ExpirationTimerProps {
  expiresAt: number
  onExpired: () => void
}

function ExpirationTimer({ expiresAt, onExpired }: ExpirationTimerProps) {
  const [timeRemaining, setTimeRemaining] = useState(() =>
    Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  )

  useEffect(() => {
    if (timeRemaining <= 0) {
      onExpired()
      return
    }

    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setTimeRemaining(remaining)
      if (remaining <= 0) {
        onExpired()
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [expiresAt, onExpired, timeRemaining])

  const minutes = Math.floor(timeRemaining / 60)
  const seconds = timeRemaining % 60
  const isLow = timeRemaining < 60
  const isCritical = timeRemaining < 30

  return (
    <div
      className={cn(
        'text-center',
        isCritical && 'text-destructive',
        isLow && !isCritical && 'text-yellow-500'
      )}
    >
      <p className="text-sm text-muted-foreground">Code expires in</p>
      <p className="text-2xl font-mono tabular-nums">
        {minutes}:{seconds.toString().padStart(2, '0')}
      </p>
    </div>
  )
}

// =============================================================================
// QR Linking Component
// =============================================================================

export function QRLinking({ onCancel, onLinkingRequest, className }: QRLinkingProps) {
  const [qrState, setQRState] = useState<QRState>('generating')
  const [qrData, setQRData] = useState<{ qrData: string; expiresAt: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generateQR = useGenerateLinkingQR()
  const cancelLinking = useCancelLinking()

  // Subscribe to linking request events
  useLinkingEvents({
    onLinkingRequest: (event) => {
      onLinkingRequest?.(event)
    }
  })

  // Generate QR code on mount
  const handleGenerateQR = useCallback(async () => {
    setQRState('generating')
    setError(null)
    setCopied(false)

    try {
      const result = await generateQR.mutateAsync()
      setQRData(result)
      setQRState('active')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate QR code')
      setQRState('error')
    }
  }, [generateQR])

  // Generate on mount
  useEffect(() => {
    handleGenerateQR()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle expiration
  const handleExpired = useCallback(() => {
    setQRState('expired')
  }, [])

  // Copy QR data to clipboard
  const handleCopy = useCallback(async () => {
    if (!qrData?.qrData) return

    try {
      await navigator.clipboard.writeText(qrData.qrData)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [qrData])

  // Cancel linking
  const handleCancel = useCallback(async () => {
    try {
      await cancelLinking.mutateAsync()
    } catch (err) {
      // Ignore cancel errors
    }
    onCancel()
  }, [cancelLinking, onCancel])

  return (
    <div className={cn('space-y-6', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <QrCode className="size-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Link a New Device</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={handleCancel} aria-label="Cancel linking">
          <X className="size-4" />
        </Button>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground">
        On your new device, open the app and select &quot;Link to Existing Account&quot;. Then scan
        this QR code or paste the linking code.
      </p>

      {/* QR Code Display */}
      <div className="flex flex-col items-center gap-4">
        {/* Generating State */}
        {qrState === 'generating' && (
          <div className="flex size-48 items-center justify-center rounded-lg border bg-muted/30">
            <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        )}

        {/* Active State - Show QR Code */}
        {qrState === 'active' && qrData && (
          <>
            <div className="rounded-lg border bg-white p-4">
              <QRCodeSVG value={qrData.qrData} size={192} level="M" includeMargin={false} />
            </div>
            <ExpirationTimer expiresAt={qrData.expiresAt} onExpired={handleExpired} />
          </>
        )}

        {/* Expired State */}
        {qrState === 'expired' && (
          <div className="flex size-48 flex-col items-center justify-center gap-2 rounded-lg border bg-muted/30">
            <AlertCircle className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Code expired</p>
          </div>
        )}

        {/* Error State */}
        {qrState === 'error' && (
          <div className="flex size-48 flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5">
            <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-3">
        {/* Copy Button - only show when active */}
        {qrState === 'active' && (
          <Button variant="outline" onClick={handleCopy} className="w-full" disabled={!qrData}>
            {copied ? (
              <>
                <Check className="mr-2 size-4 text-green-500" aria-hidden="true" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="mr-2 size-4" aria-hidden="true" />
                Copy Linking Code
              </>
            )}
          </Button>
        )}

        {/* Regenerate Button - show when expired or error */}
        {(qrState === 'expired' || qrState === 'error') && (
          <Button
            variant="default"
            onClick={handleGenerateQR}
            className="w-full"
            disabled={generateQR.isPending}
          >
            {generateQR.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Generating...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 size-4" aria-hidden="true" />
                Generate New Code
              </>
            )}
          </Button>
        )}

        {/* Cancel Button */}
        <Button variant="ghost" onClick={handleCancel} className="w-full">
          Cancel
        </Button>
      </div>

      {/* Help Text */}
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="text-xs text-muted-foreground">
          <strong>Security note:</strong> This code contains encrypted session information. Only
          share it with devices you own. The code expires in 5 minutes for security.
        </p>
      </div>
    </div>
  )
}

export default QRLinking
