import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
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
 * Rename swaps the heading for an inline input (matching the create
 * affordance): Enter commits the trimmed name, Escape reverts. Delete opens
 * the app's `AlertDialog` — its body calls out that tags survive the delete
 * and move to Uncategorized, since that isn't obvious from "Delete".
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
  const [isRenaming, setIsRenaming] = useState(false)
  const [draftName, setDraftName] = useState(name)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus()
    }
  }, [isRenaming])

  const startRename = (): void => {
    setDraftName(name)
    setIsRenaming(true)
  }

  const commitRename = (): void => {
    const trimmed = draftName.trim()
    if (trimmed) {
      onRename?.(trimmed)
    }
    setIsRenaming(false)
  }

  const cancelRename = (): void => {
    setDraftName(name)
    setIsRenaming(false)
  }

  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRename()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelRename()
    }
  }

  const handleConfirmDelete = (): void => {
    onDelete?.()
    setIsDeleteOpen(false)
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="group flex items-center gap-2">
        {isRenaming ? (
          <Input
            ref={inputRef}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            className="h-7 w-48"
          />
        ) : (
          <h3 className="text-sm font-medium text-foreground">{name}</h3>
        )}
        <span className="ms-auto text-xs text-muted-foreground tabular-nums">{tags.length}</span>
        {id !== null && !isRenaming && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('tagsHub.category.rename')}
              onClick={startRename}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('tagsHub.category.delete')}
              onClick={() => setIsDeleteOpen(true)}
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {id !== null && (
        <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('tagsHub.category.deleteTitle', { name })}</AlertDialogTitle>
              <AlertDialogDescription>{t('tagsHub.category.deleteBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('tagsHub.category.deleteCancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={handleConfirmDelete}>
                {t('tagsHub.category.deleteConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

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
