import { useState, useCallback, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '@/components/ui/button'
import { useCountdown } from '@/hooks/use-countdown'
import { extractErrorMessage } from '@/lib/ipc-error'
import { QrCode, RefreshCw, X, Loader2, Clock, AlertCircle } from 'lucide-react'

type QrState = 'loading' | 'ready' | 'expired' | 'error'

interface QrSession {
  qrData: string
  sessionId: string
  expiresAt: number
}

interface QrLinkingProps {
  onCancel: () => void
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
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 dark:bg-amber-400/10 flex items-center justify-center">
            <QrCode className="w-4.5 h-4.5 text-amber-700 dark:text-amber-400" />
          </div>
          <h3 className="font-display text-xl tracking-tight">Link a device</h3>
        </div>
        <Button variant="ghost" size="icon" onClick={onCancel} className="h-8 w-8">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
        Scan this code from your new device, or copy the linking code below.
      </p>

      <QrDisplay qrState={qrState} session={session} error={error} onRegenerate={generateQr} />
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
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-amber-600 dark:text-amber-400" />
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
          <Clock className="w-6 h-6 text-amber-700 dark:text-amber-400" />
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
    <div className="flex flex-col items-center gap-4">
      <div className="p-4 bg-white rounded-2xl border shadow-sm">
        <QRCodeSVG value={session.qrData} size={200} level="M" marginSize={0} />
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="w-3 h-3" />
        <span className="tabular-nums">Expires in {formattedTime}</span>
      </div>

      <Button variant="outline" size="sm" onClick={handleCopy} className="w-full max-w-[260px]">
        {copied ? 'Copied!' : 'Copy linking code'}
      </Button>
    </div>
  )
}
