export type FeatureScreenshotId = 'inbox' | 'journal' | 'notes' | 'tasks' | 'calendar'

const FEATURE_SCREENSHOTS: Record<FeatureScreenshotId, string> = {
  inbox: '/screenshots/inbox_white.png',
  journal: '/screenshots/journal_white.png',
  notes: '/screenshots/note_white.png',
  tasks: '/screenshots/task_white.png',
  calendar: '/screenshots/calendar_white.png'
} as const

export function getFeatureScreenshotSrc(id: FeatureScreenshotId) {
  return FEATURE_SCREENSHOTS[id]
}
