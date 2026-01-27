/**
 * QR Code Scanner Component (T116)
 *
 * Displays camera feed for scanning QR code on new device.
 * Uses html5-qrcode library for QR detection.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { AlertCircle, Loader2, VideoOff, Keyboard } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode'

type ScannerStatus =
  | 'initializing'
  | 'ready'
  | 'scanning'
  | 'permission-denied'
  | 'no-camera'
  | 'error'

interface QRScannerProps {
  onScanSuccess: (qrContent: string) => void
  onCancel: () => void
  isLoading?: boolean
  error?: string
  className?: string
}

const SCANNER_CONFIG = {
  fps: 10,
  qrbox: { width: 250, height: 250 },
  aspectRatio: 1.0
}

export function QRScanner({
  onScanSuccess,
  onCancel,
  isLoading = false,
  error: externalError,
  className
}: QRScannerProps): React.JSX.Element {
  const [status, setStatus] = useState<ScannerStatus>('initializing')
  const [internalError, setInternalError] = useState<string | null>(null)
  const [showManualEntry, setShowManualEntry] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hasScannedRef = useRef(false)
  const onScanSuccessRef = useRef(onScanSuccess)
  onScanSuccessRef.current = onScanSuccess

  const error = externalError ?? internalError

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        const state = scannerRef.current.getState()
        if (
          state === Html5QrcodeScannerState.SCANNING ||
          state === Html5QrcodeScannerState.PAUSED
        ) {
          await scannerRef.current.stop()
        }
      } catch (err) {
        console.warn('[QRScanner] Stop error:', err)
      }
      try {
        scannerRef.current.clear()
      } catch (err) {
        console.warn('[QRScanner] Clear error:', err)
      }
      scannerRef.current = null
    }
  }, [])

  const startScanner = useCallback(async () => {
    if (!containerRef.current || hasScannedRef.current) return

    setStatus('initializing')
    setInternalError(null)

    try {
      const devices = await Html5Qrcode.getCameras()

      if (devices.length === 0) {
        setStatus('no-camera')
        setInternalError('No camera found on this device')
        return
      }

      await stopScanner()

      const scannerId = 'qr-scanner-element'
      scannerRef.current = new Html5Qrcode(scannerId)

      await scannerRef.current.start(
        { facingMode: 'environment' },
        SCANNER_CONFIG,
        (decodedText) => {
          if (hasScannedRef.current) return
          hasScannedRef.current = true
          setStatus('scanning')
          onScanSuccessRef.current(decodedText)
        },
        () => {}
      )

      setStatus('ready')
    } catch (err) {
      console.warn('[QRScanner] Start error:', err)
      const errorMessage = err instanceof Error ? err.message : String(err)

      if (errorMessage.includes('Permission denied') || errorMessage.includes('NotAllowedError')) {
        setStatus('permission-denied')
        setInternalError('Camera access was denied. Please allow camera access to scan QR codes.')
      } else if (
        errorMessage.includes('NotFoundError') ||
        errorMessage.includes('Requested device not found')
      ) {
        setStatus('no-camera')
        setInternalError('No camera found on this device')
      } else {
        setStatus('error')
        setInternalError(errorMessage)
      }
    }
  }, [stopScanner])

  useEffect(() => {
    hasScannedRef.current = false
    startScanner()

    return () => {
      stopScanner()
    }
  }, [startScanner, stopScanner])

  useEffect(() => {
    if (externalError) {
      hasScannedRef.current = false
    }
  }, [externalError])

  const handleRetry = useCallback(() => {
    hasScannedRef.current = false
    startScanner()
  }, [startScanner])

  const handleCancel = useCallback(async () => {
    await stopScanner()
    onCancel()
  }, [stopScanner, onCancel])

  const handleManualSubmit = useCallback(() => {
    const trimmed = manualCode.trim()
    if (!trimmed) return
    hasScannedRef.current = true
    setStatus('scanning')
    onScanSuccess(trimmed)
  }, [manualCode, onScanSuccess])

  const handleSwitchToManual = useCallback(async () => {
    await stopScanner()
    setShowManualEntry(true)
  }, [stopScanner])

  const handleSwitchToCamera = useCallback(() => {
    setShowManualEntry(false)
    setManualCode('')
    hasScannedRef.current = false
    startScanner()
  }, [startScanner])

  if (status === 'permission-denied') {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
          <VideoOff className="w-8 h-8 text-amber-500" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">Camera Access Required</h3>
          <p className="text-sm text-muted-foreground">
            Please allow camera access in your browser settings to scan QR codes.
          </p>
        </div>

        <div className="flex gap-2 w-full">
          <Button variant="outline" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleRetry} className="flex-1">
            Try Again
          </Button>
        </div>
      </div>
    )
  }

  if (status === 'no-camera' || showManualEntry) {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
          <Keyboard className="w-8 h-8 text-muted-foreground" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">Enter Linking Code</h3>
          <p className="text-sm text-muted-foreground">
            Paste the code copied from your other device
          </p>
        </div>

        <textarea
          value={manualCode}
          onChange={(e) => setManualCode(e.target.value)}
          placeholder="Paste linking code here..."
          className="w-full h-24 p-3 text-xs font-mono border rounded-lg bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary"
          disabled={isLoading}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2 w-full">
          <Button variant="outline" onClick={handleCancel} className="flex-1" disabled={isLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleManualSubmit}
            className="flex-1"
            disabled={!manualCode.trim() || isLoading}
          >
            {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Link Device
          </Button>
        </div>

        {status !== 'no-camera' && (
          <button
            onClick={handleSwitchToCamera}
            className="text-xs text-muted-foreground hover:text-foreground underline"
            disabled={isLoading}
          >
            Use camera instead
          </button>
        )}
      </div>
    )
  }

  if (status === 'error' && !externalError) {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-destructive" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">Scanner Error</h3>
          <p className="text-sm text-muted-foreground">
            {internalError ?? 'Failed to start camera'}
          </p>
        </div>

        <div className="flex gap-2 w-full">
          <Button variant="outline" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleRetry} className="flex-1">
            Try Again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center space-y-4', className)}>
      <div
        ref={containerRef}
        className="relative w-full max-w-[300px] aspect-square rounded-lg overflow-hidden bg-black"
      >
        <div id="qr-scanner-element" className="w-full h-full" />

        {status === 'initializing' && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {status === 'ready' && !isLoading && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200px] h-[200px] border-2 border-primary rounded-lg" />
          </div>
        )}
      </div>

      <div className="text-center space-y-1">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Connecting to device...</p>
        ) : (
          <p className="text-sm text-muted-foreground">Point your camera at the QR code</p>
        )}
      </div>

      <Button variant="outline" onClick={handleCancel} disabled={isLoading}>
        Cancel
      </Button>

      <button
        onClick={handleSwitchToManual}
        className="text-xs text-muted-foreground hover:text-foreground underline"
        disabled={isLoading}
      >
        Enter code manually
      </button>
    </div>
  )
}

export default QRScanner
