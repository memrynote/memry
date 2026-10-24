import type { InboxItemType } from '@/types'

interface TypeAccent {
  label: string
  accentClass: string
  hex: string
}

const TYPE_ACCENTS: Record<string, TypeAccent> = {
  link: { label: 'link', accentClass: 'text-[var(--accent-purple)]', hex: '#8b5cf6' },
  voice: { label: 'voice', accentClass: 'text-[var(--accent-orange)]', hex: '#f59e0b' },
  image: { label: 'image', accentClass: 'text-[var(--accent-green)]', hex: '#10b981' },
  note: { label: 'note', accentClass: 'text-[var(--accent-cyan)]', hex: '#3b82f6' },
  video: { label: 'video', accentClass: 'text-[var(--accent-orange)]', hex: '#ef4444' },
  pdf: { label: 'pdf', accentClass: 'text-[var(--accent-orange)]', hex: '#f97316' },
  clip: { label: 'clip', accentClass: 'text-[var(--accent-purple)]', hex: '#8b5cf6' },
  social: { label: 'social', accentClass: 'text-[var(--accent-cyan)]', hex: '#06b6d4' },
  reminder: { label: 'reminder', accentClass: 'text-[var(--accent-orange)]', hex: '#ec4899' }
}

const DEFAULT_ACCENT: TypeAccent = {
  label: 'item',
  accentClass: 'text-[var(--muted-foreground)]',
  hex: '#8c8c8c'
}

export const getTypeLabel = (type: InboxItemType): string =>
  (TYPE_ACCENTS[type] ?? DEFAULT_ACCENT).label

export const getTypeAccentClass = (type: InboxItemType): string =>
  (TYPE_ACCENTS[type] ?? DEFAULT_ACCENT).accentClass

export const getTypeAccentHex = (type: InboxItemType): string =>
  (TYPE_ACCENTS[type] ?? DEFAULT_ACCENT).hex
