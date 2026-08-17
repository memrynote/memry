import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Bell,
  AlarmClock,
  FileText,
  FilePdf,
  Image,
  Link2,
  Mic,
  Scissors,
  Search,
  Share2,
  Video,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { motion, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { SRAnnouncer } from '@/components/sr-announcer'
import { PageToolbar } from '@/components/ui/page-toolbar'
import { InboxSegmentControl, type InboxView } from '@/components/inbox/inbox-segment-control'
import { CaptureInput } from '@/components/capture-input'
import { Picker } from '@/components/ui/picker'
import { useInboxNotifications } from '@/hooks/use-inbox-notifications'
import { useInboxJobs, useInboxList } from '@/hooks/use-inbox'
import { useInboxRemindersPanel } from '@/hooks/use-inbox-reminders-panel'
import { useActiveTab } from '@/contexts/tabs'
import { useTabViewState } from '@/hooks/use-tab-view-state'
import {
  INBOX_ITEM_TYPES,
  INBOX_VIEW_STATE_KEYS,
  parseBoolean,
  parseInboxView,
  parseTypeFilter
} from './inbox/inbox-view-state'
import type { InboxItemType } from '@memry/contracts/inbox-api'
import { InboxListView } from './inbox/inbox-list-view'
import { InboxHealthView } from './inbox/inbox-health-view'
import { InboxArchivedView } from './inbox/inbox-archived-view'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:Inbox')

const INBOX_TYPE_ICONS: Record<InboxItemType, React.ComponentType<{ className?: string }>> = {
  link: Link2,
  note: FileText,
  image: Image,
  voice: Mic,
  video: Video,
  clip: Scissors,
  pdf: FilePdf,
  social: Share2,
  reminder: Bell
}

/** Stable identity, so the type filter's default never re-seeds the hook. */
const NO_TYPES: InboxItemType[] = []

interface InboxPageProps {
  className?: string
}

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  const { t } = useT('inbox')
  // Which sub-view, which type filter and whether snoozed items show all belong
  // to the tab: only the active tab is mounted, so plain local state is thrown
  // away every time the user switches tabs.
  const [currentView, setCurrentView] = useTabViewState<InboxView>({
    key: INBOX_VIEW_STATE_KEYS.view,
    defaultValue: 'inbox',
    parse: parseInboxView
  })
  // Stored as an array — `viewState` is serialised to disk, and a Set is not.
  const [selectedTypeFilter, setSelectedTypeFilter] = useTabViewState<InboxItemType[]>({
    key: INBOX_VIEW_STATE_KEYS.typeFilter,
    defaultValue: NO_TYPES,
    parse: parseTypeFilter
  })
  const [showSnoozedItems, setShowSnoozedItems] = useTabViewState<boolean>({
    key: INBOX_VIEW_STATE_KEYS.showSnoozed,
    defaultValue: false,
    parse: parseBoolean
  })
  const selectedTypes = useMemo(() => new Set(selectedTypeFilter), [selectedTypeFilter])
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [isArchivedSearchOpen, setIsArchivedSearchOpen] = useState(false)
  const [archivedSearchQuery, setArchivedSearchQuery] = useState('')
  const archivedSearchRef = useRef<HTMLInputElement>(null)
  // Scroll-edge state for the floating chrome: true once content is beneath it
  const [isScrolled, setIsScrolled] = useState(false)
  const prefersReducedMotion = useReducedMotion()
  useInboxNotifications()
  const { items } = useInboxList()
  const { upcomingCount } = useInboxRemindersPanel()
  const { activeCount: activeJobCount, failedCount: failedJobCount } = useInboxJobs(
    items.map((item) => item.id)
  )

  // Failed processing jobs are logged, not surfaced in the UI — a failed link
  // fetch just leaves the item with its existing content, which isn't actionable
  // by the user.
  useEffect(() => {
    if (failedJobCount > 0) {
      log.warn(`${failedJobCount} inbox processing job(s) failed`)
    }
  }, [failedJobCount])

  const activeTab = useActiveTab()
  const focusCaptureSignal =
    typeof activeTab?.viewState?.focusCaptureAt === 'number'
      ? activeTab.viewState.focusCaptureAt
      : undefined
  const focusInboxItemId =
    typeof activeTab?.viewState?.focusInboxItemId === 'string'
      ? activeTab.viewState.focusInboxItemId
      : null
  const focusToken =
    typeof activeTab?.viewState?.focusedAt === 'number' ? activeTab.viewState.focusedAt : null
  const lastConsumedFocusTokenRef = useRef<number | null>(null)

  useEffect(() => {
    if (!focusInboxItemId || focusToken === null) return
    if (lastConsumedFocusTokenRef.current === focusToken) return
    lastConsumedFocusTokenRef.current = focusToken
    const focusTimer = window.setTimeout(() => {
      setShowSnoozedItems(true)
      setCurrentView('inbox')
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [focusInboxItemId, focusToken, setCurrentView, setShowSnoozedItems])

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

  const hasActiveFilters = selectedTypeFilter.length > 0
  const typeLabels = useMemo(
    () => ({
      link: t('type.links'),
      note: t('type.notes'),
      image: t('type.images'),
      voice: t('type.voice'),
      video: t('type.video'),
      clip: t('type.clips'),
      pdf: t('type.pdfs'),
      social: t('type.social'),
      reminder: t('type.reminders')
    }),
    [t]
  )

  const handleTypeToggle = useCallback(
    (value: string) => {
      const type = value as InboxItemType
      setSelectedTypeFilter((prev) =>
        prev.includes(type) ? prev.filter((entry) => entry !== type) : [...prev, type]
      )
    },
    [setSelectedTypeFilter]
  )

  const closeArchivedSearch = useCallback(() => {
    setArchivedSearchQuery('')
    setIsArchivedSearchOpen(false)
  }, [])

  const openArchivedSearch = useCallback(() => {
    setIsArchivedSearchOpen(true)
    requestAnimationFrame(() => archivedSearchRef.current?.focus())
  }, [])

  const handleViewChange = useCallback(
    (nextView: InboxView) => {
      setCurrentView(nextView)
      setIsScrolled(false)
      if (nextView !== 'archived') {
        closeArchivedSearch()
      }
    },
    [closeArchivedSearch, setCurrentView]
  )

  // The sub-views own their scroll containers (marked data-inbox-scroll);
  // capture-phase listening reaches them all without prop drilling.
  const handleScrollCapture = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target
    if (!(target instanceof HTMLElement) || !target.hasAttribute('data-inbox-scroll')) return
    setIsScrolled(target.scrollTop > 0)
  }, [])

  // Sidebar "Inbox" click asks to capture: surface the capture bar (CaptureInput
  // then focuses itself via focusSignal). Re-fires on every click via the nonce.
  // Deferred setState matches the focus-item effect above and avoids a cascade render.
  useEffect(() => {
    if (!focusCaptureSignal) return
    const timer = window.setTimeout(() => setCurrentView('inbox'), 0)
    return () => window.clearTimeout(timer)
  }, [focusCaptureSignal, setCurrentView])

  return (
    <>
      {/* overflow-x-clip keeps the off-screen detail drawer inside this pane */}
      <div
        className="relative flex h-full flex-col overflow-x-clip"
        onScrollCapture={handleScrollCapture}
      >
        <PageToolbar
          data-scrolled={isScrolled || undefined}
          className="page-chrome absolute top-0 inset-x-0 z-30 px-2 py-1 min-h-[38px] border-b-0"
        >
          <InboxSegmentControl value={currentView} onChange={handleViewChange} />

          {currentView === 'inbox' && (
            <CaptureInput
              className="grow shrink basis-0 min-w-0"
              focusSignal={focusCaptureSignal}
              onCaptureSuccess={() => toast.success(t('view.itemCaptured'))}
              onCaptureError={(errorMsg) => toast.error(errorMsg)}
            />
          )}

          {currentView === 'archived' && (
            <div
              className={cn(
                'ms-auto flex items-center rounded-[5px] py-1 border overflow-hidden outline-none',
                'transition-[width] duration-150 ease-out',
                isArchivedSearchOpen
                  ? 'w-52 border-transparent ps-2 pe-1.5 gap-1'
                  : 'w-[30px] border-border text-text-secondary hover:bg-surface-active/50 justify-center cursor-pointer'
              )}
              onClick={() => {
                if (!isArchivedSearchOpen) openArchivedSearch()
              }}
              role={!isArchivedSearchOpen ? 'button' : undefined}
              tabIndex={!isArchivedSearchOpen ? 0 : undefined}
              title={!isArchivedSearchOpen ? t('view.searchArchivedTitle') : undefined}
              onKeyDown={(e) => {
                if (!isArchivedSearchOpen && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  openArchivedSearch()
                }
              }}
            >
              <Search className="size-3.5 shrink-0" />
              <input
                ref={archivedSearchRef}
                type="text"
                value={archivedSearchQuery}
                onChange={(e) => setArchivedSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') closeArchivedSearch()
                }}
                aria-label={t('view.searchArchivedTitle')}
                placeholder={t('view.searchPlaceholder')}
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
              {activeJobCount > 0 && (
                <span
                  role="status"
                  title={t('view.jobs.running', { count: activeJobCount })}
                  className="flex items-center gap-1.5 shrink-0 px-1.5 text-[11px] tabular-nums text-text-secondary"
                >
                  <span
                    className="size-1.5 rounded-full bg-amber-500 animate-pulse motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {activeJobCount}
                  <span className="sr-only">
                    {t('view.jobs.running', { count: activeJobCount })}
                  </span>
                </span>
              )}
              <button
                type="button"
                onClick={() => setShowSnoozedItems(!showSnoozedItems)}
                title={
                  showSnoozedItems
                    ? t('view.snoozed.hide')
                    : upcomingCount > 0
                      ? t('view.snoozed.showWithCount', { count: upcomingCount })
                      : t('view.snoozed.show')
                }
                className={cn(
                  'flex items-center justify-center shrink-0 rounded-[5px] py-1 px-2 gap-1',
                  'transition-all duration-150 ease-out active:scale-95',
                  showSnoozedItems
                    ? 'bg-foreground/5 text-foreground/90'
                    : 'text-muted-foreground hover:bg-surface-active/50'
                )}
              >
                <AlarmClock className="size-3.5" />
                {upcomingCount > 0 && (
                  <span
                    className={cn(
                      'flex items-center justify-center size-[14px] rounded-full text-[9px] font-bold',
                      showSnoozedItems
                        ? 'bg-foreground text-background'
                        : 'bg-foreground/15 text-text-secondary'
                    )}
                  >
                    {upcomingCount}
                  </span>
                )}
              </button>

              <Picker
                mode="multi"
                value={selectedTypeFilter}
                onValueChange={handleTypeToggle}
                open={isFilterOpen}
                onOpenChange={setIsFilterOpen}
              >
                <Picker.Trigger asChild>
                  <button
                    type="button"
                    title={
                      hasActiveFilters
                        ? t('view.filter.active', { count: selectedTypes.size })
                        : t('view.filter.byType')
                    }
                    className={cn(
                      'flex items-center justify-center shrink-0 rounded-[5px] py-1 px-2 gap-1',
                      'transition-all duration-150 ease-out active:scale-95',
                      isFilterOpen || hasActiveFilters
                        ? 'bg-foreground/5 text-foreground/90'
                        : 'text-muted-foreground hover:bg-surface-active/50'
                    )}
                  >
                    <svg width="14" height="14" viewBox="0 0 13 13" fill="none">
                      <path
                        d="M2 3h9M3.5 6.5h6M5 10h3"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinecap="round"
                      />
                    </svg>
                    {hasActiveFilters && (
                      <span className="flex items-center justify-center size-[14px] rounded-full bg-foreground text-background text-[9px] font-bold">
                        {selectedTypeFilter.length}
                      </span>
                    )}
                  </button>
                </Picker.Trigger>
                <Picker.Content width={200} align="end">
                  <Picker.List>
                    {INBOX_ITEM_TYPES.map((type) => {
                      const count = itemCountsByType[type]
                      const Icon = INBOX_TYPE_ICONS[type]
                      return (
                        <Picker.Item
                          key={type}
                          value={type}
                          label={typeLabels[type]}
                          indicator="checkbox"
                          icon={<Icon className="size-3.5" />}
                          disabled={count === 0}
                          trailing={
                            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
                              {count}
                            </span>
                          }
                          className={cn(count === 0 && 'opacity-50')}
                        />
                      )
                    })}
                  </Picker.List>
                  {hasActiveFilters && (
                    <Picker.Footer className="py-1.5 px-1">
                      <button
                        type="button"
                        onClick={() => setSelectedTypeFilter(NO_TYPES)}
                        className="flex w-full items-center rounded-[5px] py-1.5 px-2 text-[13px] text-muted-foreground/60 hover:bg-accent hover:text-foreground transition-colors"
                      >
                        {t('view.filter.clearAll')}
                      </button>
                    </Picker.Footer>
                  )}
                </Picker.Content>
              </Picker>
            </>
          )}
        </PageToolbar>

        <div className="min-h-0 flex-1">
          {/* Sub-view content materializes on view switch (crossfade only under
              reduced motion); critically damped spring, no overshoot */}
          <motion.div
            key={currentView}
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
            className="h-full"
          >
            {currentView === 'inbox' && (
              <InboxListView
                className={className}
                selectedTypes={selectedTypes}
                showSnoozedItems={showSnoozedItems}
                density="compact"
                focusItemId={focusInboxItemId}
                {...{ focusToken }}
              />
            )}
            {currentView === 'archived' && (
              <InboxArchivedView className={className} searchQuery={archivedSearchQuery} />
            )}
            {currentView === 'insights' && <InboxHealthView className={className} />}
          </motion.div>
        </div>
      </div>

      <SRAnnouncer />
    </>
  )
}
