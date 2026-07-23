import * as React from 'react'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import type { HubTag } from '@/hooks/use-tag-categories'

export interface TagChipItemProps {
  tag: HubTag
  onOpen(): void
}

/**
 * One tag chip in the tag hub. Reuses the sidebar's chip visual language
 * (`sidebar-tag-list.tsx` ~151-183: `getTagColors`, `${colors.text}1A` fill,
 * icon-or-dot leading slot) but always shows the full tag name (never just
 * the leaf segment) and always shows the item count.
 */
export function TagChipItem({ tag, onOpen }: TagChipItemProps): React.JSX.Element {
  const colors = getTagColors(tag.color, tag.tag)

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${tag.tag} (${tag.count})`}
      className="flex items-center gap-1.5 rounded-sm py-1 px-2 text-xs font-medium leading-4 min-w-0"
      style={{ backgroundColor: `${colors.text}1A`, color: colors.text }}
    >
      {tag.icon ? (
        <NoteIconDisplay value={tag.icon} className="size-3 shrink-0 text-xs leading-none" />
      ) : (
        <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: colors.text }} />
      )}
      <span className="min-w-0 truncate">{tag.tag}</span>
      <span className="text-[10px] tabular-nums opacity-60">{tag.count}</span>
    </button>
  )
}

export default TagChipItem
