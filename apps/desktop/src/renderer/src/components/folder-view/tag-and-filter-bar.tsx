/**
 * Multi-tag (AND) selection bar for a tag-scoped folder view.
 *
 * Shows the tags currently narrowing the page — the tab's primary tag first,
 * then every tag Ctrl/Cmd-clicked onto it — with per-tag removal, a clear-all,
 * a "Save search" action, and a menu of previously saved searches.
 *
 * The bar only renders when there is something to say: with no extra tags and
 * no saved searches, a tag page looks exactly as it did before multi-tag
 * selection existed.
 *
 * @module components/folder-view/tag-and-filter-bar
 */

import * as React from 'react'
import { Bookmark, Check, Trash2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { useT } from '@memry/i18n/renderer'
import { useTagSearches } from '@/hooks/use-tag-searches'
import { fullTagSelection, sameTagSelection } from '@/lib/tag-filter-selection'
import type { TagSearch } from '@memry/contracts/tag-searches-api'

export interface TagAndFilterBarProps {
  /** The tag this tab is, which cannot be removed without leaving the page. */
  primaryTag: string
  /** Tags ANDed onto the primary, in click order. */
  andTags: string[]
  onRemoveTag: (tag: string) => void
  onClearAll: () => void
  /** Open a saved search: swaps the whole AND set, primary included. */
  onOpenSavedSearch: (search: TagSearch) => void
}

function TagChip({
  tag,
  onRemove,
  removeLabel
}: {
  tag: string
  onRemove?: () => void
  removeLabel?: string
}): React.JSX.Element {
  const colors = getTagColors('', tag)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium leading-4"
      style={
        colors
          ? { backgroundColor: `${colors.text}1A`, color: colors.text }
          : { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }
      }
    >
      <span className="max-w-40 truncate">{tag}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          className="flex size-3.5 shrink-0 items-center justify-center rounded-xs opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-current"
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  )
}

export function TagAndFilterBar({
  primaryTag,
  andTags,
  onRemoveTag,
  onClearAll,
  onOpenSavedSearch
}: TagAndFilterBarProps): React.JSX.Element | null {
  const { t } = useT('notes')
  const { searches, saveSearch, deleteSearch } = useTagSearches()
  const [saveOpen, setSaveOpen] = React.useState(false)
  const [name, setName] = React.useState('')

  const selection = React.useMemo(
    () => fullTagSelection(primaryTag, andTags),
    [primaryTag, andTags]
  )

  const hasExtraTags = andTags.length > 0
  if (!hasExtraTags && searches.length === 0) return null

  const handleSave = (): void => {
    if (saveSearch(name, selection)) {
      setSaveOpen(false)
      setName('')
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-1.5"
      data-testid="tag-and-filter-bar"
      role="group"
      aria-label={t('tagAndFilter.regionLabel')}
    >
      {hasExtraTags && (
        <>
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('tagAndFilter.matchingAll')}
          </span>
          <TagChip tag={primaryTag} />
          {andTags.map((tag) => (
            <TagChip
              key={tag.toLowerCase()}
              tag={tag}
              onRemove={() => onRemoveTag(tag)}
              removeLabel={t('tagAndFilter.removeTag', { tag })}
            />
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onClearAll}
            data-testid="tag-and-filter-clear"
          >
            {t('tagAndFilter.clearAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => setSaveOpen(true)}
            data-testid="tag-and-filter-save"
          >
            <Bookmark className="size-3" />
            {t('tagAndFilter.saveSearch')}
          </Button>
        </>
      )}

      {searches.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-6 gap-1 px-2 text-[11px]', hasExtraTags && 'ms-auto')}
              data-testid="tag-and-filter-saved-menu"
            >
              {t('tagAndFilter.savedSearches')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>{t('tagAndFilter.savedSearches')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {searches.map((search) => (
              <DropdownMenuItem
                key={search.id}
                onSelect={() => onOpenSavedSearch(search)}
                className="flex items-start gap-2"
              >
                <Check
                  className={cn(
                    'mt-0.5 size-3 shrink-0',
                    sameTagSelection(search.tags, selection) ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]">{search.name}</span>
                  <span className="block truncate text-[10.5px] text-muted-foreground">
                    {search.tags.join(' + ')}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={t('tagAndFilter.deleteSearch', { name: search.name })}
                  title={t('tagAndFilter.deleteSearch', { name: search.name })}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    deleteSearch(search.id)
                  }}
                  className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </button>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('tagAndFilter.saveDialogTitle')}</DialogTitle>
            <DialogDescription>{selection.join(' + ')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleSave()
              }
            }}
            placeholder={t('tagAndFilter.saveDialogPlaceholder')}
            aria-label={t('tagAndFilter.saveDialogTitle')}
            data-testid="tag-and-filter-save-name"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              {t('tagAndFilter.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={name.trim() === ''}
              data-testid="tag-and-filter-save-confirm"
            >
              {t('tagAndFilter.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
