import { useState, useCallback, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Check, Copy, Download, Lock } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { RECOVERY_HEADING, RECOVERY_BODY, RECOVERY_HINT } from './recovery-phrase-styles'

interface RecoveryPhraseDisplayProps {
  phrase: string
  onContinue: () => void
}

const CLIPBOARD_CLEAR_DELAY_MS = 30_000
const COPIED_FEEDBACK_MS = 2000
const DOWNLOAD_NAME = 'memrynote-recovery-phrase.txt'

/** A plain text file the user keeps offline: one numbered word per line. */
function downloadPhrase(words: string[], title: string, note: string): void {
  const lines = words.map((word, i) => `${String(i + 1).padStart(2, ' ')}. ${word}`)
  const blob = new Blob([[title, note, '', ...lines, ''].join('\n')], {
    type: 'text/plain;charset=utf-8'
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = DOWNLOAD_NAME
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function RecoveryPhraseDisplay({
  phrase,
  onContinue
}: RecoveryPhraseDisplayProps): React.JSX.Element {
  const { t } = useT('settings')
  const [copied, setCopied] = useState(false)
  const words = phrase.split(' ')
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current)
      navigator.clipboard.writeText('').catch(() => {})
    }
  }, [])

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(phrase)
      setCopied(true)

      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)

      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current)
      clipboardClearTimerRef.current = setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {})
      }, CLIPBOARD_CLEAR_DELAY_MS)
    } catch {
      setCopied(false)
    }
  }, [phrase])

  return (
    <div className="@container [font-synthesis:none] flex w-full flex-col items-center text-xs/4">
      <div className="wizard-step-enter flex flex-col items-center gap-2.5 text-center">
        <h2 className={RECOVERY_HEADING}>{t('setup.recovery.displayTitle')}</h2>
        <p className={RECOVERY_BODY}>{t('setup.recovery.displayDescription')}</p>
      </div>

      {/* Column by column like the 24 numbered lines people copy it onto: 1-6, 7-12... */}
      <ul
        className="wizard-step-enter wiz-delay-2 grid grid-flow-col grid-rows-8 gap-x-2.5 gap-y-1.5 pt-[26px] @[540px]:grid-rows-6"
        aria-label={t('setup.recovery.wordsAria')}
      >
        {words.map((word, i) => (
          <li
            // oxlint-disable-next-line react/no-array-index-key -- positional list without stable ids; items are never reordered
            key={`${i}-${word}`}
            className="flex h-[34px] w-[112px] items-center gap-2 rounded-[7px] bg-surface px-3 @[540px]:w-[132px]"
            aria-label={t('setup.recovery.wordAria', { index: i + 1, word })}
          >
            <span className="w-4 shrink-0 select-none font-mono text-[11px] leading-[14px] text-text-tertiary">
              {i + 1}
            </span>
            <span className="select-all font-mono text-[13.5px] font-medium leading-[18px] text-foreground">
              {word}
            </span>
          </li>
        ))}
      </ul>

      <p className={RECOVERY_HINT}>
        <Lock className="size-3 shrink-0" aria-hidden="true" />
        {t('setup.recovery.warning')}
      </p>

      <div className="wizard-step-enter wiz-delay-3 flex flex-wrap items-center justify-center gap-3 pt-[22px]">
        <Button
          variant="outline"
          onClick={() => void handleCopy()}
          className="h-[38px] gap-1.5 px-4 text-sm font-medium"
          aria-label={copied ? t('setup.recovery.copiedAria') : t('setup.recovery.copyAria')}
        >
          {copied ? (
            <Check className="size-3.5 text-[var(--task-complete)]" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? t('setup.recovery.copied') : t('setup.recovery.copy')}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            downloadPhrase(words, t('setup.recovery.fileTitle'), t('setup.recovery.warning'))
          }
          className="h-[38px] gap-1.5 px-4 text-sm font-medium"
        >
          <Download className="size-3.5" />
          {t('setup.recovery.download')}
        </Button>
        <Button
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- deliberate: focus moves here when this field/dialog appears (keyboard users land on the primary input)
          autoFocus
          onClick={onContinue}
          className="h-[38px] gap-2.5 pe-2.5 ps-4 text-sm font-semibold shadow-none"
        >
          {t('setup.recovery.saved')}
          <Kbd
            aria-hidden="true"
            className="h-5 rounded-[4px] bg-black/10 px-1.5 font-mono text-[11px] font-medium text-current"
          >
            ↵
          </Kbd>
        </Button>
      </div>
    </div>
  )
}
