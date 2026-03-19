import { useState, useCallback, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { extractErrorMessage } from '@/lib/ipc-error'
import { ArrowLeft, Link2, Loader2 } from '@/lib/icons'

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

      window.api.syncLinking
        .linkViaQr({ qrData: code.trim() })
        .then((result) => {
          if (!result.success) {
            const msg = result.error ?? 'Linking failed'
            setError(msg)
            onError(msg)
            return
          }
          onLinked(parsed.sessionId, result.verificationCode)
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
      <div className="space-y-2">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 dark:bg-amber-400/10 flex items-center justify-center">
            <Link2 className="w-4.5 h-4.5 text-amber-700 dark:text-amber-400" />
          </div>
          <h3 className="font-display text-xl tracking-tight">Enter linking code</h3>
        </div>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
          Paste the linking code from your other device to securely transfer your encryption keys.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2.5">
          <Label
            htmlFor="linking-code"
            className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground"
          >
            Linking code
          </Label>
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
            className="flex w-full rounded-md border border-input bg-background px-3 py-2.5 text-[15px] font-mono leading-relaxed ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-600/15 focus-visible:border-amber-600/50 dark:focus-visible:ring-amber-400/10 dark:focus-visible:border-amber-400/40 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
          />
          {error && (
            <p id="linking-error" className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {code.trim() && !isValid && !error && (
            <p className="text-sm text-muted-foreground">
              Invalid format. The linking code should be a JSON string from your other device.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={isLoading}
            className="gap-1.5 text-muted-foreground"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>
          <Button type="submit" className="flex-1 h-11" disabled={isLoading || !isValid}>
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
