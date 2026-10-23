import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { AlertCircle, Clipboard, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { RECOVERY_BODY, RECOVERY_HEADING } from './recovery-phrase-styles'

interface RecoveryPhraseInputProps {
  onSubmit: (phrase: string) => void
  isLoading: boolean
  error: string | null
  onBack: () => void
}

const PROGRESS_STEPS = [
  'setup.recovery.progress.deriving',
  'setup.recovery.progress.validating',
  'setup.recovery.progress.registering'
] as const

const STEP_INTERVAL_MS = 2000

const WORD_COUNT = 24

const EMPTY = Array.from({ length: WORD_COUNT }, () => '')

const toWords = (text: string): string[] => text.trim().toLowerCase().split(/\s+/).filter(Boolean)

/**
 * The 24 words entered into the same numbered grid the phrase was shown in.
 * Pasting the whole phrase into any box fills the grid; Space, Tab and Enter
 * move to the next word.
 */
export function RecoveryPhraseInput({
  onSubmit,
  isLoading,
  error,
  onBack
}: RecoveryPhraseInputProps): React.JSX.Element {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const [words, setWords] = useState<string[]>(EMPTY)
  const [progressStep, setProgressStep] = useState(0)
  // The error belongs to the last attempt; editing a word after it hides it.
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const cells = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (!isLoading) return
    const timer = setInterval(() => {
      setProgressStep((prev) => Math.min(prev + 1, PROGRESS_STEPS.length - 1))
    }, STEP_INTERVAL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [isLoading])

  useEffect(() => {
    if (error) cells.current[0]?.focus()
  }, [error])

  const filled = words.filter(Boolean).length
  const complete = filled === WORD_COUNT
  const showError = !!error && error !== dismissedError && !isLoading
  const focusCell = (index: number): void => cells.current[index]?.focus()

  const update = (next: string[]): void => {
    setWords(next)
    setDismissedError(error)
  }

  /** Several words at once (a paste, or a space typed mid-word) spread over the grid. */
  const spread = (index: number, text: string): void => {
    const incoming = toWords(text)
    // A whole phrase fills from the first box wherever it was pasted.
    const start = incoming.length >= WORD_COUNT ? 0 : index
    const next = [...words]
    incoming.slice(0, WORD_COUNT - start).forEach((word, offset) => {
      next[start + offset] = word
    })
    update(next)
    focusCell(Math.min(start + incoming.length, WORD_COUNT - 1))
  }

  const change = (index: number, value: string): void => {
    if (/\s/.test(value.trim())) {
      spread(index, value)
      return
    }
    const next = [...words]
    next[index] = value.trim().toLowerCase()
    update(next)
    if (/\s$/.test(value) && value.trim()) focusCell(index + 1)
  }

  const keyDown = (index: number, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === ' ' || (event.key === 'Enter' && !complete)) {
      event.preventDefault()
      focusCell(index + 1)
    } else if (event.key === 'Backspace' && !words[index] && index > 0) {
      event.preventDefault()
      focusCell(index - 1)
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!complete || isLoading) return
    setProgressStep(0)
    setDismissedError(null)
    onSubmit(words.join(' '))
  }

  return (
    <form
      onSubmit={submit}
      // Esc steps back to the unlock choice, not out of the host (the wizard listens on window).
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isLoading) return
        event.preventDefault()
        event.stopPropagation()
        onBack()
      }}
      className="@container [font-synthesis:none] flex w-full flex-col items-center text-xs/4"
    >
      <div className="wizard-step-enter flex flex-col items-center gap-2.5 text-center">
        <h2 className={RECOVERY_HEADING}>{t('setup.recovery.inputTitle')}</h2>
        <p className={RECOVERY_BODY}>{t('setup.recovery.inputDescription')}</p>
      </div>

      <div className="wizard-step-enter wiz-delay-2 flex flex-col gap-3 pt-[26px]">
        {/* Column by column, like the phrase was shown: 1-6, 7-12... */}
        <div
          role="group"
          aria-label={t('setup.recovery.inputLabel')}
          className="grid grid-flow-col grid-rows-8 gap-x-2.5 gap-y-1.5 @[540px]:grid-rows-6"
        >
          {words.map((word, index) => (
            <label
              key={index}
              className={cn(
                'flex h-[34px] w-[112px] items-center gap-2 rounded-[7px] bg-surface px-3 ring-1 ring-inset transition-shadow focus-within:ring-foreground @[540px]:w-[132px]',
                showError ? 'ring-destructive/50' : word ? 'ring-transparent' : 'ring-border'
              )}
            >
              <span className="w-4 shrink-0 select-none font-mono text-[11px] leading-[14px] text-text-tertiary">
                {index + 1}
              </span>
              <input
                ref={(el) => {
                  cells.current[index] = el
                }}
                type="text"
                value={word}
                readOnly={isLoading}
                autoFocus={index === 0}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={t('setup.recovery.wordAria', { index: index + 1, word })}
                aria-invalid={showError}
                onChange={(event) => {
                  change(index, event.target.value)
                }}
                onKeyDown={(event) => {
                  keyDown(index, event)
                }}
                onPaste={(event) => {
                  const text = event.clipboardData.getData('text')
                  if (toWords(text).length < 2) return
                  event.preventDefault()
                  spread(index, text)
                }}
                className={cn(
                  'w-full min-w-0 bg-transparent font-mono text-[13.5px] font-medium leading-[18px] outline-none',
                  isLoading ? 'text-text-secondary' : 'text-foreground'
                )}
              />
            </label>
          ))}
        </div>

        <div className="flex items-start justify-between gap-4 text-[12.5px] leading-[18px]">
          {showError ? (
            <p role="alert" className="flex items-start gap-1.5 text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          ) : isLoading ? (
            <p className="text-text-secondary">
              {t('setup.recovery.stepOf', { step: progressStep + 1, total: PROGRESS_STEPS.length })}
            </p>
          ) : filled === 0 ? (
            <p className="flex items-center gap-1.5 text-text-secondary">
              <Clipboard className="size-3.5 shrink-0" aria-hidden="true" />
              {t('setup.recovery.pasteHint')}
            </p>
          ) : (
            <span />
          )}
          <span
            className={cn(
              'shrink-0 font-mono text-[11.5px] tabular-nums',
              complete ? 'text-foreground' : 'text-text-tertiary'
            )}
          >
            {t('setup.recovery.count', { count: filled, total: WORD_COUNT })}
          </span>
        </div>
      </div>

      <div className="wizard-step-enter wiz-delay-3 flex items-center gap-3 pt-[22px]">
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={isLoading}
          className="h-[38px] px-4 text-sm font-medium"
        >
          {tCommon('button.back')}
        </Button>
        <Button
          type="submit"
          disabled={isLoading || !complete}
          aria-busy={isLoading}
          className="h-[38px] gap-2.5 pe-2.5 ps-4 text-sm font-semibold shadow-none"
        >
          {isLoading ? (
            <>
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              {t(PROGRESS_STEPS[progressStep] ?? PROGRESS_STEPS[0])}
            </>
          ) : (
            <>
              {t('setup.recovery.restore')}
              <Kbd
                aria-hidden="true"
                className="h-5 rounded-[4px] bg-black/10 px-1.5 font-mono text-[11px] font-medium text-current"
              >
                ↵
              </Kbd>
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
