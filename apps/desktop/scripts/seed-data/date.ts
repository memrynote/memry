const SEED_NOW = new Date()
const SEED_DAY = toSeedDay(SEED_NOW)

export function toSeedDay(now: Date): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0))
}

export function seedISOAt(days: number, hours = 12, minutes = 0, seedDay = SEED_DAY): string {
  const d = new Date(seedDay)
  d.setUTCDate(d.getUTCDate() + days)
  d.setUTCHours(hours, minutes, 0, 0)
  return d.toISOString()
}

export function seedPastISOAt(
  days: number,
  hours = 12,
  minutes = 0,
  seedDay = SEED_DAY,
  now = SEED_NOW
): string {
  const iso = seedISOAt(days, hours, minutes, seedDay)
  if (days !== 0) return iso

  const candidate = new Date(iso)
  if (candidate.getTime() <= now.getTime()) return iso

  const elapsedMinutesToday = now.getHours() * 60 + now.getMinutes()
  const requestedSpread = Math.max(1, (hours - 6) * 20 + minutes)
  const minutesBack = Math.min(requestedSpread, elapsedMinutesToday)
  const d = new Date(now)
  d.setMinutes(d.getMinutes() - minutesBack)
  d.setSeconds(0, 0)
  return d.toISOString()
}

export function seedDateOnly(days: number, seedDay = SEED_DAY): string {
  return seedISOAt(days, 12, 0, seedDay).slice(0, 10)
}

// Journal entries and the dated note properties are authored on a fixed narrative
// timeline anchored to JOURNAL_ANCHOR, which maps to the day the seed command runs.
// seedJournalDate shifts a narrative date by that offset, so entries dated before
// the anchor land in the past and entries after it land in the future. Shared by
// journal seeding, note date properties, and the wikilinks that reference them.
export const JOURNAL_ANCHOR = '2026-05-08'

export function seedJournalDate(
  narrative: string,
  anchor = JOURNAL_ANCHOR,
  seedDay = SEED_DAY
): string {
  const offsetDays = Math.round(
    (Date.parse(`${narrative}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000
  )
  return seedDateOnly(offsetDays, seedDay)
}
