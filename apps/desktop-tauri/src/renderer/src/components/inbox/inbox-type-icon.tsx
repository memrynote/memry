import type React from 'react'
import { Link2, FileText, Image, Mic, Scissors, FilePdf, Share2, Bell, Video } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { InboxItemType } from '@/types'

const TYPE_ICON_COLORS: Record<InboxItemType, string> = {
  link: 'text-indigo-500 dark:text-indigo-400',
  voice: 'text-amber-500 dark:text-amber-400',
  image: 'text-emerald-500 dark:text-emerald-400',
  clip: 'text-purple-400 dark:text-purple-300',
  note: 'text-muted-foreground/60',
  pdf: 'text-red-500 dark:text-red-400',
  social: 'text-sky-400 dark:text-sky-300',
  video: 'text-sky-500 dark:text-sky-400',
  reminder: 'text-amber-500 dark:text-amber-400'
}

interface InboxTypeIconProps {
  type: InboxItemType
  className?: string
}

/** Bare, colored type glyph for an inbox item. Decorative — the row carries the label. */
export function InboxTypeIcon({ type, className }: InboxTypeIconProps): React.JSX.Element {
  const color = TYPE_ICON_COLORS[type] ?? TYPE_ICON_COLORS.note
  const iconClassName = cn('size-3.5', color, className)

  switch (type) {
    case 'link':
      return <Link2 className={iconClassName} aria-hidden="true" />
    case 'note':
      return <FileText className={iconClassName} aria-hidden="true" />
    case 'image':
      return <Image className={iconClassName} aria-hidden="true" />
    case 'voice':
      return <Mic className={iconClassName} aria-hidden="true" />
    case 'clip':
      return <Scissors className={iconClassName} aria-hidden="true" />
    case 'pdf':
      return <FilePdf className={iconClassName} aria-hidden="true" />
    case 'social':
      return <Share2 className={iconClassName} aria-hidden="true" />
    case 'video':
      return <Video className={iconClassName} aria-hidden="true" />
    case 'reminder':
      return <Bell className={iconClassName} aria-hidden="true" />
    default:
      return <FileText className={iconClassName} aria-hidden="true" />
  }
}
