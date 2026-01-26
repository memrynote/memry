/**
 * QR Code Linking Component (T115, T119)
 *
 * Displays QR code for device linking on existing device.
 * Includes expiration countdown and status handling.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw, AlertCircle, QrCode } from 'lucide-react'
import { cn, formatCountdown } from '@/lib/utils'
import { LinkingApprovalDialog } from './linking-approval-dialog'
import type {
  CreateLinkingSessionResponse,
  GetLinkingStatusResponse
} from '@shared/contracts/ipc-sync'
import type { Device } from '@shared/contracts/sync-api'

type LinkingStatus =
  | 'generating'
  | 'waiting'
  | 'scanned'
  | 'approved'
  | 'completed'
  | 'expired'
  | 'error'

const LINKING_POLL_INTERVAL_MS = 2000

interface QRLinkingProps {
  onLinkingComplete: (device: Device) => void
  onCancel: () => void
  className?: string
}

interface ScannedDeviceInfo {
  name: string
  platform: string
}

interface LinkingEventData {
  sessionId?: string
  deviceName?: string
  platform?: string
  device?: Device
}

function isLinkingEvent(event: unknown): event is LinkingEventData {
  return typeof event === 'object' && event !== null && 'sessionId' in event
}

export function QRLinking({
  onLinkingComplete,
  onCancel,
  className
}: QRLinkingProps): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [status, setStatus] = useState<LinkingStatus>('generating')
  const [error, setError] = useState<string | null>(null)
  const [scannedDevice, setScannedDevice] = useState<ScannedDeviceInfo | null>(null)
  const [isApproving, setIsApproving] = useState(false)

  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const isMountedRef = useRef(true)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  const createSession = useCallback(async () => {
    setStatus('generating')
    setError(null)
    setQrCodeDataUrl(null)
    setSessionId(null)
    setScannedDevice(null)

    try {
      const response: CreateLinkingSessionResponse = await window.api.sync.createLinkingSession()

      if (!isMountedRef.current) return

      if (response.error) {
        setError(response.error)
        setStatus('error')
        return
      }

      setSessionId(response.sessionId)
      setQrCodeDataUrl(response.qrCodeDataUrl)
      setExpiresAt(response.expiresAt)
      setStatus('waiting')
    } catch (err) {
      if (!isMountedRef.current) return
      console.error('[QRLinking] Failed to create session:', err)
      setError(err instanceof Error ? err.message : 'Failed to create linking session')
      setStatus('error')
    }
  }, [])

  const pollStatus = useCallback(async () => {
    if (!sessionId || !isMountedRef.current) return

    try {
      const response: GetLinkingStatusResponse = await window.api.sync.getLinkingStatus({
        sessionId
      })

      if (!isMountedRef.current || !response.session) return

      const session = response.session

      switch (session.status) {
        case 'scanned':
          stopPolling()
          setStatus('scanned')
          setScannedDevice({
            name: 'New device',
            platform: 'unknown'
          })
          break

        case 'approved':
          setStatus('approved')
          break

        case 'completed':
          stopPolling()
          setStatus('completed')
          break

        case 'expired':
          stopPolling()
          setStatus('expired')
          break
      }
    } catch (err) {
      console.error('[QRLinking] Status poll error:', err)
    }
  }, [sessionId, stopPolling])

  useEffect(() => {
    isMountedRef.current = true
    createSession()

    return () => {
      isMountedRef.current = false
      stopPolling()
    }
  }, [createSession, stopPolling])

  useEffect(() => {
    if (status === 'waiting' && sessionId) {
      pollingRef.current = setInterval(pollStatus, LINKING_POLL_INTERVAL_MS)
    }

    return () => {
      stopPolling()
    }
  }, [status, sessionId, pollStatus, stopPolling])

  useEffect(() => {
    if (!expiresAt || status !== 'waiting') return

    const updateCountdown = (): void => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setCountdown(remaining)

      if (remaining === 0) {
        setStatus('expired')
        stopPolling()
      }
    }

    updateCountdown()
    const timer = setInterval(updateCountdown, 1000)

    return () => clearInterval(timer)
  }, [expiresAt, status, stopPolling])

  useEffect(() => {
    const unsubScanned = window.api.onLinkingScanned((event: unknown) => {
      if (!isMountedRef.current || !isLinkingEvent(event)) return
      if (event.sessionId === sessionId) {
        setStatus('scanned')
        setScannedDevice({
          name: event.deviceName ?? 'New device',
          platform: event.platform ?? 'unknown'
        })
        stopPolling()
      }
    })

    const unsubApproved = window.api.onLinkingApproved((event: unknown) => {
      if (!isMountedRef.current || !isLinkingEvent(event)) return
      if (event.sessionId === sessionId) {
        setStatus('approved')
      }
    })

    const unsubCompleted = window.api.onLinkingCompleted((event: unknown) => {
      if (!isMountedRef.current || !isLinkingEvent(event)) return
      if (event.sessionId === sessionId && event.device) {
        setStatus('completed')
        stopPolling()
        onLinkingComplete(event.device)
      }
    })

    const unsubExpired = window.api.onLinkingExpired((event: unknown) => {
      if (!isMountedRef.current || !isLinkingEvent(event)) return
      if (event.sessionId === sessionId) {
        setStatus('expired')
        stopPolling()
      }
    })

    return () => {
      unsubScanned()
      unsubApproved()
      unsubCompleted()
      unsubExpired()
    }
  }, [sessionId, onLinkingComplete, stopPolling])

  const handleApprove = useCallback(async () => {
    if (!sessionId) return

    setIsApproving(true)
    try {
      const response = await window.api.sync.approveLinking({ sessionId })

      if (!response.success) {
        setError(response.error ?? 'Failed to approve linking')
        setIsApproving(false)
        return
      }

      setStatus('approved')
    } catch (err) {
      console.error('[QRLinking] Approve error:', err)
      setError(err instanceof Error ? err.message : 'Failed to approve linking')
    } finally {
      setIsApproving(false)
    }
  }, [sessionId])

  const handleReject = useCallback(async () => {
    if (!sessionId) return

    try {
      await window.api.sync.cancelLinking(sessionId)
    } catch (err) {
      console.warn('[QRLinking] Cancel error:', err)
    }

    setScannedDevice(null)
    setStatus('waiting')
    stopPolling()
    pollingRef.current = setInterval(pollStatus, LINKING_POLL_INTERVAL_MS)
  }, [sessionId, pollStatus, stopPolling])

  const handleCancel = useCallback(async () => {
    if (sessionId) {
      try {
        await window.api.sync.cancelLinking(sessionId)
      } catch (err) {
        console.error('[QRLinking] Cancel error:', err)
      }
    }
    onCancel()
  }, [sessionId, onCancel])

  if (status === 'expired') {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-amber-500" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">QR Code Expired</h3>
          <p className="text-sm text-muted-foreground">
            The QR code has expired. Generate a new one to continue.
          </p>
        </div>

        <div className="flex gap-2 w-full">
          <Button variant="outline" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
          <Button onClick={createSession} className="flex-1">
            <RefreshCw className="w-4 h-4 mr-2" />
            Generate New QR
          </Button>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-destructive" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">Something went wrong</h3>
          <p className="text-sm text-muted-foreground">
            {error ?? 'Failed to create linking session'}
          </p>
        </div>

        <div className="flex gap-2 w-full">
          <Button variant="outline" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
          <Button onClick={createSession} className="flex-1">
            <RefreshCw className="w-4 h-4 mr-2" />
            Try Again
          </Button>
        </div>
      </div>
    )
  }

  if (status === 'generating') {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-[200px] h-[200px] rounded-lg bg-muted flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>

        <div className="text-center space-y-1">
          <p className="text-sm text-muted-foreground">Generating QR code...</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
      {qrCodeDataUrl ? (
        <div className="relative">
          <img
            src={qrCodeDataUrl}
            alt="Device linking QR code"
            className="w-[200px] h-[200px] rounded-lg border"
          />
          {status === 'approved' && (
            <div className="absolute inset-0 bg-background/80 flex items-center justify-center rounded-lg">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          )}
        </div>
      ) : (
        <div className="w-[200px] h-[200px] rounded-lg bg-muted flex items-center justify-center">
          <QrCode className="w-12 h-12 text-muted-foreground" />
        </div>
      )}

      <div className="text-center space-y-1">
        {status === 'waiting' && (
          <>
            <p className="font-medium">Scan with your other device</p>
            <p className="text-sm text-muted-foreground">
              Expires in: {formatCountdown(countdown)}
            </p>
          </>
        )}
        {status === 'approved' && (
          <p className="text-sm text-muted-foreground">Completing device linking...</p>
        )}
      </div>

      <Button variant="outline" onClick={handleCancel}>
        Cancel
      </Button>

      <LinkingApprovalDialog
        isOpen={status === 'scanned' && scannedDevice !== null}
        deviceInfo={scannedDevice ?? undefined}
        onApprove={handleApprove}
        onReject={handleReject}
        isLoading={isApproving}
      />
    </div>
  )
}

export default QRLinking
