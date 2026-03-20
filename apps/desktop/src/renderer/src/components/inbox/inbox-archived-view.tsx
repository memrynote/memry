import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  useInboxArchived,
  useUnarchiveInboxItem,
  useDeletePermanentInboxItem
} from '@/hooks/use-inbox'
import { InboxArchivedItemRow } from './inbox-archived-item-row'
import type { InboxItemListItem } from '../../../../preload/index.d'

interface ArchivedInboxItem extends InboxItemListItem {
  archivedAt?: Date | string
}

export interface InboxArchivedViewProps {
  className?: string
  searchQuery?: string
}

export function InboxArchivedView({
  className,
  searchQuery = ''
}: InboxArchivedViewProps): React.JSX.Element {
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 250)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const { items, total, hasMore, isLoading, loadMore, isLoadingMore } = useInboxArchived({
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

  const handleUnarchive = (id: string): void => {
    unarchiveMutation.mutate(id)
  }

  const handleDelete = (id: string): void => {
    deleteMutation.mutate(id)
  }

  if (isLoading && items.length === 0 && !searchQuery) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-64 gap-4', className)}>
        <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="px-6 pb-3">
        <p className="text-[11px] text-muted-foreground/50">
          {total} archived item{total !== 1 ? 's' : ''}
        </p>
      </div>

      {sortedItems.length === 0 && !isLoading ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Archive className="size-6 text-muted-foreground/30 mb-3" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground/50">
            {searchQuery ? 'No matching archived items' : 'No archived items'}
          </p>
        </div>
      ) : (
        <div role="list">
          {sortedItems.map((item) => (
            <InboxArchivedItemRow
              key={item.id}
              item={item}
              onUnarchive={handleUnarchive}
              onDelete={handleDelete}
              isUnarchiving={unarchiveMutation.isPending && unarchiveMutation.variables === item.id}
              isDeleting={deleteMutation.isPending && deleteMutation.variables === item.id}
            />
          ))}
        </div>
      )}

      {hasMore && (
        <div ref={observerTarget} className="py-6 flex justify-center">
          {isLoadingMore && <Loader2 className="size-5 text-muted-foreground/40 animate-spin" />}
        </div>
      )}
    </div>
  )
}
