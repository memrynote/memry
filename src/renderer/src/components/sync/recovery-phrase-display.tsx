/**
 * Recovery Phrase Display (T067)
 * 24-word grid display with copy and continue
 */

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Copy, Check, Download } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

interface RecoveryPhraseDisplayProps {
  phrase: string[]
  onContinue: () => void
  className?: string
}

export function RecoveryPhraseDisplay({
  phrase,
  onContinue,
  className
}: RecoveryPhraseDisplayProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(phrase.join(' '))
      setCopied(true)
      toast.success('Recovery phrase copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('[RecoveryPhraseDisplay] Copy failed:', err)
      toast.error('Failed to copy to clipboard')
    }
  }, [phrase])

  const handleDownload = useCallback(() => {
    const content = `Memry Recovery Phrase
========================
Generated: ${new Date().toISOString()}

IMPORTANT: Keep this file safe and secure!
Do not share it with anyone.

Your 24-word recovery phrase:
${phrase.map((word, i) => `${(i + 1).toString().padStart(2, ' ')}. ${word}`).join('\n')}

========================
This phrase is the ONLY way to recover your data if you lose access to all your devices.
Store it in a secure location, such as a password manager or a physical safe.
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
    toast.success('Recovery phrase downloaded')
  }, [phrase])

  return (
    <div className={cn('space-y-6', className)}>
      <div className="text-center space-y-2">
        <h2 className="text-xl font-semibold">Your recovery phrase</h2>
        <p className="text-sm text-muted-foreground">
          Write down these 24 words in order and store them securely
        </p>
      </div>

      <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-amber-700 dark:text-amber-400">
          <p className="font-medium">Never share your recovery phrase</p>
          <p className="mt-1 text-amber-600 dark:text-amber-500">
            Anyone with these words can access your data. Store them offline in a secure location.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 p-4 bg-muted rounded-lg">
        {phrase.map((word, index) => (
          <div
            key={index}
            className="flex items-center gap-2 p-2 bg-background rounded border text-sm"
          >
            <span className="text-muted-foreground w-5 text-right">{index + 1}.</span>
            <span className="font-mono font-medium">{word}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={handleCopy}>
          {copied ? (
            <>
              <Check className="w-4 h-4 mr-2" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-4 h-4 mr-2" />
              Copy
            </>
          )}
        </Button>
        <Button variant="outline" className="flex-1" onClick={handleDownload}>
          <Download className="w-4 h-4 mr-2" />
          Download
        </Button>
      </div>

      <div className="border-t pt-4 space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1"
          />
          <span className="text-sm text-muted-foreground">
            I have securely stored my recovery phrase and understand that losing it means I cannot
            recover my encrypted data if I lose access to all my devices.
          </span>
        </label>

        <Button className="w-full" onClick={onContinue} disabled={!acknowledged}>
          I've saved my recovery phrase
        </Button>
      </div>
    </div>
  )
}

export default RecoveryPhraseDisplay
