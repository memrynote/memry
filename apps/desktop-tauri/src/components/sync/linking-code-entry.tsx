import { useState, useCallback, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { extractErrorMessage } from '@/lib/ipc-error'
import { ArrowLeft, Loader2, CheckCircle, AlertCircle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/ipc/invoke'
import { localDeviceName, localDevicePlatform } from '@/lib/device-metadata'

interface LinkingCodeEntryProps {
  onLinked: (sessionId: string, verificationCode?: string) => void
  onError: (error: string) => void
  onBack: () => void
}

function parseQrData(raw: string): { sessionId: string; ephemeralPublicKey: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'sessionId' in parsed &&
      'ephemeralPublicKey' in parsed &&
      typeof (parsed as Record<string, unknown>).sessionId === 'string' &&
      typeof (parsed as Record<string, unknown>).ephemeralPublicKey === 'string'
    ) {
      const obj = parsed as Record<string, string>
      return { sessionId: obj.sessionId, ephemeralPublicKey: obj.ephemeralPublicKey }
    }
    return null
  } catch {
    return null
  }
}

export function LinkingCodeEntry({
  onLinked,
  onError,
  onBack
}: LinkingCodeEntryProps): React.JSX.Element {
  const [code, setCode] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = code.trim() ? parseQrData(code.trim()) : null
  const isValid = parsed !== null

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      if (!parsed) return

      setIsLoading(true)
      setError(null)

      invoke<{ sessionId: string; sasCode: string }>('sync_linking_link_via_qr', {
        input: {
          qrJson: code.trim(),
          deviceName: localDeviceName(),
          devicePlatform: localDevicePlatform()
        }
      })
        .then((result) => {
          // Rust returns `LinkingScanView` only on success — Err is
          // surfaced via the .catch path below — so receiving a value
          // here implies the scan was accepted.
          onLinked(result.sessionId, result.sasCode)
        })
        .catch((err: unknown) => {
          const msg = extractErrorMessage(err, 'Failed to link device')
          setError(msg)
          onError(msg)
        })
        .finally(() => setIsLoading(false))
    },
    [code, parsed, onLinked, onError]
  )

  return (
    <div className="wizard-step-enter space-y-6">
      <div className="flex flex-col pb-1 gap-1.5">
        <div className="tracking-[-0.02em] font-semibold text-xl/6.5 text-foreground">
          Enter linking code
        </div>
        <div className="text-[13px]/4.5 text-muted-foreground">
          Paste the linking code from your other device to securely transfer your encryption keys.
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label
              htmlFor="linking-code"
              className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground"
            >
              Linking code
            </Label>
            {code.trim() && (
              <span
                className={cn(
                  'flex items-center gap-1 text-[11px] font-mono',
                  isValid ? 'text-green-500' : 'text-muted-foreground/70'
                )}
              >
                {isValid ? (
                  <>
                    <CheckCircle className="w-3 h-3" /> Valid
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-3 h-3" /> Invalid format
                  </>
                )}
              </span>
            )}
          </div>
          <textarea
            id="linking-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setError(null)
            }}
            disabled={isLoading}
            placeholder="Paste the code from your other device..."
            rows={4}
            autoFocus
            aria-describedby={error ? 'linking-error' : undefined}
            aria-invalid={!!error}
            className={cn(
              'flex w-full rounded-md border bg-background px-3 py-2.5 text-[15px] font-mono leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-[var(--tint)]/50 disabled:cursor-not-allowed disabled:opacity-50 resize-none',
              !code.trim() && 'border-input',
              code.trim() && !isValid && 'border-[var(--tint-border)]',
              isValid && 'border-green-500'
            )}
          />
          {error && (
            <p id="linking-error" className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {code.trim() && !isValid && !error && (
            <p className="text-[13px] text-muted-foreground/70">
              Paste the JSON linking code from your other device
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onBack}
            disabled={isLoading}
            className="gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>
          <Button
            type="submit"
            className="flex-1 h-9 bg-[var(--tint)] text-tint-foreground hover:bg-[var(--tint)]/90"
            disabled={isLoading || !isValid}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Linking...
              </>
            ) : (
              'Link device'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
