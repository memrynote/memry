import type { Theme } from '@/lib/use-theme'

export type FeatureScreenshotId = 'inbox' | 'journal' | 'notes' | 'tasks' | 'calendar'

const FEATURE_SCREENSHOTS: Record<FeatureScreenshotId, Record<Theme, string>> = {
  inbox: {
    light: '/screenshots/inbox_white.png',
    dark: '/screenshots/inbox_black.png'
  },
  journal: {
    light: '/screenshots/journal_white.png',
    dark: '/screenshots/journal_black.png'
  },
  notes: {
    light: '/screenshots/note_white.png',
    dark: '/screenshots/note_black.png'
  },
  tasks: {
    light: '/screenshots/task_white.png',
    dark: '/screenshots/task_black.png'
  },
  calendar: {
    light: '/screenshots/calendar_white.png',
    dark: '/screenshots/calendar_black.png'
  }
} as const

export function getFeatureScreenshotSrc(id: FeatureScreenshotId, theme: Theme) {
  return FEATURE_SCREENSHOTS[id][theme]
}
