import { cn } from '@/lib/utils'

interface HubRowProps {
  /** Leading control (status ring, icon picker, file glyph). Sits outside the body button. */
  leading: React.ReactNode
  /** Main click target — opens the item in its home view. */
  onOpen: () => void
  openLabel: string
  children: React.ReactNode
  /** Trailing metadata (tags, dates, sizes) and hover controls. */
  trailing?: React.ReactNode
  className?: string
}

/**
 * Shared chrome for every project-hub list row: a leading control that keeps its
 * own click, a full-width body button that opens the item, and trailing metadata.
 *
 * The leading slot sits outside the button because nesting interactive elements
 * is invalid HTML and breaks keyboard navigation.
 */
export const HubRow = ({
  leading,
  onOpen,
  openLabel,
  children,
  trailing,
  className
}: HubRowProps): React.JSX.Element => (
  <li
    className={cn(
      'group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-active',
      className
    )}
  >
    <span className="flex shrink-0 items-center">{leading}</span>

    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      className="flex min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
    >
      {children}
    </button>

    {trailing ? (
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {trailing}
      </span>
    ) : null}
  </li>
)
