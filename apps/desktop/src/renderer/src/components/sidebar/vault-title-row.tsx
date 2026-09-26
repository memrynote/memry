import { GENERAL_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'
import { cn } from '@/lib/utils'

/** A vault's accent, or the default tint for vaults that never stored one. */
export function resolveVaultAccent(accentColor: string | undefined): string {
  return accentColor && /^#[0-9a-fA-F]{6}$/.test(accentColor)
    ? accentColor
    : GENERAL_SETTINGS_DEFAULTS.accentColor
}

interface VaultTitleRowProps {
  name: string
  /** Any CSS color: `var(--tint)` for the open vault, a stored hex for others. */
  dotColor: string
  className?: string
}

/**
 * The vault name at the top of the sidebar list. The same row is drawn for the
 * vault being swiped in and on the in-between switch screen, so the name holds
 * its place while the rest of the list is replaced.
 */
export function VaultTitleRow({ name, dotColor, className }: VaultTitleRowProps) {
  return (
    <div className={cn('shrink-0 px-3', className)}>
      <div className="flex h-8 items-center gap-2 px-2">
        {/* The dot is a fill beside the name, never the only cue: the name says which vault. */}
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-sidebar-primary">
          {name}
        </span>
      </div>
    </div>
  )
}
