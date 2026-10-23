/**
 * The frames and primitives portals wear: the rail (artboard 4) that says
 * "this text lives somewhere else", and the floating toolbar's pieces
 * (artboard 5).
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

/** The boxed frame the search portal still wears. */
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

/**
 * The frame of a note or blocks portal (artboard 4): the text reads like the
 * rest of the note, and only a 2px rail in the gutter says it lives elsewhere.
 * The rail darkens while the caret is inside; a selected portal takes a tint.
 * The toolbar floats over the frame's top corner and takes no layout.
 */
export function PortalFrame({
  focused,
  selected,
  toolbar,
  className,
  children,
  ...rest
}: {
  focused: boolean
  selected: boolean
  toolbar?: ReactNode
} & ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return (
    <div
      className={cn(
        'group/portal relative w-full rounded-sm',
        selected && 'bg-tint-light',
        className
      )}
      data-portal-focused={focused || undefined}
      data-portal-selected={selected || undefined}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 -start-5 w-0.5 rounded-full transition-colors motion-reduce:transition-none',
          focused || selected ? 'bg-text-secondary' : 'bg-border'
        )}
      />
      {toolbar}
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

/** The floating toolbar's shell: top-end of the frame, over the content, no layout. */
export function PortalToolbarShell({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return (
    <div
      role="toolbar"
      contentEditable={false}
      className={cn(
        'absolute -top-7 end-0 z-10 flex h-6 max-w-full items-center gap-0.5 rounded-md bg-popover px-1 text-[11px] leading-4 text-text-secondary shadow-[var(--shadow-card-hover)] ring-1 ring-border/60',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

/** A quiet toolbar button: crumb, count or menu trigger. */
export function PortalToolbarButton({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<'button'>): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium leading-4 text-text-secondary hover:bg-surface-active hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-surface-active',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
