const appVersionPattern = /^(\d{4})\.(\d{3,4})\.(\d+)$/

export function formatAppVersionForDisplay(version: string): string {
  const match = appVersionPattern.exec(version)
  if (!match) {
    return version
  }

  const [, yearText, monthDayText, releaseIndexText] = match
  const releaseIndex = Number(releaseIndexText)
  if (releaseIndex < 1) {
    return version
  }

  const monthText = monthDayText.length === 3 ? monthDayText.slice(0, 1) : monthDayText.slice(0, 2)
  const dayText = monthDayText.length === 3 ? monthDayText.slice(1) : monthDayText.slice(2)
  const month = Number(monthText)
  const day = Number(dayText)
  const year = Number(yearText)

  if (!isValidUtcDate(year, month, day)) {
    return version
  }

  const suffix = releaseIndex === 1 ? '' : `.${releaseIndex}`
  return `v${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}${suffix}`
}

function isValidUtcDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) {
    return false
  }

  const candidate = new Date(Date.UTC(year, month - 1, day))
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  )
}
