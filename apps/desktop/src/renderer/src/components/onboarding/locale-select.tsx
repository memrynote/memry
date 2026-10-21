import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '@memry/i18n/shared'
import type { Locale } from '@memry/contracts/locale-api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'

const log = createLogger('LocaleSelect')

function supportedLocale(language: string): Locale {
  const locale = language as Locale
  return SUPPORTED_LOCALES.includes(locale) ? locale : 'en'
}

/** Language picker for screens shown before a vault is open. */
export function LocaleSelect({
  className,
  ariaLabel,
  side = 'top'
}: {
  className?: string
  ariaLabel?: string
  /** Where the list opens; a picker at the top of the window opens downward. */
  side?: 'top' | 'bottom'
}): React.JSX.Element {
  const { i18n } = useT('common')
  const [changing, setChanging] = useState(false)
  const active = supportedLocale(i18n.resolvedLanguage ?? i18n.language)

  const change = async (locale: Locale): Promise<void> => {
    setChanging(true)
    try {
      await window.api.locale.set(locale)
      await i18n.changeLanguage(locale)
    } catch (error) {
      // The picker stays usable; the previous language keeps showing.
      log.warn('Changing the app language failed', error)
    } finally {
      setChanging(false)
    }
  }

  return (
    <Select
      value={active}
      onValueChange={(value) => void change(value as Locale)}
      disabled={changing}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn(
          'h-8 w-40 shrink-0 rounded-lg bg-surface text-xs leading-4 tracking-[0.005em] shadow-none',
          className
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        side={side}
        align="end"
        avoidCollisions={false}
        className="max-h-60 overflow-y-auto"
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <SelectItem key={locale} value={locale}>
            {LOCALE_DISPLAY_NAMES[locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
