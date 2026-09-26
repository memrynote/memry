/**
 * Shared chrome for the task drawer's content sections (sub-issues, related,
 * activity). Sections sit in a `px-3` column and every row carries `px-2`, so
 * headings, row icons and the property rail above all share one 20px lane.
 */

import { cn } from '@/lib/utils'

export const DrawerSectionHeading = ({
  children,
  count,
  trailing
}: {
  children: React.ReactNode
  count?: React.ReactNode
  trailing?: React.ReactNode
}): React.JSX.Element => (
  <div className="flex h-6 items-center gap-2 px-2">
    <h3 className="text-[12px] font-medium leading-4 text-text-secondary">{children}</h3>
    {count !== undefined && (
      <span className="text-[12px] leading-4 text-text-tertiary">{count}</span>
    )}
    {trailing && <div className="ms-auto flex items-center">{trailing}</div>}
  </div>
)

/** A 28px list row on the section lane: 14px icon slot, then text. */
export const DRAWER_ROW =
  'flex h-7 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-start text-[13px] leading-[18px] transition-colors duration-150 hover:bg-surface-active/60 focus-visible:bg-surface-active/60 focus-visible:outline-none'

/** The muted "+ Add …" row that ends a list. */
export const DRAWER_ADD_ROW = `${DRAWER_ROW} text-text-tertiary hover:text-text-secondary`

/** Wraps a content section: vertical rhythm comes from spacing, not borders. */
export const DrawerSection = ({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element => (
  <section className={cn('flex flex-col gap-0.5 px-3 pt-4 pb-1', className)}>{children}</section>
)
