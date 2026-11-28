import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { TagChipContent } from '@/components/tags-hub/tag-chip-item'
import type { HubTag } from '@/hooks/use-tag-categories'

export interface AzListProps {
  tags: HubTag[]
  onTagOpen: (tag: string) => void
}

/**
 * The A-Z view of the tag hub: every tag once, in one wrapping row of the same
 * `TagChipContent` chips the categories view draws. The chips are plain
 * buttons, not sortables: a flat alphabetical list has no order to rearrange
 * and no category to drop into, so there is no drag affordance at all.
 */
export function AzList({ tags, onTagOpen }: AzListProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <section className="flex flex-col gap-[11px] py-[22px]">
      <div className="flex items-center gap-1">
        <h3 className="text-[13px] font-medium leading-[18px] tracking-[-0.005em] text-foreground">
          {t('tagsHub.azList.heading')}
        </h3>
        <span className="ms-1.5 text-xs text-muted-foreground/70 tabular-nums">{tags.length}</span>
      </div>
      {tags.length === 0 ? (
        <div className="text-xs text-muted-foreground/80">{t('tagsHub.azList.empty')}</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <button
              key={tag.tag}
              type="button"
              onClick={() => onTagOpen(tag.tag)}
              title={`${tag.tag} (${tag.count})`}
              className="flex min-w-0 rounded-[7px]"
            >
              <TagChipContent tag={tag} />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

export default AzList
