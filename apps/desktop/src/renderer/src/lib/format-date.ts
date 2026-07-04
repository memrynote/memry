import { format, parse, isValid } from 'date-fns'
import type { GeneralSettings } from '@memry/contracts/settings-schemas'

export type DateFormat = GeneralSettings['dateFormat']

const PATTERNS: Record<DateFormat, string> = {
  'MM/DD/YYYY': 'MM/dd/yyyy',
  'DD/MM/YYYY': 'dd/MM/yyyy',
  'YYYY-MM-DD': 'yyyy-MM-dd',
  'DD.MM.YYYY': 'dd.MM.yyyy'
}

// ponytail: module-scoped current format so pure (non-React) helpers can format
// without threading a param. Default until useDateFormat() hydrates it; upgrade
// path is passing an explicit `f` at any call site.
let current: DateFormat = 'DD.MM.YYYY'

export function setDateFormatPref(f: DateFormat): void {
  current = f
}

export function getDateFormatPref(): DateFormat {
  return current
}

export function dateFnsPattern(f: DateFormat = current): string {
  return PATTERNS[f]
}

export function formatDate(date: Date, f: DateFormat = current): string {
  // date-fns format() throws RangeError on an invalid Date. Unparseable date
  // properties reach here as `new Date('...')` (Invalid Date), so guard instead
  // of letting the throw escape into React render and blow up the whole tab.
  if (!isValid(date)) return ''
  return format(date, PATTERNS[f])
}

export function parseDateInput(input: string, f: DateFormat = current): Date | null {
  const parsed = parse(input, PATTERNS[f], new Date())
  if (!isValid(parsed) || format(parsed, PATTERNS[f]) !== input) return null
  return parsed
}
