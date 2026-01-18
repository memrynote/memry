/**
 * Recovery Phrase Display Component
 *
 * Displays a BIP39 24-word recovery phrase with copy functionality.
 *
 * @module components/sync/recovery-phrase-display
 */

import { useState, useCallback, useMemo } from 'react'
import { Copy, Check, Shield, AlertTriangle, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// =============================================================================
// Types
// =============================================================================

interface RecoveryPhraseDisplayProps {
  phrase: string
  onContinue?: () => void
  className?: string
}

// =============================================================================
// Component
// =============================================================================

/**
 * Recovery phrase display with security warning and copy functionality.
 */
export function RecoveryPhraseDisplay({
  phrase,
  onContinue,
  className
}: RecoveryPhraseDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  // Split phrase into words
  const words = useMemo(() => phrase.split(' ').filter(Boolean), [phrase])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(phrase)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }, [phrase])

  const handleDownload = useCallback(() => {
    const content = `Memry Recovery Phrase
====================

IMPORTANT: Keep this file secure and never share it with anyone.

Your 24-word recovery phrase:

${words.map((word, i) => `${String(i + 1).padStart(2, ' ')}. ${word}`).join('\n')}

====================
Generated: ${new Date().toISOString()}

WARNING: Anyone with this phrase can access your encrypted data.
Store it in a safe place and delete this file after writing it down.
`
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'memry-recovery-phrase.txt'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [words])

  return (
    <div className={cn('space-y-6', className)}>
      {/* Security Warning */}
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
        <div className="flex gap-3">
          <AlertTriangle className="size-5 shrink-0 text-yellow-500" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
              Write down your recovery phrase
            </p>
            <p className="text-sm text-muted-foreground">
              This is the only way to recover your account if you lose access to all devices. Store
              it in a safe place and never share it with anyone.
            </p>
          </div>
        </div>
      </div>

      {/* Recovery Phrase Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Your 24-word recovery phrase</h3>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              aria-label="Download recovery phrase"
            >
              <Download className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              aria-label={copied ? 'Copied' : 'Copy recovery phrase'}
            >
              {copied ? (
                <Check className="size-4 text-green-500" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/30 p-4 sm:grid-cols-4">
          {words.map((word, index) => (
            <div key={index} className="flex items-center gap-2 rounded bg-background px-3 py-2">
              <span className="text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
              <span className="font-mono text-sm">{word}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Security Info */}
      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="flex gap-3">
          <Shield className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="space-y-2">
            <p className="text-sm font-medium">Why is this important?</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>• Your data is encrypted with keys derived from this phrase</li>
              <li>• We cannot recover your data without this phrase</li>
              <li>• Store it on paper in a secure location</li>
              <li>• Never store it digitally or share it online</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Acknowledgment */}
      <div className="space-y-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1 rounded border-gray-300"
          />
          <span className="text-sm text-muted-foreground">
            I have written down my recovery phrase and stored it in a safe place. I understand that
            Memry cannot recover my data without this phrase.
          </span>
        </label>

        {onContinue && (
          <Button onClick={onContinue} className="w-full" disabled={!acknowledged}>
            Continue
          </Button>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Compact Version
// =============================================================================

interface RecoveryPhraseCompactProps {
  phrase: string
  className?: string
}

/**
 * Compact recovery phrase display (for confirmation dialogs).
 */
export function RecoveryPhraseCompact({ phrase, className }: RecoveryPhraseCompactProps) {
  const words = useMemo(() => phrase.split(' ').filter(Boolean), [phrase])

  return (
    <div className={cn('grid grid-cols-4 gap-1 text-xs', className)}>
      {words.map((word, index) => (
        <div key={index} className="rounded bg-muted px-2 py-1">
          <span className="text-muted-foreground">{index + 1}.</span>{' '}
          <span className="font-mono">{word}</span>
        </div>
      ))}
    </div>
  )
}
