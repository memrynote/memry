import * as React from 'react'
import type { PresetOffer } from '@memry/contracts/tag-schema-api'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { useResolvedTag } from '../use-tag-schemas'
import { cn } from '@/lib/utils'

export function PresetTagChip({
  tag,
  preset,
  className
}: {
  tag: string
  preset?: Pick<PresetOffer, 'icon' | 'color'>
  className?: string
}): React.JSX.Element {
  const resolved = useResolvedTag(tag)
  const color = resolved?.color ?? preset?.color ?? ''
  const icon = resolved?.icon ?? preset?.icon ?? null
  const colors = getTagColors(color, tag)
  return (
    <span
      style={{ backgroundColor: `${colors.text}1F`, color: colors.text }}
      className={cn(
        'inline-flex h-6 min-w-0 items-center gap-1 rounded-[6px] ps-2 pe-2 text-xs font-medium',
        className
      )}
    >
      {icon ? (
        <NoteIconDisplay value={icon} className="size-3 shrink-0 text-[11px] leading-none" />
      ) : (
        <span aria-hidden className="shrink-0 opacity-60">
          #
        </span>
      )}
      <span className="min-w-0 truncate">{tag}</span>
    </span>
  )
}
