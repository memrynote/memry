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
 * The box a folder's custom icon gets in the folder-view header: 20px, the size
 * the chip reserves. Without it a URL-backed icon renders at the chip's text
 * size and is hard to identify.
 */
export const FOLDER_CUSTOM_ICON_CLASS = 'size-5'

/**
 * Default box for every icon kind: one em of the surrounding text, the box an
 * emoji glyph already takes. Library SVGs otherwise render at their 24px
 * default and custom images at their intrinsic size, so the three kinds would
 * differ in size on the same row.
 */
const TEXT_SIZED_ICON_CLASS = 'h-[1em] w-[1em]'

/**
 * A user-uploaded icon, sized to the surrounding text so one component covers
 * a sidebar row and a note title alike — or to `customIconClassName` where the
 * caller needs a different box (the folder-view header, the note title tile).
 *
 * The library is loaded asynchronously and an icon can also be missing outright
 * (deleted on another device while a folder still points at it), so an unknown
 * id renders an empty box of the same size rather than a broken-image glyph:
 * the row is laid out once, whether the icon arrives or never does.
 */
function CustomIconImage({
  id,
  className,
  customIconClassName = TEXT_SIZED_ICON_CLASS
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
    return (
      <HugeIconByName
        name={parseIconName(value)}
        className={cn(TEXT_SIZED_ICON_CLASS, className)}
      />
    )
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
  // `font-emoji` pins the glyph to a color emoji font (see emoji-font.css) so
  // the icon matches what the picker showed, whatever the UI font is. A color
  // emoji glyph is wider than 1em, so the box is pinned to 1em like the other
  // kinds and the glyph centres in it; otherwise the label beside an emoji
  // starts further along than beside a library icon or an image.
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center font-emoji leading-none',
        TEXT_SIZED_ICON_CLASS,
        className
      )}
    >
      {value}
    </span>
  )
}
