import { Command } from 'cmdk'
import { highlightTerms, stripMarkTags } from '@/services/search-service'
import { cn } from '@/lib/utils'

/** Shared building blocks for every list the search palette shows. */

export function HighlightedText({
  text,
  query,
  className
}: {
  text: string
  query: string
  className?: string
}): React.JSX.Element {
  const segments = highlightTerms(stripMarkTags(text), query)
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.highlight ? (
          <mark key={i} className="rounded-[3px] bg-[var(--tint-light)] text-inherit">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </span>
  )
}

export function SearchKbd({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded border border-border px-1.5',
        'font-mono text-[11px] leading-none text-text-tertiary',
        className
      )}
    >
      {children}
    </kbd>
  )
}

export function SearchGroupHeading({
  label,
  trailing
}: {
  label: string
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-7 items-end justify-between px-2.5 pb-1 text-[11px] font-medium leading-[14px] text-text-tertiary">
      <span>{label}</span>
      {trailing}
    </div>
  )
}

export function SearchCount({ value }: { value: number }): React.JSX.Element {
  return <span className="font-mono tabular-nums">{value}</span>
}

interface SearchRowProps {
  value: string
  onSelect: () => void
  icon: React.ReactNode
  children: React.ReactNode
  trailing?: React.ReactNode
  /** A fixed-width lane after `trailing`, kept even when empty so columns line up. */
  endLane?: React.ReactNode
  muted?: boolean
}

/** One 34px palette row: icon lane, one-line title, trailing hint. */
export function SearchRow({
  value,
  onSelect,
  icon,
  children,
  trailing,
  endLane,
  muted
}: SearchRowProps): React.JSX.Element {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-[34px] cursor-pointer items-center gap-2.5 rounded-md px-2.5
        data-[selected=true]:bg-surface-active"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-text-tertiary [&_svg]:size-[15px]">
        {icon}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px]',
          muted ? 'text-text-tertiary' : 'text-foreground'
        )}
      >
        {children}
      </span>
      {trailing !== undefined && (
        <span className="shrink-0 truncate text-xs leading-4 text-text-tertiary">{trailing}</span>
      )}
      {endLane !== undefined && (
        <span className="flex w-3.5 shrink-0 items-center justify-center">{endLane}</span>
      )}
    </Command.Item>
  )
}
