import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { Tag } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { cn } from '@/lib/utils'

export interface ObjectLook {
  tag: string
  color: string
  icon: string | null
  avatar: boolean
}

export function objectInitials(title: string): string {
  const words = title.trim().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return ''
  const first = Array.from(words[0])[0] ?? ''
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : ''
  return (first + last).toLocaleUpperCase()
}

export function objectColor(look: Pick<ObjectLook, 'tag' | 'color'>): string {
  return getTagColors(look.color, look.tag).text
}

const ROUNDING: Record<number, string> = { 16: 'rounded', 18: 'rounded-[5px]', 40: 'rounded-lg' }

export function ObjectAvatar({
  look,
  title,
  size,
  className
}: {
  look: ObjectLook
  title: string
  size: 16 | 18 | 20 | 24 | 40 | 48
  className?: string
}): React.JSX.Element {
  const color = objectColor(look)
  const fontSize = Math.round(size * 0.4)
  if (look.avatar) {
    return (
      <span
        aria-hidden
        data-object-avatar="initials"
        className={cn(
          'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white',
          className
        )}
        style={{ width: size, height: size, fontSize, backgroundColor: color }}
      >
        {objectInitials(title)}
      </span>
    )
  }
  const iconSize = Math.round(size * 0.6)
  return (
    <span
      aria-hidden
      data-object-avatar="tile"
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        ROUNDING[size] ?? 'rounded-xl',
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: iconSize,
        backgroundColor: withAlpha(color, 0.14),
        color
      }}
    >
      {look.icon ? (
        <NoteIconDisplay value={look.icon} className="leading-none" />
      ) : (
        <Tag style={{ width: iconSize, height: iconSize }} />
      )}
    </span>
  )
}

export function TagGlyph({
  look,
  className
}: {
  look: Pick<ObjectLook, 'tag' | 'color' | 'icon'>
  className?: string
}): React.JSX.Element {
  const color = objectColor(look)
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', className)}
      style={{ color, fontSize: 13 }}
    >
      {look.icon ? (
        <NoteIconDisplay value={look.icon} className="leading-none" />
      ) : (
        <Tag className="size-3.5" />
      )}
    </span>
  )
}
