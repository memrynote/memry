import { useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import { Archive, Loader2, ChevronRight } from 'lucide-react'
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
}

export function InboxArchivedView({ className }: InboxArchivedViewProps): React.JSX.Element {
  const { items, hasMore, isLoading, loadMore, isLoadingMore } = useInboxArchived()
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set())

  const toggleMonth = (month: string): void => {
    setCollapsedMonths((prev) => {
      const next = new Set(prev)
      if (next.has(month)) {
        next.delete(month)
      } else {
        next.add(month)
      }
      return next
    })
  }

  const unarchiveMutation = useUnarchiveInboxItem()
  const deleteMutation = useDeletePermanentInboxItem()
  const observerTarget = useRef<HTMLDivElement>(null)

  const groupedItems = useMemo(() => {
    if (!items || items.length === 0) return {}

    const groups: Record<string, ArchivedInboxItem[]> = {}
    const archivedItems = items as ArchivedInboxItem[]

    const sortedItems = [...archivedItems].sort((a, b) => {
      const dateA = a.archivedAt ? new Date(a.archivedAt) : new Date(a.createdAt)
      const dateB = b.archivedAt ? new Date(b.archivedAt) : new Date(b.createdAt)
      return dateB.getTime() - dateA.getTime()
    })

    sortedItems.forEach((item) => {
      const date = item.archivedAt ? new Date(item.archivedAt) : new Date(item.createdAt)
      const key = format(date, 'MMMM yyyy')

      if (!groups[key]) {
        groups[key] = []
      }
      groups[key].push(item)
    })

    return groups
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

  if (isLoading && items.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-64 gap-4', className)}>
        <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
        <p className="text-sm text-muted-foreground/60 font-serif">Loading archives...</p>
      </div>
    )
  }

  if (!isLoading && items.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center h-full w-full p-8 text-center',
          className
        )}
      >
        <div className="size-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Archive className="size-8 text-primary" strokeWidth={1.5} />
        </div>
        <h3 className="text-2xl font-medium text-foreground mb-2">No archived items</h3>
        <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
          Items you archive from your inbox will appear here for safekeeping.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-6', className)}>
      {Object.entries(groupedItems).map(([month, monthItems]) => {
        const isCollapsed = collapsedMonths.has(month)

        return (
          <section key={month}>
            <button
              type="button"
              onClick={() => toggleMonth(month)}
              className={cn(
                'flex items-center gap-2 w-full px-1 py-1.5 -mx-1 rounded-md',
                'hover:bg-muted/50 transition-colors duration-150',
                'cursor-pointer select-none'
              )}
              aria-expanded={!isCollapsed}
              aria-controls={`month-${month}`}
            >
              <ChevronRight
                className={cn(
                  'size-4 text-muted-foreground/50 transition-transform duration-200',
                  !isCollapsed && 'rotate-90'
                )}
              />
              <h3 className="text-sm font-medium text-muted-foreground/70 tracking-wide uppercase">
                {month}
              </h3>
              <span className="text-xs text-muted-foreground/50">
                ({monthItems.length} item{monthItems.length !== 1 ? 's' : ''})
              </span>
            </button>

            <div
              id={`month-${month}`}
              className={cn(
                'space-y-0.5 overflow-hidden transition-all duration-200',
                isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[5000px] opacity-100'
              )}
              role="list"
            >
              {monthItems.map((item) => (
                <InboxArchivedItemRow
                  key={item.id}
                  item={item}
                  onUnarchive={handleUnarchive}
                  onDelete={handleDelete}
                  isUnarchiving={
                    unarchiveMutation.isPending && unarchiveMutation.variables === item.id
                  }
                  isDeleting={deleteMutation.isPending && deleteMutation.variables === item.id}
                />
              ))}
            </div>
          </section>
        )
      })}

      {hasMore && (
        <div ref={observerTarget} className="py-8 flex justify-center">
          {isLoadingMore ? (
            <Loader2 className="size-6 text-muted-foreground animate-spin" />
          ) : (
            <div className="h-4" />
          )}
        </div>
      )}
    </div>
  )
}
