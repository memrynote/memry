/**
 * The frame every portal wears: a left rail and a faint tint (artboard 2) that
 * say "this text lives somewhere else", a header naming the source, and
 * actions that appear on hover.
 *
 * @module note/content-area/portal/portal-chrome
 */

import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type PortalRailTone = 'tint' | 'tint-dashed' | 'neutral'

const RAIL_TONE: Record<PortalRailTone, string> = {
  tint: 'border-tint bg-tint/5 py-2.5',
  'tint-dashed': 'border-dashed border-tint bg-tint/5 py-2.5',
  neutral: 'border-border bg-muted py-3'
}

export function PortalRail({
  tone,
  className,
  children,
  ...rest
}: { tone: PortalRailTone } & ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return (
    <div
      className={cn(
        'group/portal relative flex w-full flex-col gap-2.5 rounded-s-[2px] rounded-e-lg border-s-[3px] px-3.5',
        RAIL_TONE[tone],
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

/** The portal glyph from the design: a frame with a smaller frame inside. */
export function PortalGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M9 9h6v6H9z" />
    </svg>
  )
}

export function PortalHeaderRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex w-full min-w-0 items-center gap-2">{children}</div>
}

/** A header icon button: quiet at rest, in the note's ink on hover. */
export function PortalActionButton({
  label,
  className,
  children,
  ...rest
}: { label: string } & ComponentPropsWithoutRef<'button'>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-50 disabled:hover:text-muted-foreground',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** The cluster of header actions, shown while the portal is hovered or focused. */
export function PortalActions({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2.5 opacity-0 transition-opacity group-hover/portal:opacity-100 group-focus-within/portal:opacity-100">
      {children}
    </div>
  )
}

/** A small count pill ("5 blocks", "2 hidden"). */
export function PortalChip({
  children,
  className,
  ...rest
}: ComponentPropsWithoutRef<'span'>): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-[9px] py-[3px] text-xs font-medium text-muted-foreground',
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}
