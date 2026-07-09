import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Archive, ArrowTurnBackward, Loader2, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  useInboxArchived,
  useInboxItem,
  useUnarchiveInboxItem,
  useDeletePermanentInboxItem
} from '@/hooks/use-inbox'
import { InboxListSection, ListTypeIcon } from '@/components/inbox'
import { InboxDetailPanel } from '@/components/inbox-detail'
import { groupItemsByTimePeriod, formatCompactRelativeTime, extractDomain } from '@/lib/inbox-utils'
import { DENSITY_CONFIG } from '@/hooks/use-display-density'
import type { InboxItemListItem } from '@/types'

interface ArchivedInboxItem extends InboxItemListItem {
  archivedAt?: Date | string
}

export interface InboxArchivedViewProps {
  className?: string
  searchQuery?: string
}

const densityConfig = DENSITY_CONFIG.compact

function ArchivedListItem({
  item,
  onPreview,
  onUnarchive,
  onDelete,
  isFocused,
  isUnarchiving,
  isDeleting
}: {
  item: ArchivedInboxItem
  onPreview: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  isFocused: boolean
  isUnarchiving: boolean
  isDeleting: boolean
}): React.JSX.Element {
  const { t } = useT('inbox')
  const displayTitle = item.title || t('list.untitled')
  const typeLabels = {
    link: t('type.link'),
    note: t('type.note'),
    image: t('type.image'),
    voice: t('type.voice'),
    video: t('type.video'),
    clip: t('type.clip'),
    pdf: t('type.pdf'),
    social: t('type.social'),
    reminder: t('type.reminder')
  }

  return (
    <li
      className={cn(
        'group relative w-full',
        'flex items-center',
        'gap-2.5',
        densityConfig.itemPadding,
        densityConfig.itemRadius,
        'transition-all duration-150 ease-out',
        'cursor-pointer',
        'hover:bg-muted/50',
        isFocused && 'bg-muted'
      )}
      aria-label={t('list.itemAria', { type: typeLabels[item.type], title: displayTitle })}
      onClick={() => onPreview(item.id)}
      data-item-id={item.id}
    >
      <div className="flex-shrink-0">
        <ListTypeIcon type={item.type} />
      </div>

      <span
        className={cn(
          'grow shrink min-w-0 truncate font-medium',
          densityConfig.titleSize,
          'text-foreground/90'
        )}
      >
        {displayTitle}
      </span>

      {item.sourceUrl &&
        (item.type === 'link' || item.type === 'social' || item.type === 'clip') && (
          <span className={cn('shrink-0', densityConfig.metaSize, 'text-muted-foreground/60')}>
            {extractDomain(item.sourceUrl)}
          </span>
        )}

      <span
        className={cn(
          'shrink-0 w-9 text-end tabular-nums',
          densityConfig.metaSize,
          'text-muted-foreground/60'
        )}
      >
        {formatCompactRelativeTime(
          item.archivedAt
            ? new Date(item.archivedAt)
            : item.createdAt instanceof Date
              ? item.createdAt
              : new Date(item.createdAt)
        )}
      </span>

      <div className="shrink-0 quick-actions-reveal flex items-center gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onUnarchive(item.id)
          }}
          disabled={isUnarchiving || isDeleting}
          className={cn(
            'p-1.5 rounded-md transition-colors',
            'text-muted-foreground/50 hover:text-foreground hover:bg-muted',
            isUnarchiving && 'animate-spin'
          )}
          title={t('detail.restoreToInbox')}
          aria-label={t('detail.restoreToInbox')}
        >
          {isUnarchiving ? (
            <Loader2 className="size-3.5" />
          ) : (
            <ArrowTurnBackward className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(item.id)
          }}
          disabled={isUnarchiving || isDeleting}
          className={cn(
            'p-1.5 rounded-md transition-colors',
            'text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10',
            isDeleting && 'animate-spin'
          )}
          title={t('detail.deletePermanently')}
          aria-label={t('detail.deletePermanently')}
        >
          {isDeleting ? <Loader2 className="size-3.5" /> : <Trash2 className="size-3.5" />}
        </button>
      </div>
    </li>
  )
}

