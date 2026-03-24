import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Check, Clock, Filter, Search, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { SRAnnouncer } from '@/components/sr-announcer'
import { PageToolbar, ToolbarButton } from '@/components/ui/page-toolbar'
import { InboxSegmentControl, type InboxView } from '@/components/inbox/inbox-segment-control'
import { CaptureInput } from '@/components/capture-input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel
} from '@/components/ui/dropdown-menu'
import { useInboxNotifications } from '@/hooks/use-inbox-notifications'
import { useInboxList, useInboxSnoozed } from '@/hooks/use-inbox'
import type { InboxItemType } from '@memry/contracts/inbox-api'
import { InboxListView } from './inbox/inbox-list-view'
import { InboxHealthView } from './inbox/inbox-health-view'
import { InboxArchivedView } from './inbox/inbox-archived-view'
import { TriageView } from './inbox/triage-view'

const INBOX_ITEM_TYPES: InboxItemType[] = [
  'link',
  'note',
  'image',
  'voice',
  'video',
  'clip',
  'pdf',
  'social',
  'reminder'
]

const INBOX_TYPE_LABELS: Record<InboxItemType, string> = {
  link: 'Links',
  note: 'Notes',
  image: 'Images',
  voice: 'Voice',
  video: 'Video',
  clip: 'Clips',
  pdf: 'PDFs',
  social: 'Social',
  reminder: 'Reminders'
}

