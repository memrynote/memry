import { useState, useCallback, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useCountdown } from '@/hooks/use-countdown'
import { extractErrorMessage } from '@/lib/ipc-error'
import { RefreshCw, Loader2, Clock, AlertCircle, Copy, Lock } from '@/lib/icons'

type QrState = 'loading' | 'ready' | 'expired' | 'error'

interface QrSession {
  qrData: string
  sessionId: string
  expiresAt: number
}

interface QrLinkingProps {
  onCancel: () => void
}

function truncateCode(code: string, maxLen = 32): string {
  if (code.length <= maxLen) return code
  const half = Math.floor((maxLen - 3) / 2)
  return `${code.slice(0, half)}...${code.slice(-half)}`
}

export function QrLinking({ onCancel }: QrLinkingProps): React.JSX.Element {
  const [qrState, setQrState] = useState<QrState>('loading')
  const [session, setSession] = useState<QrSession | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generateQr = useCallback(() => {
    setQrState('loading')
    setError(null)
    window.api.syncLinking
      .generateLinkingQr()
      .then((result) => {
        if (!result.qrData || !result.sessionId || !result.expiresAt) {
          setQrState('error')
          setError('Failed to generate linking code')
          return
        }
        setSession({
          qrData: result.qrData,
          sessionId: result.sessionId,
          expiresAt: result.expiresAt
        })
        setQrState('ready')
      })
      .catch((err: unknown) => {
        setQrState('error')
        setError(extractErrorMessage(err, 'Failed to generate linking code'))
      })
  }, [])

  useEffect(() => {
    const t = setTimeout(generateQr, 0)
    return () => clearTimeout(t)
  }, [generateQr])

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <DialogTitle className="font-heading text-xl font-semibold tracking-tight text-foreground">
          Link new device
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          Scan this QR code from the device you want to link to transfer your encryption keys
          securely.
        </DialogDescription>
      </div>

      <QrDisplay qrState={qrState} session={session} error={error} onRegenerate={generateQr} />

      <Button variant="outline" className="w-full rounded-[10px]" onClick={onCancel}>
        Cancel
      </Button>

      <div className="flex items-center gap-1.5 text-muted-foreground/60">
        <Lock className="w-3 h-3" />
        <span className="text-[11px]">End-to-end encrypted</span>
      </div>
    </div>
  )
}

function QrDisplay({
  qrState,
  session,
  error,
  onRegenerate
}: {
  qrState: QrState
  session: QrSession | null
  error: string | null
  onRegenerate: () => void
}): React.JSX.Element {
  if (qrState === 'loading') {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 gap-3"
        role="status"
        aria-label="Generating linking code"
      >
        <Loader2
          className="w-8 h-8 animate-spin text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">Generating linking code...</p>
      </div>
    )
  }

  if (qrState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3">
        <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="w-6 h-6 text-destructive" />
        </div>
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onRegenerate} className="gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" />
          Try again
        </Button>
      </div>
    )
  }

  if (qrState === 'ready' && session) {
    return <QrReady session={session} onRegenerate={onRegenerate} />
  }

  return <></>
}

function QrReady({
  session,
  onRegenerate
}: {
  session: QrSession
  onRegenerate: () => void
}): React.JSX.Element {
  const { formattedTime, isExpired } = useCountdown(session.expiresAt)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(session.qrData).then(() => setCopied(true))
  }, [session.qrData])

  if (isExpired) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 dark:bg-amber-400/10 flex items-center justify-center">
          <Clock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
        </div>
        <p className="text-sm text-muted-foreground">Linking code expired</p>
        <Button variant="outline" size="sm" onClick={onRegenerate} className="gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" />
          Generate new code
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div
        className="p-5 bg-white rounded-[14px] shadow-sm"
        aria-label="QR code for device linking"
      >
        <QRCodeSVG
          value={session.qrData}
          size={180}
          level="M"
          marginSize={0}
          role="img"
          aria-label="Device linking QR code"
        />
      </div>

      <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <Clock className="w-3.5 h-3.5" />
        <span className="text-[13px] font-medium tabular-nums">Expires in {formattedTime}</span>
      </div>

      <div className="flex items-center gap-3 w-full">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <div className="w-full space-y-2">
        <span className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground">
          Linking code
        </span>
        <div className="flex items-center gap-2 rounded-[10px] bg-foreground/[0.04] border border-border px-3.5 py-2.5 min-w-0">
          <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[13px] text-muted-foreground">
            {truncateCode(session.qrData)}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 flex items-center gap-1.5 rounded-md bg-foreground/[0.06] px-2.5 py-1 text-muted-foreground transition-colors hover:bg-foreground/[0.1]"
            aria-label={copied ? 'Copied' : 'Copy linking code'}
          >
            <Copy className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
