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
 * The box a folder's custom icon gets: 20px, the size the built-in folder glyph
 * already reserves in the sidebar row and the folder-view header. Without it a
 * URL-backed icon renders at the row's 14px text size and is unreadable.
 *
 * Both surfaces put the icon inside a button that is already at least this tall,
 * so widening the glyph does not move the row height.
 */
export const FOLDER_CUSTOM_ICON_CLASS = 'size-5'

/** Default box: track the surrounding text, as emoji and library icons do. */
const TEXT_SIZED_CUSTOM_ICON_CLASS = 'h-[1em] w-[1em]'

/**
 * A user-uploaded icon, sized to the surrounding text so one component covers
 * a 14px sidebar row and a 28px note title alike — or to `customIconClassName`
 * where the text size is too small to identify the image (folder rows).
 *
 * The library is loaded asynchronously and an icon can also be missing outright
 * (deleted on another device while a folder still points at it), so an unknown
 * id renders an empty box of the same size rather than a broken-image glyph:
 * the row is laid out once, whether the icon arrives or never does.
 */
function CustomIconImage({
  id,
  className,
  customIconClassName = TEXT_SIZED_CUSTOM_ICON_CLASS
}: {
  id: string
  className?: string
  customIconClassName?: string
}): React.JSX.Element {
  const icon = useCustomIcon(id)

  return (
    <span className={cn('inline-flex items-center justify-center leading-none', className)}>
      {icon ? (
        <img
          src={icon.url}
          alt={icon.name}
          draggable={false}
          className={cn('object-contain', customIconClassName)}
        />
      ) : (
        <span className={customIconClassName} />
      )}
    </span>
  )
}

export function NoteIconDisplay({
  value,
  className,
  customIconClassName
}: {
  value: string
  className?: string
  /** Box for a `custom:` image icon only; emoji and library icons ignore it. */
  customIconClassName?: string
}): React.JSX.Element {
  if (isIconValue(value)) {
    return <HugeIconByName name={parseIconName(value)} className={className} />
  }
  if (isCustomIconValue(value)) {
    return (
      <CustomIconImage
        id={parseCustomIconId(value)}
        className={className}
        customIconClassName={customIconClassName}
      />
    )
  }
  return (
    <span className={cn('inline-flex items-center justify-center leading-none', className)}>
      {value}
    </span>
  )
}
