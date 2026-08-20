import {
  isCustomIconValue,
  isIconValue,
  parseCustomIconId,
  parseIconName
} from '@/components/note/note-title/emoji-icon-utils'
import { cn } from '@/lib/utils'
import { useCustomIcon } from './custom-icons-store'
import { HugeIconByName } from './hugeicon-renderer'

/**
 * A user-uploaded icon, sized to the surrounding text so one component covers
 * a 14px sidebar row and a 28px note title alike.
 *
 * The library is loaded asynchronously and an icon can also be missing outright
 * (deleted on another device while a folder still points at it), so an unknown
 * id renders nothing rather than a broken-image glyph.
 */
function CustomIconImage({ id, className }: { id: string; className?: string }): React.JSX.Element {
  const icon = useCustomIcon(id)

  return (
    <span className={cn('inline-flex items-center justify-center leading-none', className)}>
      {icon ? (
        <img
          src={icon.url}
          alt={icon.name}
          draggable={false}
          className="h-[1em] w-[1em] object-contain"
        />
      ) : (
        <span className="h-[1em] w-[1em]" />
      )}
    </span>
  )
}

export function NoteIconDisplay({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  if (isIconValue(value)) {
    return <HugeIconByName name={parseIconName(value)} className={className} />
  }
  if (isCustomIconValue(value)) {
    return <CustomIconImage id={parseCustomIconId(value)} className={className} />
  }
  return (
    <span className={cn('inline-flex items-center justify-center leading-none', className)}>
      {value}
    </span>
  )
}
