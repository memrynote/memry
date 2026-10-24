import type { ReactNode } from 'react'
import { FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'

/**
 * The icon in front of a note in a suggestion menu (`@`, `[[`, portals): the
 * note's own icon (emoji, library icon or custom image) when it has one, the
 * generic note glyph otherwise. One box size, so rows line up either way.
 */
export function NoteMenuIcon({
  icon,
  className
}: {
  icon?: string | null
  className?: string
}): ReactNode {
  const box = cn('size-[18px] shrink-0', className)
  if (icon) {
    return (
      <span className={cn(box, 'inline-flex items-center justify-center text-base leading-none')}>
        <NoteIconDisplay value={icon} />
      </span>
    )
  }
  return <FileText className={cn(box, 'text-text-secondary')} aria-hidden />
}
