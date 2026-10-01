/**
 * Daily tracker values for the journal, so property charts have something real
 * to draw: half a year of days ending on the seed day, with the gaps, streaks and
 * correlations a person who tracks things actually produces.
 *
 * - `sleep` (number, hours): a weekend lie-in, a slow upward trend, bad nights
 *   now and then.
 * - `workout` (checkbox): three or four days a week, and every day of the last
 *   nine, so the current streak reads as a streak.
 * - `mood` (number 1-5) and `feeling` (select): the same day in two shapes, one
 *   for a line and one for a colour heatmap. Better sleep and a workout lift it.
 * - `habits` (multi-select): Reading, Meditation, Stretching, Walk.
 * - `steps` (number): follows walks and workouts.
 * - `weight` (number, kg): Sunday weigh-ins that match the [[2026 Cut]] story,
 *   87.1 kg on its first day and 84.8 kg a week before the seed day.
 *
 * Deterministic: one seeded PRNG walked in day order, so every run draws the
 * same shape relative to the run day.
 */
import { createRng } from './bulk-notes'
import { seedDateOnly } from './date'

/** Days of history, ending on the seed day. Matches the heatmap's default range. */
export const TRACKER_DAYS = 182

export const FEELINGS = ['rough', 'low', 'okay', 'good', 'great'] as const
export type Feeling = (typeof FEELINGS)[number]

export const HABITS = ['Reading', 'Meditation', 'Stretching', 'Walk'] as const

export interface TrackerDay {
  date: string
  sleep: number
  workout: boolean
  mood: number
  feeling: Feeling
  habits: string[]
  steps: number
  weight?: number
}

/** Days before the seed day the cut started, and the mid-cut check-in (see journal.ts). */
const CUT_START = -33
const CUT_CHECK_IN = -7
/** The last days are all logged with a workout, so the current streak is visible. */
const STREAK_DAYS = 9

const round1 = (value: number): number => Math.round(value * 10) / 10

function weightOn(offset: number, noise: number): number {
  if (offset === CUT_START) return 87.1
  if (offset === CUT_CHECK_IN) return 84.8
  if (offset < CUT_START) {
    // Maintenance before the cut: drifting down half a kilo over five months.
    const progress = (offset + TRACKER_DAYS) / (TRACKER_DAYS + CUT_START)
    return round1(87.9 - 0.6 * progress + noise * 0.4)
  }
  // The cut: 2.3 kg over the 26 days between the two recorded weigh-ins.
  return round1(87.1 - (offset - CUT_START) * (2.3 / (CUT_CHECK_IN - CUT_START)) + noise * 0.3)
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay()
}

function buildTrackerDays(): TrackerDay[] {
  const rng = createRng(20260508)
  const days: TrackerDay[] = []
  for (let offset = -(TRACKER_DAYS - 1); offset <= 0; offset++) {
    const date = seedDateOnly(offset)
    const weekday = weekdayOf(date)
    const inStreak = offset > -STREAK_DAYS
    // Draw every value even for a skipped day, so skipping one does not shift
    // the rest of the series.
    const skipRoll = rng()
    const sleepNoise = rng()
    const badNight = rng() < 0.08
    const workoutRoll = rng()
    const moodNoise = rng()
    const habitRolls = HABITS.map(() => rng())
    const stepNoise = rng()
    const weightNoise = rng() - 0.5

    if (!inStreak && offset !== CUT_START && offset !== CUT_CHECK_IN && skipRoll < 0.09) continue

    const weekend = weekday === 0 || weekday === 6
    const trend = ((offset + TRACKER_DAYS) / TRACKER_DAYS) * 0.4
    const sleep = round1(
      Math.min(
        9.2,
        Math.max(
          4.6,
          6.6 + trend + (weekend ? 0.6 : 0) + (sleepNoise - 0.5) * 1.4 - (badNight ? 1.4 : 0)
        )
      )
    )

    const workoutDay = weekday === 1 || weekday === 3 || weekday === 5 || weekday === 6
    const workout =
      inStreak || offset === CUT_START || (workoutDay ? workoutRoll < 0.8 : workoutRoll < 0.15)

    const score = 3.3 + (sleep - 6.8) * 0.9 + (workout ? 0.5 : 0) + (moodNoise - 0.5) * 1.6
    const mood = Math.min(5, Math.max(1, Math.round(score)))

    // Meditation became a habit over the half year; the others hold steady.
    const habitOdds = [0.55, 0.15 + trend * 1.2, 0.3, weekend ? 0.8 : 0.5]
    const habits = HABITS.filter((_, i) => habitRolls[i] < habitOdds[i])
    const walked = habits.includes('Walk')
    const steps = Math.round(3800 + (walked ? 5200 : 0) + (workout ? 1800 : 0) + stepNoise * 2400)

    const weighIn = weekday === 0 || offset === CUT_START || offset === CUT_CHECK_IN
    days.push({
      date,
      sleep,
      workout,
      mood,
      feeling: FEELINGS[mood - 1],
      habits,
      steps,
      ...(weighIn ? { weight: weightOn(offset, weightNoise) } : {})
    })
  }
  return days
}

export const TRACKER_DAYS_LIST: TrackerDay[] = buildTrackerDays()

const BY_DATE = new Map(TRACKER_DAYS_LIST.map((day) => [day.date, day]))

/**
 * The frontmatter a journal entry on `date` tracks, or nothing for a day with
 * no tracking (future days, skipped days). A narrative entry keeps the mood its
 * story gave it; the feeling follows that mood so the two never disagree.
 */
export function trackerProps(
  date: string,
  narrativeMood?: number
): Record<string, unknown> | undefined {
  const day = BY_DATE.get(date)
  if (!day) return undefined
  const mood = narrativeMood ?? day.mood
  return {
    mood,
    feeling: FEELINGS[Math.min(5, Math.max(1, mood)) - 1],
    sleep: day.sleep,
    workout: day.workout,
    habits: day.habits,
    steps: day.steps,
    ...(day.weight !== undefined ? { weight: day.weight } : {})
  }
}

const LINES: Record<Feeling, string[]> = {
  great: [
    'Slept well and it showed. Clear head all day.',
    'One of those days where everything took less effort than planned.',
    'Good energy from the first coffee to the last page.'
  ],
  good: [
    'Solid day. Nothing dramatic, which is the point.',
    'Got the important thing done before lunch.',
    'Steady. Ate well, moved, read a little.'
  ],
  okay: [
    'Middling day. Got through the list, not much more.',
    'Busy but flat. Early night.',
    'Fine. A bit scattered after lunch.'
  ],
  low: [
    'Tired most of the day. Kept it simple.',
    'Short on sleep and patience. Tomorrow is another go.',
    'Dragged. Went for a walk to reset, half worked.'
  ],
  rough: [
    'Bad night, worse morning. Did the minimum and stopped.',
    'Rough one. Not writing much today.'
  ]
}

/**
 * A short entry for a tracked day with no story of its own: a line that fits
 * the day's feeling, and the workout when there was one.
 */
export function trackerBody(day: TrackerDay, index: number): string {
  const lines = LINES[day.feeling]
  const line = lines[index % lines.length]
  const extra = day.workout
    ? '\n\n- Trained, see [[Training Split]]'
    : day.habits.includes('Walk')
      ? '\n\n- Long walk'
      : ''
  return `${line}${extra}`
}
