/**
 * Shared presentational pieces for the non-table folder views (list / gallery).
 * Kept tiny and dependency-free so the views render notes consistently.
 */

import type { Tag } from '@/components/note/tags-row/TagChip'

/** Color + icon for a tag, keyed by lowercased tag name. */
export interface TagMeta {
  color: string
  icon: string | null
}

export type TagMetaMap = Map<string, TagMeta>

/**
 * Build the shared {@link Tag} model that {@link TagChip} renders, from a bare
 * folder-view tag string and its metadata. Keeps tag pills identical to the
 * sidebar / note tags (same colors + icon) everywhere in the app.
 */
export function toTagChip(tag: string, meta?: TagMeta): Tag {
  return { id: tag, name: tag, color: meta?.color ?? '', icon: meta?.icon ?? null }
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
