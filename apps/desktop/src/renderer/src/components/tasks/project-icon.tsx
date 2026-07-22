import { createElement } from 'react'

import { getIconByName } from '@/components/icon-picker'
import { isIconValue } from '@/components/note/note-title/emoji-icon-utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'

interface ProjectIconProps {
  /**
   * A project's stored icon. May be a new shared-picker value (a raw emoji like
   * "📚" or an "icon:<HugeIconsName>" value), a legacy bare lucide name written
   * by older app versions (e.g. "Folder", "Star"), or null.
   */
  icon: string | null | undefined
  className?: string
  /** Hex tint applied to lucide + HugeIcons glyphs. Raw emoji is never tinted. */
  color?: string
  /** Rendered when `icon` is empty or an unrecognized bare name. */
  fallback: React.ReactNode
}

/** True when the string carries any non-ASCII code point (i.e. is an emoji glyph). */
function containsNonAscii(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return true
  }
  return false
}

/**
 * Renders a project's icon across the shared emoji/icon picker migration.
 *
 * Projects now store the same values as notes/tags/folders (raw emoji or
 * "icon:<HugeIconsName>"), but existing installs and older app versions keep
 * writing bare lucide names. This shim resolves all shapes so a mixed-version
 * fleet renders correctly, degrading unknown values to the caller's fallback.
 */
export function ProjectIcon({
  icon,
  className,
  color,
  fallback
}: ProjectIconProps): React.JSX.Element {
  if (icon) {
    // New shared-picker values: a HugeIcons "icon:Name" or a raw emoji glyph.
    // Wrap in an aria-hidden `display:contents` span — the project name is the
    // accessible label, so the glyph is decorative, and `contents` adds no layout
    // box (color still inherits, tinting the HugeIcon; emoji ignore it).
    if (isIconValue(icon) || containsNonAscii(icon)) {
      return (
        <span className="contents" style={color ? { color } : undefined} aria-hidden="true">
          <NoteIconDisplay value={icon} className={className} />
        </span>
      )
    }

    // Legacy bare lucide name ("Folder", "Star", …) — preserves the prior look.
    const LegacyIcon = getIconByName(icon)
    if (LegacyIcon) {
      return createElement(LegacyIcon, {
        className,
        style: color ? { color } : undefined,
        'aria-hidden': 'true'
      })
    }
  }

  // null / lowercase 'folder' / unknown ASCII name → caller's fallback (color dot or 📁).
  return <>{fallback}</>
}

export default ProjectIcon
