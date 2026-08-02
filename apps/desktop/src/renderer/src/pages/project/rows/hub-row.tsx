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
 * Title styling for a hub row body, matched to the Inbox's compact list item
 * (`DENSITY_CONFIG.compact.titleSize` plus its weight and tone). Exported so the
 * four row types cannot drift apart from the Inbox or from each other.
 */
export const HUB_ROW_TITLE = 'truncate text-[13px] font-medium text-foreground/90'

/**
 * Shared chrome for every project-hub list row: a leading control that keeps its
 * own click, a full-width body button that opens the item, and trailing metadata.
 *
 * Padding, gap, radius, hover and typography are the Inbox row's — the hub is
 * the same act of scanning a list, so it should not feel like a different app.
 * `role="listitem"` rather than `<li>` because the row is a div in a div-based
 * list, mirroring the Inbox.
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
  <div
    role="listitem"
    className={cn(
      'group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5',
      'cursor-pointer transition-[background-color,opacity] duration-150 ease-out',
      'hover:bg-muted active:bg-muted/70',
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
      <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground/60">
        {trailing}
      </span>
    ) : null}
  </div>
)
