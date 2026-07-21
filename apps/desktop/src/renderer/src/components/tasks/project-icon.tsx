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
    // New HugeIcons value ("icon:Name") — tint via a wrapper (icons inherit currentColor).
    if (isIconValue(icon)) {
      return (
        <span className="inline-flex" style={color ? { color } : undefined}>
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

    // New raw emoji ("📚") — rendered as a glyph, never tinted.
    if (containsNonAscii(icon)) {
      return <NoteIconDisplay value={icon} className={className} />
    }
  }

  // null / lowercase 'folder' / unknown ASCII name → caller's fallback (color dot or 📁).
  return <>{fallback}</>
}

export default ProjectIcon
