import { useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Link, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RelatedIcon } from '@/components/tasks/related-item-icon'
import {
  relatedItemKey,
  useRelatedItemInfo,
  type RelatedRef
} from '@/components/tasks/use-related-item-info'
import {
  useRelatedItemSearch,
  type RelatedSearchItem
} from '@/components/tasks/use-related-item-search'
import type { Task } from '@/data/task-model'
import { PropertyChip, stopKeyPropagation } from './property-chip'
import { shortcutLabelFor, type TaskPropertyOpenState } from './task-property-ids'

interface RelatedChipProps extends TaskPropertyOpenState {
  linkedNoteIds: string[]
  linkedCanvasIds: string[]
  /** The note the block sits in: linked, but never listed or unlinked here. */
  hostNoteId: string | null
  projectColor: string
  onChange: (updates: Pick<Partial<Task>, 'linkedNoteIds' | 'linkedCanvasIds'>) => void
  onOpenItem: (ref: RelatedRef, title: string | null) => void
}

const ROW =
  'flex h-7 w-full items-center gap-2 rounded-[5px] px-2 text-start text-[12px] leading-4 transition-colors'

/**
 * The drawer's Related section as a chip: how many other notes, files and
 * canvases this task points at, and a popover to open, unlink or add them.
 */
export const RelatedChip = ({
  linkedNoteIds,
  linkedCanvasIds,
  hostNoteId,
  projectColor,
  onChange,
  onOpenItem,
  open,
  onOpenChange
}: RelatedChipProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const [query, setQuery] = useState('')

  const shownNoteIds = useMemo(
    () => linkedNoteIds.filter((id) => id !== hostNoteId),
    [linkedNoteIds, hostNoteId]
  )
  const { refs, infoByKey, remember, forget } = useRelatedItemInfo(
    shownNoteIds,
    linkedCanvasIds,
    tCommon('canvas.untitled')
  )

  const isOpen = open === 'related'
  const { notes, canvases } = useRelatedItemSearch(isOpen, query, tCommon('canvas.untitled'))
  const results = useMemo<RelatedSearchItem[]>(() => {
    const linkedNotes = new Set(linkedNoteIds)
    const linkedCanvases = new Set(linkedCanvasIds)
    return [
      ...notes.filter((note) => !linkedNotes.has(note.id)),
      ...canvases.filter((canvas) => !linkedCanvases.has(canvas.id))
    ]
  }, [notes, canvases, linkedNoteIds, linkedCanvasIds])

  if (refs.length === 0 && !isOpen) return null

  const unlink = (ref: RelatedRef): void => {
    if (ref.kind === 'canvas') {
      onChange({ linkedCanvasIds: linkedCanvasIds.filter((id) => id !== ref.id) })
    } else {
      onChange({ linkedNoteIds: linkedNoteIds.filter((id) => id !== ref.id) })
    }
    forget(ref)
  }

  const link = (item: RelatedSearchItem): void => {
    if (item.kind === 'canvas') {
      onChange({ linkedCanvasIds: [...linkedCanvasIds, item.id] })
      remember(item, { kind: 'canvas', title: item.title, icon: item.icon })
    } else {
      onChange({ linkedNoteIds: [...linkedNoteIds, item.id] })
      remember(item, {
        kind: 'note',
        title: item.title,
        emoji: item.emoji,
        fileType: item.fileType
      })
    }
    setQuery('')
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange('related', next)
      }}
    >
      <PopoverTrigger asChild>
        <PropertyChip
          icon={<Link className="size-3 shrink-0" aria-hidden="true" />}
          aria-label={t('inlineProperties.relatedAria', { count: refs.length })}
          title={`${t('drawer.related')} · ${shortcutLabelFor('related')}`}
        >
          {refs.length > 0 ? String(refs.length) : t('drawer.related')}
        </PropertyChip>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-72 flex-col gap-0.5 overflow-hidden p-1"
        onKeyDown={stopKeyPropagation}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('drawer.searchRelated')}
          aria-label={t('drawer.searchRelated')}
          className="h-7 shrink-0 rounded-[5px] bg-surface-active/60 px-2 text-[12px] leading-4 text-text-primary outline-none placeholder:text-text-tertiary"
        />
        <div className="flex min-h-0 flex-col overflow-y-auto">
          {!query &&
            refs.map((ref) => {
              const info = infoByKey[relatedItemKey(ref)]
              const title = info?.title ?? null
              return (
                <div key={relatedItemKey(ref)} className="group flex items-center">
                  <button
                    type="button"
                    onClick={() => onOpenItem(ref, title)}
                    className={cn(ROW, 'min-w-0 flex-1 hover:bg-surface-active')}
                  >
                    <RelatedIcon kind={ref.kind} info={info} projectColor={projectColor} />
                    <span className="min-w-0 flex-1 truncate text-text-primary">
                      {title ?? t('drawer.loading')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => unlink(ref)}
                    className="shrink-0 rounded-sm p-1 text-text-tertiary opacity-0 transition-opacity hover:text-text-secondary focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={t('drawer.removeRelatedItem', {
                      title: title ?? t('drawer.relatedItemFallback')
                    })}
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          {(query || refs.length === 0) &&
            results.map((item) => (
              <button
                key={relatedItemKey(item)}
                type="button"
                onClick={() => link(item)}
                className={cn(ROW, 'hover:bg-surface-active')}
              >
                <RelatedIcon kind={item.kind} info={item} projectColor={projectColor} />
                <span className="min-w-0 flex-1 truncate text-text-primary">{item.title}</span>
              </button>
            ))}
          {(query || refs.length === 0) && results.length === 0 && (
            <span className="px-2 text-[12px] leading-7 text-text-tertiary">
              {query ? t('drawer.noMatchingRelated') : t('drawer.noRelatedAvailable')}
            </span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
