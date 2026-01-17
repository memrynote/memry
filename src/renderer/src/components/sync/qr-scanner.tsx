/**
 * QR Scanner / Code Entry Component (T116)
 *
 * For desktop-to-desktop linking, uses clipboard paste instead of camera scanning.
 * Validates QR data format and expiration before submission.
 *
 * @module components/sync/qr-scanner
 */

import { useState, useCallback } from 'react'
import {
  Loader2,
  ClipboardPaste,
  AlertCircle,
  Smartphone,
  QrCode,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

// =============================================================================
// Types
// =============================================================================

interface QRScannerProps {
  /** Called when user submits valid QR data */
  onSubmit: (data: {
    qrData: string
    deviceName: string
  }) => Promise<void>
  /** Called when user cancels the flow */
  onCancel: () => void
  /** Whether submission is in progress */
  isLoading?: boolean
  /** External error message */
  error?: string | null
  className?: string
}

interface ParsedQRData {
  sessionId: string
  userId: string
  ephemeralPublicKey: string
  expiresAt: number
}

// =============================================================================
// Helper Functions
// =============================================================================

function parseQRData(data: string): ParsedQRData | null {
  try {
    const parsed = JSON.parse(data)

    // Validate required fields
    if (
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.ephemeralPublicKey !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }

    return parsed as ParsedQRData
  } catch {
    return null
  }
}

function isExpired(expiresAt: number): boolean {
  return Date.now() > expiresAt
}

function getDefaultDeviceName(): string {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac')) return "My Mac"
  if (platform.includes('win')) return "My Windows PC"
  if (platform.includes('linux')) return "My Linux Computer"
  return "My Computer"
}

// =============================================================================
// Component
// =============================================================================

export function QRScanner({
  onSubmit,
  onCancel,
  isLoading = false,
  error: externalError,
  className
}: QRScannerProps) {
  const [qrInput, setQRInput] = useState('')
  const [deviceName, setDeviceName] = useState(getDefaultDeviceName())
  const [validationError, setValidationError] = useState<string | null>(null)
  const [parsedData, setParsedData] = useState<ParsedQRData | null>(null)

  // Validate QR input on change
  const handleQRInputChange = useCallback((value: string) => {
    setQRInput(value)
    setValidationError(null)
    setParsedData(null)

    if (!value.trim()) return

    const parsed = parseQRData(value.trim())
    if (!parsed) {
      setValidationError('Invalid linking code format')
      return
    }

    if (isExpired(parsed.expiresAt)) {
      setValidationError('This linking code has expired. Please generate a new one on the other device.')
      return
    }

    setParsedData(parsed)
  }, [])

  // Paste from clipboard
  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      handleQRInputChange(text)
    } catch (err) {
      setValidationError('Failed to read from clipboard. Please paste manually.')
    }
  }, [handleQRInputChange])

  // Submit
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()

    if (!parsedData) {
      setValidationError('Please enter a valid linking code')
      return
    }

    if (!deviceName.trim()) {
      setValidationError('Please enter a device name')
      return
    }

    if (deviceName.trim().length > 100) {
      setValidationError('Device name must be 100 characters or less')
      return
    }

    try {
      await onSubmit({
        qrData: qrInput.trim(),
        deviceName: deviceName.trim()
      })
    } catch (err) {
      // Error is handled by parent via error prop
    }
  }, [parsedData, deviceName, qrInput, onSubmit])

  const displayError = externalError || validationError
  const isValid = parsedData !== null && deviceName.trim().length > 0
  const canSubmit = isValid && !isLoading

  return (
    <div className={cn('space-y-6', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Smartphone className="size-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Link to Existing Account</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onCancel}
          aria-label="Cancel"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground">
        On your existing device, go to Settings &gt; Devices &gt; Link New Device
        to get a linking code. Then paste it below.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* QR Data Input */}
        <div className="space-y-2">
          <Label htmlFor="qr-input">Linking Code</Label>
          <Textarea
            id="qr-input"
            placeholder="Paste linking code here..."
            value={qrInput}
            onChange={(e) => handleQRInputChange(e.target.value)}
            className={cn(
              'font-mono text-xs min-h-[80px]',
              parsedData && 'border-green-500/50 bg-green-500/5',
              validationError && 'border-destructive'
            )}
            disabled={isLoading}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handlePaste}
            disabled={isLoading}
            className="w-full"
          >
            <ClipboardPaste className="mr-2 size-4" aria-hidden="true" />
            Paste from Clipboard
          </Button>
        </div>

        {/* Validation Status */}
        {parsedData && (
          <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 p-3">
            <QrCode className="size-4 text-green-500" aria-hidden="true" />
            <span className="text-sm text-green-600 dark:text-green-400">
              Valid linking code detected
            </span>
          </div>
        )}

        {/* Device Name Input */}
        <div className="space-y-2">
          <Label htmlFor="device-name">Device Name</Label>
          <Input
            id="device-name"
            type="text"
            placeholder="Enter a name for this device"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            maxLength={100}
            disabled={isLoading}
          />
          <p className="text-xs text-muted-foreground">
            This name will help you identify this device in your account settings.
          </p>
        </div>

        {/* Error Message */}
        {displayError && (
          <div
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
            role="alert"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <p className="text-sm text-destructive">{displayError}</p>
          </div>
        )}

        {/* Actions */}
        <div className="space-y-3 pt-2">
          <Button
            type="submit"
            className="w-full"
            disabled={!canSubmit}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Connecting...
              </>
            ) : (
              'Link Device'
            )}
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            className="w-full"
            disabled={isLoading}
          >
            Cancel
          </Button>
        </div>
      </form>

      {/* Help Text */}
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="text-xs text-muted-foreground">
          <strong>Note:</strong> After submitting, the other device will need
          to approve this linking request. Keep this window open until the
          process completes.
        </p>
      </div>
    </div>
  )
}

export default QRScanner
