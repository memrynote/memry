import { FileText } from '@/lib/icons'
import { PageInboxIcon, PageJournalIcon, PageTasksIcon } from '@/lib/icons/page-icons'
import type { ContentType } from '@memry/contracts/search-api'

export const CONTENT_TYPES: readonly ContentType[] = ['note', 'journal', 'task', 'inbox']

/** ⌘1–⌘4 scope shortcuts, in `CONTENT_TYPES` order. */
export const TYPE_SHORTCUTS: Record<ContentType, string> = {
  note: '1',
  journal: '2',
  task: '3',
  inbox: '4'
}

export const TYPE_ICONS: Record<ContentType, typeof FileText> = {
  note: FileText,
  journal: PageJournalIcon,
  task: PageTasksIcon,
  inbox: PageInboxIcon
}

export const TYPE_LABEL_KEYS = {
  note: 'searchPalette.types.note',
  journal: 'searchPalette.types.journal',
  task: 'searchPalette.types.task',
  inbox: 'searchPalette.types.inbox'
} as const satisfies Record<ContentType, string>

export const MOD_KEY =
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC') ? '⌘' : '⌃'
