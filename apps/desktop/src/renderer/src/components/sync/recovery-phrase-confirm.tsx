import { useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Check, X } from '@/lib/icons'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { RECOVERY_BODY, RECOVERY_HEADING } from './recovery-phrase-styles'

interface RecoveryPhraseConfirmProps {
  phrase: string
  onConfirmed: () => void
  onBack: () => void
}

const MIN_GAP = 2

function pickRandomIndices(wordCount: number): [number, number, number] {
  const arr = new Uint32Array(3)
  const maxAttempts = 1000
  for (let i = 0; i < maxAttempts; i++) {
    crypto.getRandomValues(arr)
    const indices = Array.from(arr).map((v) => v % wordCount)
    indices.sort((a, b) => a - b)
    const [a, b, c] = indices
    if (a !== b && b !== c && b - a >= MIN_GAP && c - b >= MIN_GAP) {
      return [a, b, c] as [number, number, number]
    }
  }
  return [0, Math.floor(wordCount / 2), wordCount - 1]
}

export function RecoveryPhraseConfirm({
  phrase,
  onConfirmed,
  onBack
}: RecoveryPhraseConfirmProps): React.JSX.Element {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const words = useMemo(() => phrase.split(' '), [phrase])
  const indices = useMemo(() => pickRandomIndices(words.length), [words.length])

  const [inputs, setInputs] = useState<[string, string, string]>(['', '', ''])
  const [touched, setTouched] = useState<[boolean, boolean, boolean]>([false, false, false])

  const matches = useMemo(
    () =>
      indices.map((idx, i) => inputs[i].trim().toLowerCase() === words[idx].toLowerCase()) as [
        boolean,
        boolean,
        boolean
      ],
    [indices, inputs, words]
  )

  const allCorrect = matches.every(Boolean)

  const handleChange = useCallback((slotIndex: number, value: string) => {
    setInputs((prev) => {
      const next = [...prev] as [string, string, string]
      next[slotIndex] = value
      return next
    })
  }, [])

  const handleBlur = useCallback((slotIndex: number) => {
    setTouched((prev) => {
      const next = [...prev] as [boolean, boolean, boolean]
      next[slotIndex] = true
      return next
    })
  }, [])

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (allCorrect) onConfirmed()
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- form-level keydown/paste delegation for the inputs inside; the form itself is not a control
    <form
      onSubmit={submit}
      // Esc steps back to the phrase, not out of the host (the wizard listens on window).
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onBack()
      }}
      className="@container [font-synthesis:none] flex w-full flex-col items-center text-xs/4"
    >
      <div className="wizard-step-enter flex flex-col items-center gap-2.5 text-center">
        <h2 className={RECOVERY_HEADING}>{t('setup.recovery.confirmTitle')}</h2>
        <p className={RECOVERY_BODY}>{t('setup.recovery.confirmDescription')}</p>
      </div>

      <div className="wizard-step-enter wiz-delay-2 flex w-full flex-col gap-3.5 pt-[30px] @[540px]:w-auto @[540px]:flex-row">
        {indices.map((wordIndex, slotIndex) => {
          const showFeedback = touched[slotIndex] && inputs[slotIndex].trim().length > 0
          const isCorrect = matches[slotIndex]
          const id = `recovery-word-${slotIndex}`

          return (
            <div key={wordIndex} className="flex flex-col gap-1.5 @[540px]:w-[150px]">
              <label
                htmlFor={id}
                className="flex items-center justify-between text-[12.5px] font-medium leading-4 text-foreground"
              >
                {t('setup.recovery.wordLabel', { index: wordIndex + 1 })}
                {showFeedback &&
                  (isCorrect ? (
                    <Check className="size-3.5 text-[var(--task-complete)]" aria-hidden="true" />
                  ) : (
                    <X className="size-3.5 text-destructive" aria-hidden="true" />
                  ))}
              </label>
              <input
                id={id}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={inputs[slotIndex]}
                onChange={(e) => handleChange(slotIndex, e.target.value)}
                onBlur={() => handleBlur(slotIndex)}
                placeholder={t('setup.recovery.wordShort', { index: wordIndex + 1 })}
                aria-label={t('setup.recovery.wordPlaceholder', { index: wordIndex + 1 })}
                aria-invalid={showFeedback && !isCorrect}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- deliberate: focus moves here when this field/dialog appears (keyboard users land on the primary input)
                autoFocus={slotIndex === 0}
                className={cn(
                  'h-10 rounded-lg bg-surface px-3 font-mono text-sm font-medium leading-[18px] text-foreground outline-none transition-shadow',
                  'placeholder:font-normal placeholder:text-[13px] placeholder:text-text-tertiary',
                  'ring-1 ring-inset focus-visible:ring-foreground',
                  showFeedback && !isCorrect
                    ? 'ring-destructive/60'
                    : inputs[slotIndex]
                      ? 'ring-text-tertiary'
                      : 'ring-border'
                )}
              />
            </div>
          )
        })}
      </div>

      <div className="wizard-step-enter wiz-delay-3 flex items-center gap-3 pt-[26px]">
        <Button
          type="submit"
          disabled={!allCorrect}
          className="h-[38px] gap-2.5 pe-2.5 ps-4 text-sm font-semibold shadow-none"
        >
          {t('setup.recovery.verify')}
          <Kbd
            aria-hidden="true"
            className="h-5 rounded-[4px] bg-black/10 px-1.5 font-mono text-[11px] font-medium text-current"
          >
            ↵
          </Kbd>
        </Button>
      </div>
      <p className="pt-3.5 text-[13px] text-text-secondary">{t('setup.recovery.mustMatch')}</p>
      <button
        type="button"
        onClick={onBack}
        className="mt-2 rounded-sm text-[13px] font-medium text-text-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {tCommon('button.back')}
      </button>
    </form>
  )
}
