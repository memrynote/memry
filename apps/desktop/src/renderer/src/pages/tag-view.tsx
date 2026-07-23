import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { MoreHorizontal } from '@/lib/icons'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { useTagItems } from '@/hooks/use-tag-items'

export interface TagViewPageProps {
  tag: string
  color?: string
}

/**
 * Single tag page: a table of every item carrying `tag`, opened from a tag
 * chip in the hub (`tags-hub.tsx`) or, after Task 20, the sidebar.
 *
 * Header only for now (chip, name, count, `⋯` placeholder) — Task 15 wires
 * `useTagItems` to the real backend query, Task 17 wires the `⋯` menu, and
 * Task 18 adds the table below the header.
 */
export function TagViewPage({ tag, color }: TagViewPageProps): React.JSX.Element {
  const { t } = useT('notes')
  const { total } = useTagItems(tag)
  const colors = getTagColors(color ?? '', tag)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <span
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ backgroundColor: withAlpha(colors.text, 0.12), color: colors.text }}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: colors.text }}
          />
          <span className="truncate">{tag}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{total}</span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          disabled
          aria-label={t('tagView.moreActions')}
        >
          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
      {/* Table arrives in Task 18 */}
    </div>
  )
}

export default TagViewPage
