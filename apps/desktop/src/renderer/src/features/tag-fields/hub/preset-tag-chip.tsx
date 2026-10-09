import * as React from 'react'
import type { PresetKey } from '@memry/contracts/tag-schema'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { useResolvedTag } from '../use-tag-schemas'
import { cn } from '@/lib/utils'

// Mirrors icon and colour in apps/desktop/src/main/tags/preset-catalog.ts.
// The snapshot's PresetOffer does not carry them; a tag that already exists
// shows its own look instead.
const PRESET_LOOK: Record<PresetKey, { icon: string; color: string }> = {
  person: { icon: 'icon:UserIcon', color: 'sky' },
  company: { icon: 'icon:Building03Icon', color: 'indigo' },
  meeting: { icon: 'icon:Calendar03Icon', color: 'amber' },
  book: { icon: 'icon:BookOpen01Icon', color: 'emerald' }
}

/** Small tag chip in the tag's colour, as the hub and tags row draw it. */
export function PresetTagChip({
  tag,
  preset,
  className
}: {
  tag: string
  preset?: PresetKey
  className?: string
}): React.JSX.Element {
  const resolved = useResolvedTag(tag)
  const look = preset ? PRESET_LOOK[preset] : null
  const color = resolved?.color ?? look?.color ?? ''
  const icon = resolved?.icon ?? look?.icon ?? null
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