export function InboxArchivedView({
  className,
  searchQuery = ''
}: InboxArchivedViewProps): React.JSX.Element {
  const { t } = useT('inbox')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [activeDetailItemId, setActiveDetailItemId] = useState<string | null>(null)
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 250)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const { items, hasMore, isLoading, loadMore, isLoadingMore } = useInboxArchived({
    search: debouncedSearch || undefined
  })

  const unarchiveMutation = useUnarchiveInboxItem()
  const deleteMutation = useDeletePermanentInboxItem()
  const observerTarget = useRef<HTMLDivElement>(null)

  const sortedItems = useMemo(() => {
    if (!items || items.length === 0) return []

    const archivedItems = items as ArchivedInboxItem[]
    return [...archivedItems].sort((a, b) => {
      const dateA = a.archivedAt ? new Date(a.archivedAt) : new Date(a.createdAt)
      const dateB = b.archivedAt ? new Date(b.archivedAt) : new Date(b.createdAt)
      return dateB.getTime() - dateA.getTime()
    })
  }, [items])

  const groupedItems = useMemo(
    () =>
      groupItemsByTimePeriod(sortedItems, (item: ArchivedInboxItem) =>
        item.archivedAt ? new Date(item.archivedAt) : new Date(item.createdAt)
      ),
    [sortedItems]
  )

  useEffect(() => {
    const currentTarget = observerTarget.current
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          void loadMore()
        }
      },
      { threshold: 0.1 }
    )

    if (currentTarget) {
      observer.observe(currentTarget)
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget)
      }
    }
  }, [hasMore, isLoadingMore, loadMore])

  const handleUnarchive = useCallback(
    (id: string): void => {
      unarchiveMutation.mutate(id)
      if (activeDetailItemId === id) setActiveDetailItemId(null)
    },
    [unarchiveMutation, activeDetailItemId]
  )

  const handleDelete = useCallback(
    (id: string): void => {
      deleteMutation.mutate(id)
      if (activeDetailItemId === id) setActiveDetailItemId(null)
    },
    [deleteMutation, activeDetailItemId]
  )

  const handlePreview = useCallback(
    (id: string): void => {
      if (activeDetailItemId === id) {
        setActiveDetailItemId(null)
      } else {
        setActiveDetailItemId(id)
        setFocusedItemId(id)
      }
    },
    [activeDetailItemId]
  )

  const { item: fullDetailItem, isLoading: isDetailLoading } = useInboxItem(activeDetailItemId)
  const activeDetailItem = useMemo(() => {
    if (!activeDetailItemId) return null
    if (fullDetailItem) return fullDetailItem
    return sortedItems.find((item) => item.id === activeDetailItemId) || null
  }, [activeDetailItemId, fullDetailItem, sortedItems])

  const isDetailPanelOpen = activeDetailItemId !== null

  const noopFile = useCallback((): void => {}, [])

  if (isLoading && items.length === 0 && !searchQuery) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-64 gap-4', className)}>
        <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
      </div>
    )
  }

  return (
    <div className={cn('flex h-full overflow-hidden', className)}>
      <div
        data-inbox-scroll
        className="flex flex-col flex-1 min-w-0 h-full px-4 lg:px-6 pt-[46px] pb-4 lg:pb-6 overflow-y-auto"
      >
        {sortedItems.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Archive className="size-6 text-muted-foreground/30 mb-3" strokeWidth={1.5} />
            <p className="text-sm text-muted-foreground/50">
              {searchQuery ? t('empty.archivedNoMatches') : t('empty.archivedNone')}
            </p>
          </div>
        ) : (
          <ul className="space-y-1" aria-label={t('view.archivedItemsAria')}>
            {groupedItems.map((group) => {
              const sectionTitle =
                group.period === 'TODAY'
                  ? t('list.section.today')
                  : group.period === 'YESTERDAY'
                    ? t('list.section.yesterday')
                    : t('list.section.older')

              return (
                <InboxListSection
                  key={group.period}
                  title={sectionTitle}
                  count={group.items.length}
                  collapsible
                  selectedIds={new Set<string>()}
                  focusedId={focusedItemId}
                  density="compact"
                  onSelect={() => {}}
                  onFocus={setFocusedItemId}
                >
                  {group.items.map((item) => (
                    <ArchivedListItem
                      key={item.id}
                      item={item}
                      onPreview={handlePreview}
                      onUnarchive={handleUnarchive}
                      onDelete={handleDelete}
                      isFocused={focusedItemId === item.id}
                      isUnarchiving={
                        unarchiveMutation.isPending && unarchiveMutation.variables === item.id
                      }
                      isDeleting={deleteMutation.isPending && deleteMutation.variables === item.id}
                    />
                  ))}
                </InboxListSection>
              )
            })}
          </ul>
        )}

        {hasMore && (
          <div ref={observerTarget} className="py-6 flex justify-center">
            {isLoadingMore && <Loader2 className="size-5 text-muted-foreground/40 animate-spin" />}
          </div>
        )}
      </div>

      <InboxDetailPanel
        isOpen={isDetailPanelOpen}
        item={activeDetailItem}
        isLoading={isDetailLoading}
        readOnly
        onClose={() => setActiveDetailItemId(null)}
        onFile={noopFile}
        onArchive={noopFile}
        onRestore={handleUnarchive}
        onDelete={handleDelete}
      />
    </div>
  )
}
