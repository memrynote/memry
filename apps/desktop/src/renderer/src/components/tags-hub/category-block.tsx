import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Pencil, Trash } from '@/lib/icons'
import { TagChipItem } from '@/components/tags-hub/tag-chip-item'
import type { HubTag } from '@/hooks/use-tag-categories'

export interface CategoryBlockProps {
  id: string | null
  name: string
  tags: HubTag[]
  onTagOpen(tag: string): void
  onRename?(name: string): void
  onDelete?(): void
}

/**
 * One category section in the tag hub: a heading (name + tag count, plus
 * hover-revealed rename/delete for real categories) followed by a wrapping
 * row of tag chips. `id === null` is the Uncategorized block, which has no
 * rename or delete affordance.
 *
 * Rename/delete here are bare hover-revealed buttons only — the confirm
 * dialogs and rename input are Task 11's job.
 */
export function CategoryBlock({
  id,
  name,
  tags,
  onTagOpen,
  onRename,
  onDelete
}: CategoryBlockProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <section className="flex flex-col gap-2">
      <div className="group flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{name}</h3>
        <span className="ms-auto text-xs text-muted-foreground tabular-nums">{tags.length}</span>
        {id !== null && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('tagsHub.category.rename')}
              onClick={() => onRename?.(name)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('tagsHub.category.delete')}
              onClick={() => onDelete?.()}
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {tags.length === 0 ? (
        <div className="rounded-md border border-dashed py-3 text-center text-xs text-muted-foreground">
          {t('tagsHub.category.emptyHint')}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <TagChipItem key={tag.tag} tag={tag} onOpen={() => onTagOpen(tag.tag)} />
          ))}
        </div>
      )}
    </section>
  )
}

export default CategoryBlock
