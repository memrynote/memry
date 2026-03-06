/**
 * Canonical bookmark item types shared across contracts and schema.
 */

export const BookmarkItemTypes = {
  NOTE: 'note',
  JOURNAL: 'journal',
  TASK: 'task',
  IMAGE: 'image',
  PDF: 'pdf',
  AUDIO: 'audio',
  VIDEO: 'video',
  CANVAS: 'canvas',
  FILE: 'file'
} as const

export type BookmarkItemType = (typeof BookmarkItemTypes)[keyof typeof BookmarkItemTypes]