interface InboxPageProps {
  className?: string
}

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  const [currentView, setCurrentView] = useState<InboxView>('inbox')
  const [isTriageMode, setIsTriageMode] = useState(false)
  const [selectedTypes, setSelectedTypes] = useState<Set<InboxItemType>>(new Set())
  const [showSnoozedItems, setShowSnoozedItems] = useState(false)
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [isArchivedSearchOpen, setIsArchivedSearchOpen] = useState(false)
  const [archivedSearchQuery, setArchivedSearchQuery] = useState('')
  const archivedSearchRef = useRef<HTMLInputElement>(null)
  useInboxNotifications()
  const { items } = useInboxList()
  const { data: snoozedItems = [] } = useInboxSnoozed()
  const snoozedCount = snoozedItems.length

  const itemCountsByType = useMemo(() => {
    const counts: Record<InboxItemType, number> = {
      link: 0,
      note: 0,
      image: 0,
      voice: 0,
      video: 0,
      clip: 0,
      pdf: 0,
      social: 0,
      reminder: 0
    }
    items.forEach((item) => {
      counts[item.type]++
    })
    return counts
  }, [items])

  const hasActiveFilters = selectedTypes.size > 0

  const enterTriage = useCallback(() => setIsTriageMode(true), [])
  const exitTriage = useCallback(() => setIsTriageMode(false), [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        if (isTriageMode) {
          exitTriage()
        } else {
          enterTriage()
        }
      }
      if (e.key === 'Escape' && isTriageMode) {
        e.preventDefault()
        exitTriage()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isTriageMode, enterTriage, exitTriage])

  const closeArchivedSearch = useCallback(() => {
    setArchivedSearchQuery('')
    setIsArchivedSearchOpen(false)
  }, [])

  useEffect(() => {
    if (isArchivedSearchOpen) {
      requestAnimationFrame(() => archivedSearchRef.current?.focus())
    }
  }, [isArchivedSearchOpen])

  useEffect(() => {
    if (currentView !== 'archived') {
      setIsArchivedSearchOpen(false)
      setArchivedSearchQuery('')
    }
  }, [currentView])

  useEffect(() => {
    const handler = (): void => enterTriage()
    window.addEventListener('memry:enter-triage', handler)
    return () => window.removeEventListener('memry:enter-triage', handler)
  }, [enterTriage])

  return (
    <>
      {isTriageMode ? (
        <TriageView onExit={exitTriage} />
      ) : (
        <div className="flex h-full flex-col">
          <PageToolbar className="px-2 py-1 min-h-[38px]">
            <InboxSegmentControl value={currentView} onChange={setCurrentView} />

            {currentView === 'inbox' && (
              <CaptureInput
                compact
                density="compact"
                onCaptureSuccess={() => toast.success('Item captured')}
                onCaptureError={(errorMsg) => toast.error(errorMsg)}
              />
            )}

            {currentView === 'inbox' && items.length > 0 && (
              <button
                type="button"
                onClick={enterTriage}
                title="Process inbox (Cmd+P)"
                className="flex items-center shrink-0 rounded-[5px] py-1 px-2.5 gap-1.5 bg-amber-500/[0.08] border border-amber-500/20 text-amber-500 transition-colors hover:bg-amber-500/[0.12]"
              >
                <Check className="size-3" />
                <span className="text-[12px] leading-4 font-medium">Triage</span>
                <span className="flex items-center justify-center rounded-[10px] py-px px-1.5 bg-amber-500/15 text-[11px] leading-3.5 font-semibold">
                  {items.length}
                </span>
              </button>
            )}

            {currentView === 'archived' && (
              <div
                className={cn(
                  'ml-auto flex items-center rounded-[5px] py-1 border overflow-hidden outline-none',
                  'transition-[width] duration-150 ease-out',
                  isArchivedSearchOpen
                    ? 'w-52 border-transparent pl-2 pr-1.5 gap-1'
                    : 'w-[30px] border-border text-text-secondary hover:bg-surface-active/50 justify-center cursor-pointer'
                )}
                onClick={() => {
                  if (!isArchivedSearchOpen) setIsArchivedSearchOpen(true)
                }}
                role={!isArchivedSearchOpen ? 'button' : undefined}
                tabIndex={!isArchivedSearchOpen ? 0 : undefined}
                title={!isArchivedSearchOpen ? 'Search archived items' : undefined}
                onKeyDown={(e) => {
                  if (!isArchivedSearchOpen && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    setIsArchivedSearchOpen(true)
                  }
                }}
              >
                <Search className="size-3 shrink-0" />
                <input
                  ref={archivedSearchRef}
                  type="text"
                  value={archivedSearchQuery}
                  onChange={(e) => setArchivedSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') closeArchivedSearch()
                  }}
                  placeholder="Search..."
                  className={cn(
                    'min-w-0 bg-transparent text-[12px] leading-4 outline-none border-none ring-0 shadow-none text-foreground placeholder:text-muted-foreground/40',
                    isArchivedSearchOpen ? 'flex-1' : 'w-0 opacity-0'
                  )}
                  tabIndex={isArchivedSearchOpen ? 0 : -1}
                />
                {isArchivedSearchOpen && archivedSearchQuery && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setArchivedSearchQuery('')
                      archivedSearchRef.current?.focus()
                    }}
                    className="shrink-0 p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            )}

            {currentView === 'inbox' && (
              <>
                <ToolbarButton
                  isActive={showSnoozedItems}
                  onClick={() => setShowSnoozedItems(!showSnoozedItems)}
                  title={
                    showSnoozedItems
                      ? 'Hide snoozed items'
                      : `Show snoozed items${snoozedCount > 0 ? ` (${snoozedCount})` : ''}`
                  }
                >
                  <Clock className="size-3" />
                  {snoozedCount > 0 && (
                    <span
                      className={cn(
                        'flex items-center justify-center size-[14px] rounded-full text-[9px] font-bold',
                        showSnoozedItems
                          ? 'bg-foreground text-background'
                          : 'bg-foreground/15 text-text-secondary'
                      )}
                    >
                      {snoozedCount}
                    </span>
                  )}
                </ToolbarButton>

                <DropdownMenu open={isFilterOpen} onOpenChange={setIsFilterOpen}>
                  <DropdownMenuTrigger asChild>
                    <ToolbarButton
                      isActive={isFilterOpen || hasActiveFilters}
                      title={
                        hasActiveFilters
                          ? `Filtering by ${selectedTypes.size} type${selectedTypes.size > 1 ? 's' : ''}`
                          : 'Filter by type'
                      }
                    >
                      <Filter className="size-3" />
                      <span className="text-[11px] leading-3.5">Filter</span>
                      {hasActiveFilters && (
                        <span className="flex items-center justify-center size-[14px] rounded-full bg-foreground text-background text-[9px] font-bold">
                          {selectedTypes.size}
                        </span>
                      )}
                    </ToolbarButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuLabel className="text-xs text-muted-foreground/70">
                      Filter by type
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {INBOX_ITEM_TYPES.map((type) => {
                      const count = itemCountsByType[type]
                      return (
                        <DropdownMenuCheckboxItem
                          key={type}
                          checked={selectedTypes.has(type)}
                          onCheckedChange={(checked) => {
                            setSelectedTypes((prev) => {
                              const next = new Set(prev)
                              if (checked) next.add(type)
                              else next.delete(type)
                              return next
                            })
                          }}
                          onSelect={(e) => e.preventDefault()}
                          disabled={count === 0}
                          className={cn(count === 0 && 'opacity-50')}
                        >
                          <span className="flex-1">{INBOX_TYPE_LABELS[type]}</span>
                          <span className="text-xs text-muted-foreground/60 ml-2">{count}</span>
                        </DropdownMenuCheckboxItem>
                      )
                    })}
                    {hasActiveFilters && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuCheckboxItem
                          checked={false}
                          onCheckedChange={() => setSelectedTypes(new Set())}
                          onSelect={(e) => e.preventDefault()}
                          className="text-muted-foreground/70"
                        >
                          Clear all
                        </DropdownMenuCheckboxItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </PageToolbar>

          <div className="min-h-0 flex-1">
            {currentView === 'inbox' && (
              <InboxListView
                className={className}
                selectedTypes={selectedTypes}
                showSnoozedItems={showSnoozedItems}
              />
            )}
            {currentView === 'archived' && (
              <InboxArchivedView className={className} searchQuery={archivedSearchQuery} />
            )}
            {currentView === 'insights' && <InboxHealthView className={className} />}
          </div>
        </div>
      )}

      <SRAnnouncer />
    </>
  )
}
