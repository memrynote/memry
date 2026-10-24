import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import type { ClockFormat } from '@/lib/time-format'

interface ReviewTimeInputProps {
  /** Canonical 24h "HH:MM". */
  value: string
  /** Called with a canonical 24h "HH:MM" whenever the user commits a change. */
  onChange: (value: string) => void
  clockFormat: ClockFormat
  className?: string
  'data-testid'?: string
}

function parseCanonical(value: string): { h24: number; m: number } {
  const [h, m] = value.split(':')
  const h24 = Number(h)
  const min = Number(m)
  return {
    h24: Number.isInteger(h24) ? Math.min(23, Math.max(0, h24)) : 18,
    m: Number.isInteger(min) ? Math.min(59, Math.max(0, min)) : 0
  }
}

function toCanonical(h24: number, m: number): string {
  return `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function to24Hour(hour12: number, period: 'AM' | 'PM'): number {
  const base = hour12 % 12 // 12 -> 0
  return period === 'PM' ? base + 12 : base
}

/**
 * A clock-format-aware time field for "HH:MM" values.
 *
 * Fixes two problems with a controlled `<input type="time">` here: (1) the value
 * is persisted asynchronously, so a native input's second digit got clobbered on
 * re-render mid-entry — this keeps a local draft per field so typing is never
 * interrupted, committing on blur; (2) a native input follows the OS locale for
 * 12h/24h, ignoring the user's `clockFormat` setting — this renders 24h or 12h
 * (with an AM/PM toggle) per that setting while always emitting canonical 24h.
 */
export function ReviewTimeInput({
  value,
  onChange,
  clockFormat,
  className,
  'data-testid': testId
}: ReviewTimeInputProps): React.JSX.Element {
  const { t } = useT('settings')
  const is12 = clockFormat === '12h'
  const { h24, m } = parseCanonical(value)
  const period: 'AM' | 'PM' = h24 >= 12 ? 'PM' : 'AM'
  const displayHour = is12 ? h24 % 12 || 12 : h24
  const paddedHour = String(displayHour).padStart(2, '0')
  const paddedMin = String(m).padStart(2, '0')

  // Local drafts: typing edits these, not the async-persisted value. Because a
  // change is only committed on blur (never per keystroke), `value` doesn't move
  // mid-entry, so the second digit is never clobbered by a re-render.
  const [hourDraft, setHourDraft] = useState(paddedHour)
  const [minDraft, setMinDraft] = useState(paddedMin)

  // Sync drafts from the value during render (React's recommended pattern, no
  // effect) whenever the value or clock format changes from outside.
  const key = `${value}|${clockFormat}`
  const [syncedKey, setSyncedKey] = useState(key)
  if (key !== syncedKey) {
    setSyncedKey(key)
    setHourDraft(paddedHour)
    setMinDraft(paddedMin)
  }

  const emit = (hStr: string, mStr: string, per: 'AM' | 'PM'): string => {
    const hNum = Number(hStr)
    const mNum = Number(mStr)
    const min = Number.isInteger(mNum) ? Math.min(59, Math.max(0, mNum)) : 0
    let h24Next: number
    if (is12) {
      const h12 = Number.isInteger(hNum) ? Math.min(12, Math.max(1, hNum)) : 12
      h24Next = to24Hour(h12, per)
    } else {
      h24Next = Number.isInteger(hNum) ? Math.min(23, Math.max(0, hNum)) : 0
    }
    const canonical = toCanonical(h24Next, min)
    onChange(canonical)
    return canonical
  }

  const normalizeFrom = (canonical: string): void => {
    const parsed = parseCanonical(canonical)
    const dh = is12 ? parsed.h24 % 12 || 12 : parsed.h24
    setHourDraft(String(dh).padStart(2, '0'))
    setMinDraft(String(parsed.m).padStart(2, '0'))
  }

  const handleBlur = (): void => {
    normalizeFrom(emit(hourDraft, minDraft, period))
  }

  const togglePeriod = (): void => {
    const next: 'AM' | 'PM' = period === 'AM' ? 'PM' : 'AM'
    normalizeFrom(emit(hourDraft, minDraft, next))
  }

  const idHour = testId ? `${testId}-hour` : undefined
  const idMinute = testId ? `${testId}-minute` : undefined
  const idPeriod = testId ? `${testId}-period` : undefined
  const fieldClass = 'w-10 h-7 text-center px-1 text-xs/4'

  return (
    <div data-testid={testId} className={cn('flex items-center gap-1', className)}>
      <Input
        data-testid={idHour}
        inputMode="numeric"
        maxLength={2}
        aria-label={t('inbox.reviewReminder.time.hourLabel')}
        value={hourDraft}
        onChange={(e) => setHourDraft(e.target.value.replace(/\D/g, '').slice(0, 2))}
        onBlur={handleBlur}
        className={fieldClass}
      />
      <span aria-hidden className="text-muted-foreground">
        :
      </span>
      <Input
        data-testid={idMinute}
        inputMode="numeric"
        maxLength={2}
        aria-label={t('inbox.reviewReminder.time.minuteLabel')}
        value={minDraft}
        onChange={(e) => setMinDraft(e.target.value.replace(/\D/g, '').slice(0, 2))}
        onBlur={handleBlur}
        className={fieldClass}
      />
      {is12 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={idPeriod}
          aria-label={t('inbox.reviewReminder.time.periodLabel')}
          onClick={togglePeriod}
          className="h-7 px-2 text-xs/4"
        >
          {period}
        </Button>
      )}
    </div>
  )
}
