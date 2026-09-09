/**
 * Note statistics for the More sheet footer (#2094).
 *
 * The word count is the DESKTOP definition, ported verbatim from
 * `apps/desktop/src/main/vault/frontmatter.ts` (`calculateWordCount`): fenced
 * and inline code stripped, then whitespace-split. Re-deriving it here would
 * show a different number for the same note on the two platforms.
 */

// Month names are literals, not `toLocaleDateString` output: Hermes ships
// without ICU on some builds and that call then returns another format or
// throws. Same reason as `features/search/subtitle.ts`.
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

/** Desktop's `calculateWordCount`, unchanged. */
export function calculateWordCount(content: string): number {
  const withoutCode = content.replace(/```[\s\S]*?```/g, '')
  const withoutInlineCode = withoutCode.replace(/`[^`]+`/g, '')
  return withoutInlineCode.split(/\s+/).filter((word) => word.length > 0).length
}

/** Desktop's reading time: 200 words per minute, rounded up. */
export function readingTimeLabel(wordCount: number): string {
  if (wordCount === 0) return '0 min read'
  return `${Math.ceil(wordCount / 200)} min read`
}

export function wordCountLabel(wordCount: number): string {
  return wordCount === 1 ? '1 word' : `${wordCount} words`
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** `Today at 18:36`, `Yesterday at 09:04`, `9 Sep 2026 at 18:36`. */
export function formatStatTimestamp(epochMs: number | null, now: Date = new Date()): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return '—'
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return '—'

  const time = clockTime(date)
  if (isSameDay(date, now)) return `Today at ${time}`
  const yesterday = new Date(now.getTime())
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(date, yesterday)) return `Yesterday at ${time}`

  const day = date.getDate()
  const month = SHORT_MONTHS[date.getMonth()]
  return `${day} ${month} ${date.getFullYear()} at ${time}`
}

export interface NoteStats {
  wordCount: number
  createdAt: number | null
  modifiedAt: number | null
}
