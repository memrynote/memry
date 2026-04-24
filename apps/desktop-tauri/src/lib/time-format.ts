import type { GeneralSettings } from '@memry/contracts/settings-schemas'

export type ClockFormat = GeneralSettings['clockFormat']

export function formatHour(hour: number, format: ClockFormat): string {
  if (format === '24h') {
    return `${String(hour).padStart(2, '0')}:00`
  }
  if (hour === 0) return '12 AM'
  if (hour < 12) return `${hour} AM`
  if (hour === 12) return '12 PM'
  return `${hour - 12} PM`
}

export function formatTimeOfDay(date: Date, format: ClockFormat): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: format === '12h'
  }).format(date)
}

export function formatTimeString(time: string, format: ClockFormat): string {
  const [hours, minutes] = time.split(':').map(Number)
  if (format === '24h') {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }
  const period = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`
}
