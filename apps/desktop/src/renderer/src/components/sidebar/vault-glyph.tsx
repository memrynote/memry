import { NoteIconDisplay } from '@/lib/render-note-icon'
import { isIconValue } from '@/components/note/note-title/emoji-icon-utils'
import { Library } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface VaultGlyphProps {
  /** `icon:<Name>` or an emoji; absent draws the default icon. */
  icon?: string
  /** Any CSS color. Library icons and the default take it; emoji keep their own colors. */
  color: string
  /** Box edge in px. */
  size?: number
  className?: string
}

/**
 * A vault's icon, the same everywhere a vault is drawn: the page indicator,
 * the panel header, the vault list and the switch screen. A vault without its
 * own icon draws the default library icon, so vaults differ by their accent.
 */
export function VaultGlyph({ icon, color, size = 14, className }: VaultGlyphProps) {
  return (
    <span
      aria-hidden="true"
      data-vault-glyph=""
      className={cn('inline-flex shrink-0 items-center justify-center leading-none', className)}
      // An emoji sits in the text flow: its font size fills the same box.
      style={{ width: size, height: size, color, fontSize: Math.round(size * 0.9) }}
    >
      {icon ? (
        <NoteIconDisplay value={icon} className={isIconValue(icon) ? 'size-full' : undefined} />
      ) : (
        <Library className="size-full" />
      )}
    </span>
  )
}
