import type { InboxItemType } from '@/types'

interface TypeAccentConfig {
  label: string
  color: string
}

const TYPE_ACCENTS: Record<InboxItemType, TypeAccentConfig> = {
  link: { label: 'link', color: '#6366f1' },
  voice: { label: 'voice', color: '#f59e0b' },
  image: { label: 'image', color: '#10b981' },
  note: { label: 'note', color: '#3b82f6' },
  video: { label: 'video', color: '#ef4444' },
  pdf: { label: 'pdf', color: '#f97316' },
  clip: { label: 'clip', color: '#8b5cf6' },
  social: { label: 'social', color: '#06b6d4' },
  reminder: { label: 'reminder', color: '#ec4899' }
}

export const getTypeAccentColor = (type: InboxItemType): string =>
  TYPE_ACCENTS[type]?.color ?? '#6b7280'

export const getTypeLabel = (type: InboxItemType): string => TYPE_ACCENTS[type]?.label ?? type

export const getTypeAccentBg = (type: InboxItemType, opacity: number = 0.15): string => {
  const color = getTypeAccentColor(type)
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0')
  return `${color}${alpha}`
}
