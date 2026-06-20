/**
 * Shared presentational pieces for the non-table folder views (list / board / gallery).
 * Kept tiny and dependency-free so the three views render notes consistently.
 */

import { cn } from '@/lib/utils'

const HEX6 = /^#([0-9a-f]{6})$/i

/**
 * A note tag rendered as a tinted pill. Uses the tag's custom color when it is a
 * valid 6-digit hex, otherwise falls back to the neutral muted token.
 */
export function NoteTagPill({
  tag,
  color,
  onClick
}: {
  tag: string
  color?: string
  onClick?: () => void
}): React.JSX.Element {
  const tinted = !!color && HEX6.test(color)
  return (
    <button
      type="button"
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation()
              onClick()
            }
          : undefined
      }
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-[10.5px] font-medium transition-colors',
        !tinted && 'bg-muted text-muted-foreground hover:bg-muted/80'
      )}
      style={tinted ? { backgroundColor: `${color}24`, color } : undefined}
    >
      #{tag}
    </button>
  )
}

// Theme-aware pastel cover backgrounds (mapped from --card-* tokens in base.css).
const PASTELS = [
  'bg-card-sage',
  'bg-card-lavender',
  'bg-card-rose',
  'bg-card-sand',
  'bg-card-grey'
] as const

/** Deterministically pick a pastel cover for a card based on a stable seed. */
export function pastelFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return PASTELS[h % PASTELS.length]
}

// Status-dot palette for board columns (terracotta accent shared with --tint).
const DOTS = ['#9b9a97', '#2563eb', '#f97316', '#16a34a', '#7c3aed', '#0891b2'] as const

/** Pick a board-column dot color by column index. */
export function dotFor(index: number): string {
  return DOTS[index % DOTS.length]
}

/** Compact relative timestamp ("2h ago" / "Jun 16") for card + row metadata. */
export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
