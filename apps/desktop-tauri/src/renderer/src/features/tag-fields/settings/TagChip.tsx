import { Tag } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { cn } from '@/lib/utils'

interface TagChipProps {
  name: string
  color: string
  icon: string | null
  className?: string
}

export function TagChip({ name, color, icon, className }: TagChipProps): React.JSX.Element {
  const text = getTagColors(color, name).text
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
        className
      )}
      style={{ backgroundColor: withAlpha(text, 0.12), color: text }}
    >
      {icon ? (
        <NoteIconDisplay value={icon} className="size-3 text-[11px] leading-none" />
      ) : (
        <Tag className="size-3 shrink-0" />
      )}
      <span className="truncate">{name}</span>
    </span>
  )
}
