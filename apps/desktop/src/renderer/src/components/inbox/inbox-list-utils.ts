import type { InboxItemListItem } from '@/types'

type InboxItem = InboxItemListItem

/** Strip light markdown/markup and collapse whitespace for a one-glance preview. */
function normalizePreview(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw
    .replace(/<!--[\s\S]*?-->/g, ' ') // html comments (e.g. memry block markers)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/[#>*_`~]+/g, ' ') // md heading/quote/emphasis markers
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 0 ? text : null
}

/**
 * Preview text for the comfortable (two-line) row: transcription for voice,
 * excerpt for link/clip, else the captured content. Null when there's nothing
 * worth showing — the row stays single-line in that case.
 */
export function getInboxItemPreview(item: InboxItem): string | null {
  const raw =
    item.type === 'voice' ? (item.transcription ?? item.content) : (item.excerpt ?? item.content)
  return normalizePreview(raw)
}
