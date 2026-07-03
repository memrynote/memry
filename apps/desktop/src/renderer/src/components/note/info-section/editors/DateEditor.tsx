import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { useDateFormat } from '@/hooks/use-date-format'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import { formatDate, parseDateInput } from '@/lib/format-date'
import { useT } from '@memry/i18n/renderer'

interface DateEditorProps {
  value: Date | null
  onChange: (value: Date | null) => void
  onBlur?: () => void
  defaultOpen?: boolean
}

// Self-managed like the select/status editors: the trigger stays mounted and
// Radix owns open/close, so the picker reopens on every click. (An earlier
// controlled-open version that unmounted on close couldn't be reopened without
// a remount.)
export function DateEditor({ value, onChange, onBlur, defaultOpen = false }: DateEditorProps) {
  const { t } = useT('notes')
  const dateFormat = useDateFormat()
  const { settings: taskPrefs } = useTaskPreferences()
  const weekStartsOn = taskPrefs.weekStartDay === 'sunday' ? 0 : 1

  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState('')

  // Close the picker and notify the consumer the editor is done (mirrors the
  // onBlur contract of the sibling text/number/url editors).
  const close = useCallback(() => {
    setOpen(false)
    onBlur?.()
  }, [onBlur])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        // Seed the text field with the current value each time it opens.
        setDraft(value ? formatDate(value, dateFormat) : '')
        setOpen(true)
      } else {
        close()
      }
    },
    [value, dateFormat, close]
  )

  const parsedDraft = draft ? parseDateInput(draft, dateFormat) : null
  const isValidFormat = !draft || parsedDraft !== null

  const commitText = useCallback(() => {
    if (!draft) {
      onChange(null)
      close()
      return
    }
    if (parsedDraft) {
      onChange(parsedDraft)
      close()
    }
    // invalid: keep open, red border shows
  }, [draft, parsedDraft, onChange, close])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="w-full text-start text-[13px] leading-4 text-foreground">
          {value ? (
            formatDate(value, dateFormat)
          ) : (
            <span className="text-text-tertiary">{t('properties.empty')}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-2">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitText()
            }
          }}
          aria-label={dateFormat}
          placeholder={dateFormat}
          className={cn('h-7', !isValidFormat && 'border-red-500 bg-red-500/10')}
        />
        <DatePickerCalendar
          selected={value ?? undefined}
          onSelect={(d) => {
            if (d) {
              onChange(d)
              close()
            }
          }}
          weekStartsOn={weekStartsOn}
          className="pt-2"
        />
      </PopoverContent>
    </Popover>
  )
}
