export type FeatureScreenshotId = 'inbox' | 'journal' | 'notes' | 'tasks' | 'calendar'

const FEATURE_SCREENSHOTS: Record<FeatureScreenshotId, string> = {
  inbox: '/screenshots/inbox_white.webp',
  journal: '/screenshots/journal_white.webp',
  notes: '/screenshots/note_white.webp',
  tasks: '/screenshots/task_white.webp',
  calendar: '/screenshots/calendar_white.webp'
} as const

export function getFeatureScreenshotSrc(id: FeatureScreenshotId) {
  return FEATURE_SCREENSHOTS[id]
}
