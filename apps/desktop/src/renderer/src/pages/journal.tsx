/**
 * Journal Page - Contemplative Editorial Design
 * A refined, warm aesthetic that makes journaling feel premium
 * Left: Large journal writing area with dramatic date display
 * Right: Mini calendar + Schedule + Tasks + AI Connections
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { cn } from '@/lib/utils'
import { Loader2, PanelRight } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Kbd } from '@/components/ui/kbd'
import {
  JournalMonthView,
  JournalYearView,
  JournalErrorBoundary,
  JournalBreadcrumb,
  JournalHeaderActions,
  JournalDateDisplay,
  JournalStatsFooter,
  JournalDayPanel,
  type JournalViewState
} from '@/components/journal'
import { ContentArea, type Block, type HeadingInfo } from '@/components/note'
import { BacklinksSection, type Backlink } from '@/components/note/backlinks'

import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { TagsRow, type Tag } from '@/components/note/tags-row'
import { InfoSection } from '@/components/note/info-section'
import { OutlineInfoPanel, type HeadingItem } from '@/components/shared'
import { useActiveHeading } from '@/hooks/use-active-heading'
import { useNoteTagsQuery, useNoteLinksQuery } from '@/hooks/use-notes-query'
import { usePropertySection } from '@/hooks/use-property-section'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { useEditorSettings } from '@/hooks/use-editor-settings'
import { ExportDialog } from '@/components/note/export-dialog'
import { VersionHistory } from '@/components/note/version-history'
import { toast } from 'sonner'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import {
  formatDateToISO,
  formatDateParts,
  getTodayString,
  parseISODate,
  addDays,
  getMonthStats,
  getMonthName,
  type MonthStat
} from '@/lib/journal-utils'
import {
  useJournalEntry,
  useJournalHeatmap,
  useMonthEntries,
  useYearStats
} from '@/hooks/use-journal'
import { useIsBookmarked } from '@/hooks/use-bookmarks'
import { createLogger } from '@/lib/logger'
import { FindBar } from '@/components/find-bar/find-bar'
import { useFindInPage } from '@/hooks/use-find-in-page'
import { useSettingsModal } from '@/contexts/settings-modal-context'

const log = createLogger('Page:Journal')

// =============================================================================
// CONSTANTS
// =============================================================================

// =============================================================================
// MAIN COMPONENT
// =============================================================================

interface JournalPageProps {
  className?: string
}

export function JournalPage({ className }: JournalPageProps): React.JSX.Element {
  const activeTab = useActiveTab()
  const { openTab } = useTabs()
  const today = getTodayString()

  // Get initial date from tab viewState or default to today
  const initialDate = (activeTab?.viewState?.date as string) || today
  const [selectedDate, setSelectedDate] = useState(initialDate)

  const [isFullWidth, setIsFullWidth] = useState(() => {
    const saved = localStorage.getItem('memry_journal_full_width')
    return saved === 'true'
  })

  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false)

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    return localStorage.getItem('memry_journal_sidebar_collapsed') === 'true'
  })

  // Right sidebar resize
  const SIDEBAR_MIN = 220
  const SIDEBAR_MAX = 480
  const SIDEBAR_DEFAULT = 280
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('memry_journal_sidebar_width')
    return saved ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(saved))) : SIDEBAR_DEFAULT
  })
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(SIDEBAR_DEFAULT)

  const handleResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      isResizingRef.current = true
      startXRef.current = e.clientX
      startWidthRef.current = sidebarWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMove = (ev: globalThis.PointerEvent) => {
        if (!isResizingRef.current) return
        const delta = startXRef.current - ev.clientX
        const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidthRef.current + delta))
        setSidebarWidth(next)
      }

      const handleUp = () => {
        isResizingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('pointermove', handleMove)
        document.removeEventListener('pointerup', handleUp)
        setSidebarWidth((w) => {
          localStorage.setItem('memry_journal_sidebar_width', String(w))
          return w
        })
      }

      document.addEventListener('pointermove', handleMove)
      document.addEventListener('pointerup', handleUp)
    },
    [sidebarWidth]
  )

  // Headings state for outline panel
  const [headings, setHeadings] = useState<HeadingItem[]>([])

  // Journal entry hook
  const {
    entry,
    isLoading: isEntryLoading,
    loadedForDate,
    error: entryError,
    saveError,
    externalUpdateCount,
    updateContent,
    updateTags,
    forceReload,
    retrySave,
    dismissSaveError
  } = useJournalEntry(selectedDate)

  // Show toast when save error occurs
  useEffect(() => {
    if (saveError) {
      toast.error(saveError, {
        description: 'Your content is still in memory. Click to retry saving.',
        action: {
          label: 'Retry',
          onClick: () => {
            retrySave()
          }
        },
        duration: Infinity,
        onDismiss: () => {
          dismissSaveError()
        }
      })
    }
  }, [saveError, retrySave, dismissSaveError])

  // Backlinks hook
  const { incoming: rawBacklinks, isLoading: backlinksLoading } = useNoteLinksQuery(
    entry?.id ?? null
  )

  // Tags hook
  const { tags: allAvailableTags } = useNoteTagsQuery()

  // Journal settings
  const { settings: journalSettings, isLoading: isJournalSettingsLoading } = useJournalSettings()

  // Editor settings
  const { settings: editorSettings } = useEditorSettings()

  const JOURNAL_CONTENT_WIDTH = { narrow: '640px', medium: '640px', wide: '864px' } as const
  const journalContentWidth = isFullWidth
    ? undefined
    : (JOURNAL_CONTENT_WIDTH[editorSettings.width] ?? '640px')

  // Settings modal
  const { open: openSettingsModal } = useSettingsModal()

  // Bookmark state - use entry.id (e.g., "j2026-01-13") to match notes_cache lookup
  const { isBookmarked, toggle: toggleBookmark } = useIsBookmarked('journal', entry?.id ?? '')

  // Ref to track current entry tags for stable callbacks (prevents re-renders on content changes)
  const entryTagsRef = useRef<string[]>([])
  entryTagsRef.current = entry?.tags ?? []

  // Track editor loading
  const [editorLoadCount, setEditorLoadCount] = useState(0)
  const lastLoadedDateRef = useRef<string | null>(null)

  useEffect(() => {
    if (isEntryLoading) return
    if (loadedForDate !== selectedDate) return
    if (lastLoadedDateRef.current === selectedDate) return

    lastLoadedDateRef.current = selectedDate
    setEditorLoadCount((c) => c + 1)
  }, [selectedDate, isEntryLoading, loadedForDate])

  useEffect(() => {
    if (lastLoadedDateRef.current !== null && lastLoadedDateRef.current !== selectedDate) {
      lastLoadedDateRef.current = null
    }
  }, [selectedDate])

  const editorState = useMemo(
    () => ({
      key: `${selectedDate}-${editorLoadCount}-${externalUpdateCount}`,
      content: entry?.content ?? ''
    }),
    [selectedDate, editorLoadCount, externalUpdateCount, entry?.content]
  )

  const isDataPending = isEntryLoading || loadedForDate !== selectedDate
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false)

  useEffect(() => {
    if (isDataPending) {
      const timer = setTimeout(() => setShowLoadingSpinner(true), 150)
      return () => clearTimeout(timer)
    }
    setShowLoadingSpinner(false)
    return undefined
  }, [isDataPending])

  const showEditorLoading = isDataPending && showLoadingSpinner

  // Sync date from tab viewState
  useEffect(() => {
    const tabDate = activeTab?.viewState?.date as string
    if (tabDate && tabDate !== selectedDate) {
      setSelectedDate(tabDate)
      setViewState({ type: 'day', date: tabDate })
    }
  }, [activeTab?.viewState?.date])

  // View state for navigation
  const [viewState, setViewState] = useState<JournalViewState>({ type: 'day', date: initialDate })

  // Find in page (Cmd+F)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const isActiveJournal = activeTab?.type === 'journal'
  const findInPage = useFindInPage(
    editorContainerRef as RefObject<HTMLElement | null>,
    isActiveJournal && viewState.type === 'day'
  )

  // Date parts and heatmap
  const isToday = selectedDate === today
  const selectedDateObj = parseISODate(selectedDate)
  const dateParts = useMemo(() => formatDateParts(selectedDate), [selectedDate])

  const currentYear = dateParts.year
  const { data: heatmapData } = useJournalHeatmap(currentYear)

  const calendarActivityData = useMemo(() => {
    const map: Record<string, number> = {}
    for (const entry of heatmapData) {
      map[entry.date] = entry.level
    }
    return map
  }, [heatmapData])

  const viewMonth = viewState.type === 'month' ? viewState.month : dateParts.monthIndex
  const viewYear =
    viewState.type === 'month' || viewState.type === 'year' ? viewState.year : dateParts.year

  const { data: monthEntriesData } = useMonthEntries(viewYear, viewMonth + 1)
  const { data: yearStatsData } = useYearStats(viewYear)

  const monthEntries = useMemo(() => {
    const entries = new Map<string, { preview: string; characterCount: number }>()
    monthEntriesData.forEach((entry) => {
      entries.set(entry.date, {
        preview: entry.preview || '',
        characterCount: entry.characterCount
      })
    })
    return entries
  }, [monthEntriesData])

  const monthStats: MonthStat[] = useMemo(() => {
    if (yearStatsData.length > 0) {
      const statsMap = new Map(yearStatsData.map((s) => [s.month, s]))
      const result: MonthStat[] = []

      for (let month = 0; month < 12; month++) {
        const backendStats = statsMap.get(month + 1)
        const monthName = getMonthName(month)

        if (backendStats) {
          const avgLevel = Math.round(backendStats.averageLevel) as 0 | 1 | 2 | 3 | 4
          const activityDots: (0 | 1 | 2 | 3 | 4)[] = Array(5).fill(
            backendStats.entryCount > 0 ? avgLevel : 0
          )

          result.push({
            month,
            monthName,
            entryCount: backendStats.entryCount,
            totalChars: backendStats.totalCharacterCount,
            activityDots
          })
        } else {
          result.push({
            month,
            monthName,
            entryCount: 0,
            totalChars: 0,
            activityDots: [0, 0, 0, 0, 0]
          })
        }
      }
      return result
    }

    const year = viewState.type === 'year' ? viewState.year : dateParts.year
    return getMonthStats(year, heatmapData)
  }, [yearStatsData, viewState, dateParts.year, heatmapData])

  const journalScrollRef = useRef<HTMLDivElement>(null)
  const { activeHeadingId } = useActiveHeading({
    headings,
    offset: 120,
    scrollContainerRef: journalScrollRef
  })

  const documentStats = useMemo(() => {
    if (!entry) return undefined
    return {
      wordCount: entry.wordCount ?? 0,
      characterCount: entry.characterCount ?? 0,
      createdAt: entry.createdAt ?? null,
      modifiedAt: entry.modifiedAt ?? null
    }
  }, [entry])

  // Tags & Properties
  const pendingTagColorsRef = useRef(new Map<string, string>())

  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      map.set(t.tag, t.color)
    }
    for (const key of pendingTagColorsRef.current.keys()) {
      if (map.has(key)) pendingTagColorsRef.current.delete(key)
    }
    return map
  }, [allAvailableTags])

  const journalTags: Tag[] = useMemo(() => {
    return (entry?.tags || []).map((tagName) => ({
      id: tagName,
      name: tagName,
      color: tagColorMap.get(tagName) ?? pendingTagColorsRef.current.get(tagName) ?? 'stone'
    }))
  }, [entry?.tags, tagColorMap])

  const availableTags: Tag[] = useMemo(() => {
    return allAvailableTags.map((t) => ({
      id: t.tag,
      name: t.tag,
      color: t.color
    }))
  }, [allAvailableTags])

  const recentTags = useMemo(() => {
    return availableTags.slice(0, 4)
  }, [availableTags])

  const {
    properties,
    handlePropertyChange,
    handleAddProperty,
    handleDeleteProperty,
    handlePropertyNameChange,
    handlePropertyOrderChange
  } = usePropertySection({ entityId: entry?.id ?? null })

  // Navigation
  const navigateToMonth = useCallback((year: number, month: number) => {
    setViewState({ type: 'month', year, month })
  }, [])

  const navigateToYear = useCallback((year: number) => {
    setViewState({ type: 'year', year })
  }, [])

  const navigateToDay = useCallback((date: string) => {
    setSelectedDate(date)
    setViewState({ type: 'day', date })
  }, [])

  const navigateBack = useCallback(() => {
    if (viewState.type === 'month') {
      navigateToYear(viewState.year)
    } else if (viewState.type === 'year') {
      navigateToDay(selectedDate)
    }
  }, [viewState, selectedDate, navigateToYear, navigateToDay])

  const handleTodayClick = useCallback(() => navigateToDay(today), [today, navigateToDay])

  const handlePreviousDay = useCallback(() => {
    const prevDay = addDays(selectedDateObj, -1)
    navigateToDay(formatDateToISO(prevDay))
  }, [selectedDateObj, navigateToDay])

  const handleNextDay = useCallback(() => {
    const nextDay = addDays(selectedDateObj, 1)
    navigateToDay(formatDateToISO(nextDay))
  }, [selectedDateObj, navigateToDay])

  const handlePreviousMonth = useCallback(() => {
    if (viewState.type === 'month') {
      const newMonth = viewState.month === 0 ? 11 : viewState.month - 1
      const newYear = viewState.month === 0 ? viewState.year - 1 : viewState.year
      setViewState({ type: 'month', year: newYear, month: newMonth })
    }
  }, [viewState])

  const handleNextMonth = useCallback(() => {
    if (viewState.type === 'month') {
      const newMonth = viewState.month === 11 ? 0 : viewState.month + 1
      const newYear = viewState.month === 11 ? viewState.year + 1 : viewState.year
      setViewState({ type: 'month', year: newYear, month: newMonth })
    }
  }, [viewState])

  const handlePreviousYear = useCallback(() => {
    if (viewState.type === 'year') {
      setViewState({ type: 'year', year: viewState.year - 1 })
    }
  }, [viewState])

  const handleNextYear = useCallback(() => {
    if (viewState.type === 'year') {
      setViewState({ type: 'year', year: viewState.year + 1 })
    }
  }, [viewState])

  const handleNavigationPrevious = useCallback(() => {
    switch (viewState.type) {
      case 'day':
        handlePreviousDay()
        break
      case 'month':
        handlePreviousMonth()
        break
      case 'year':
        handlePreviousYear()
        break
    }
  }, [viewState.type, handlePreviousDay, handlePreviousMonth, handlePreviousYear])

  const handleNavigationNext = useCallback(() => {
    switch (viewState.type) {
      case 'day':
        handleNextDay()
        break
      case 'month':
        handleNextMonth()
        break
      case 'year':
        handleNextYear()
        break
    }
  }, [viewState.type, handleNextDay, handleNextMonth, handleNextYear])

  // Editor Handlers
  const handleMarkdownChange = useCallback(
    (markdown: string) => updateContent(markdown),
    [updateContent]
  )
  const handleContentChange = useCallback((_newBlocks: Block[]) => {}, [])
  const handleLinkClick = useCallback(
    (href: string) => window.open(href, '_blank', 'noopener,noreferrer'),
    []
  )

  const handleInternalLinkClick = useCallback(
    async (linkedNoteIdOrTitle: string) => {
      const target = linkedNoteIdOrTitle?.trim()
      if (!target) return
      try {
        const resolution = await resolveWikiLink(target)
        switch (resolution.type) {
          case 'file':
            openTab({
              type: 'file',
              title: resolution.title,
              icon: resolution.icon,
              path: `/file/${resolution.id}`,
              entityId: resolution.id,
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false
            })
            break
          case 'note':
            openTab({
              type: 'note',
              title: resolution.title,
              icon: 'file-text',
              path: `/notes/${resolution.id}`,
              entityId: resolution.id,
              isPinned: false,
              isModified: false,
              isPreview: true,
              isDeleted: false
            })
            break
          case 'create':
            toast.info(`Note "${target}" not found`)
            break
          case 'not-found':
            toast.error(`File not found: ${target}`)
            break
        }
      } catch (err) {
        log.error('Failed to resolve wiki link:', err)
        toast.error('Failed to open linked item')
      }
    },
    [openTab]
  )

  const handleHeadingClick = useCallback((headingId: string) => {
    const element = document.querySelector(`[data-id="${headingId}"]`)
    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const handleHeadingsChange = useCallback((newHeadings: HeadingInfo[]) => {
    setHeadings(
      newHeadings.map((h) => ({
        id: h.id,
        level: h.level,
        text: h.text,
        position: h.position
      }))
    )
  }, [])

  // Tag Handlers - use refs to avoid dependency on entry (which changes on every keystroke)
  const handleAddTag = useCallback(
    (tagId: string) => {
      const tagToAdd = availableTags.find((t) => t.id === tagId)
      const currentTags = entryTagsRef.current
      if (tagToAdd && !currentTags.includes(tagToAdd.name)) {
        updateTags([...currentTags, tagToAdd.name])
      }
    },
    [availableTags, updateTags]
  )

  const handleCreateTag = useCallback(
    (name: string, color: string) => {
      pendingTagColorsRef.current.set(name.toLowerCase(), color)
      const currentTags = entryTagsRef.current
      if (!currentTags.includes(name)) {
        updateTags([...currentTags, name])
      }
    },
    [updateTags]
  )

  const handleRemoveTag = useCallback(
    (tagId: string) => {
      const currentTags = entryTagsRef.current
      updateTags(currentTags.filter((t) => t !== tagId))
    },
    [updateTags]
  )

  // Backlinks transform
  const backlinks: Backlink[] = useMemo(() => {
    return rawBacklinks.map((bl) => {
      const folderPath = bl.sourcePath
        .split('/')
        .slice(0, -1)
        .join('/')
        .replace(/^notes\//, '')
      return {
        id: bl.sourceId,
        noteId: bl.sourceId,
        noteTitle: bl.sourceTitle,
        folder: folderPath,
        date: new Date(),
        mentions: (bl.contexts ?? []).map((ctx, i) => ({
          id: `mention-${bl.sourceId}-${i}`,
          snippet: ctx.snippet,
          linkStart: ctx.linkStart,
          linkEnd: ctx.linkEnd
        }))
      }
    })
  }, [rawBacklinks])

  const handleBacklinkClick = useCallback(
    (backlinkNoteId: string) => {
      const backlink = backlinks.find((bl) => bl.noteId === backlinkNoteId)
      const noteTitle = backlink?.noteTitle || 'Note'

      if (backlinkNoteId.startsWith('j')) {
        const dateStr = backlinkNoteId.slice(1)
        navigateToDay(dateStr)
      } else {
        openTab({
          type: 'note',
          title: noteTitle,
          icon: 'file-text',
          path: `/notes/${backlinkNoteId}`,
          entityId: backlinkNoteId,
          isPinned: false,
          isModified: false,
          isPreview: true,
          isDeleted: false
        })
      }
    },
    [openTab, backlinks, navigateToDay]
  )

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (viewState.type === 'month' || viewState.type === 'year') {
          e.preventDefault()
          navigateBack()
          return
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setIsFullWidth((prev) => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        setIsSidebarCollapsed((prev) => {
          const next = !prev
          localStorage.setItem('memry_journal_sidebar_collapsed', String(next))
          return next
        })
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [viewState, navigateBack])

  useEffect(() => {
    localStorage.setItem('memry_journal_full_width', isFullWidth.toString())
  }, [isFullWidth])

  const handleErrorRecover = useCallback(() => {
    lastLoadedDateRef.current = null
    setEditorLoadCount((c) => c + 1)
  }, [])

  return (
    <JournalErrorBoundary
      date={selectedDate}
      onRecover={handleErrorRecover}
      onError={(error, errorInfo) => {
        log.error('Error caught by boundary:', error, errorInfo)
      }}
    >
      <div className={cn('flex h-full w-full overflow-hidden bg-background', className)}>
        {/* Main Content Area */}
        <main className={cn('flex-1 min-w-0 h-full relative flex flex-col')}>
          <FindBar
            isOpen={findInPage.isOpen}
            query={findInPage.query}
            matchCount={findInPage.matchCount}
            currentIndex={findInPage.currentIndex}
            inputRef={findInPage.inputRef}
            onQueryChange={findInPage.setQuery}
            onNext={findInPage.next}
            onPrev={findInPage.prev}
            onClose={findInPage.close}
          />

          <div className="flex items-center justify-between h-9 py-2 pl-6 pr-3 shrink-0 text-xs/4 [font-synthesis:none]">
            <JournalBreadcrumb
              viewState={viewState}
              isToday={isToday}
              onPreviousDay={handlePreviousDay}
              onNextDay={handleNextDay}
              onMonthClick={navigateToMonth}
              onYearClick={navigateToYear}
              onTodayClick={handleTodayClick}
            />
            <JournalHeaderActions
              viewState={viewState}
              isBookmarked={isBookmarked}
              isFullWidth={isFullWidth}
              isSidebarCollapsed={isSidebarCollapsed}
              hasEntry={!!entry}
              journalDate={entry?.date ?? null}
              onPrevious={handleNavigationPrevious}
              onNext={handleNavigationNext}
              onToggleFullWidth={() => setIsFullWidth(!isFullWidth)}
              onToggleSidebar={() => {
                setIsSidebarCollapsed((prev) => {
                  const next = !prev
                  localStorage.setItem('memry_journal_sidebar_collapsed', String(next))
                  return next
                })
              }}
              onBookmarkToggle={toggleBookmark}
              onVersionHistory={() => setIsVersionHistoryOpen(true)}
              onExport={() => setIsExportDialogOpen(true)}
              onOpenSettings={() => openSettingsModal('journal')}
            />
          </div>

          <div ref={journalScrollRef} className="flex-1 overflow-y-auto">
            <div
              className="mx-auto w-full px-8 lg:px-12 min-h-full pt-6 pb-10 lg:pb-16 transition-[max-width] duration-300 ease-in-out"
              style={{ maxWidth: isFullWidth ? '100%' : '64rem' }}
            >
              <div
                className="flex flex-col mx-auto w-full transition-[max-width] duration-300 ease-in-out"
                style={{ maxWidth: journalContentWidth ?? '100%' }}
              >
                {entryError && (
                  <div className="mb-4 px-4 py-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                    <span className="font-medium">Error:</span> {entryError}
                  </div>
                )}

                {viewState.type === 'day' && (
                  <>
                    <div className="flex flex-col gap-3 mb-4">
                      <TagsRow
                        tags={journalTags}
                        availableTags={availableTags}
                        recentTags={recentTags}
                        onAddTag={handleAddTag}
                        onCreateTag={handleCreateTag}
                        onRemoveTag={handleRemoveTag}
                        className="mb-0"
                      />
                      {properties.length > 0 && (
                        <InfoSection
                          properties={properties}
                          isExpanded
                          variant="inline"
                          onToggleExpand={() => {}}
                          onPropertyChange={handlePropertyChange}
                          onPropertyNameChange={handlePropertyNameChange}
                          onPropertyOrderChange={handlePropertyOrderChange}
                          onAddProperty={handleAddProperty}
                          onDeleteProperty={handleDeleteProperty}
                          hideAddButton
                        />
                      )}
                    </div>

                    <div className="h-px w-full bg-border/40 mb-5" />

                    <div
                      ref={editorContainerRef}
                      role="presentation"
                      className="editor-click-area min-h-[300px] relative overflow-visible"
                      style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}
                      onMouseDown={(e) => {
                        const target = e.target as HTMLElement
                        if (
                          target.closest('[contenteditable="true"]')?.contains(target) &&
                          target.closest('.bn-block-content')
                        )
                          return
                        if (target.closest('button, a, input')) return
                        const editor = (e.currentTarget as HTMLElement).querySelector(
                          '.bn-editor [contenteditable="true"]'
                        ) as HTMLElement
                        if (editor) {
                          e.preventDefault()
                          editor.focus()
                        }
                      }}
                    >
                      {showEditorLoading ? (
                        <div className="flex items-center justify-center h-[300px]">
                          <Loader2 className="size-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : (
                        <ContentArea
                          key={editorState.key}
                          noteId={entry?.id}
                          initialContent={editorState.content}
                          contentType="markdown"
                          placeholder={
                            selectedDate > today
                              ? 'What are you planning...'
                              : isToday
                                ? "What's on your mind today..."
                                : 'Reflect on this day...'
                          }
                          stickyToolbar={editorSettings.toolbarMode === 'sticky'}
                          onContentChange={handleContentChange}
                          onMarkdownChange={handleMarkdownChange}
                          onHeadingsChange={handleHeadingsChange}
                          onLinkClick={handleLinkClick}
                          onInternalLinkClick={handleInternalLinkClick}
                        />
                      )}
                    </div>

                    {entry && backlinks.length > 0 && (
                      <div className="mt-6">
                        <BacklinksSection
                          backlinks={backlinks}
                          isLoading={backlinksLoading}
                          initialCount={5}
                          onBacklinkClick={handleBacklinkClick}
                        />
                      </div>
                    )}
                  </>
                )}

                {viewState.type === 'month' && (
                  <>
                    <JournalDateDisplay viewState={viewState} dateParts={null} className="mb-6" />
                    <JournalMonthView
                      year={viewState.year}
                      month={viewState.month}
                      entries={monthEntries}
                      heatmapData={heatmapData}
                      onDayClick={navigateToDay}
                      className="flex-1"
                    />
                  </>
                )}

                {viewState.type === 'year' && (
                  <>
                    <JournalDateDisplay viewState={viewState} dateParts={null} className="mb-6" />
                    <JournalYearView
                      year={viewState.year}
                      monthStats={monthStats}
                      onMonthClick={(month) => navigateToMonth(viewState.year, month)}
                      className="flex-1"
                    />
                  </>
                )}
              </div>
            </div>

            {/* Stats Footer - sticky at bottom of scroll area */}
            {!isJournalSettingsLoading &&
              journalSettings.showStatsFooter &&
              viewState.type === 'day' &&
              documentStats && (
                <JournalStatsFooter
                  wordCount={documentStats.wordCount}
                  characterCount={documentStats.characterCount}
                  createdAt={documentStats.createdAt}
                  modifiedAt={documentStats.modifiedAt}
                />
              )}
          </div>

          {viewState.type === 'day' && (
            <OutlineInfoPanel
              headings={headings}
              onHeadingClick={handleHeadingClick}
              activeHeadingId={activeHeadingId ?? undefined}
              stats={documentStats}
            />
          )}
        </main>

        {/* Right Sidebar — Calendar with resize handle */}
        {viewState.type === 'day' && (
          <div
            className="relative shrink-0 h-full hidden lg:flex transition-[width] duration-200 ease-out overflow-hidden"
            style={{ width: isSidebarCollapsed ? 0 : sidebarWidth }}
          >
            {/* Resize handle */}
            {!isSidebarCollapsed && (
              <div
                className="absolute left-0 top-0 bottom-0 w-1 z-10 cursor-col-resize group"
                onPointerDown={handleResizeStart}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
              >
                <div className="absolute inset-y-0 -left-1 -right-1" />
                <div className="absolute inset-y-0 left-0 w-px bg-border/30 group-hover:bg-tint transition-colors" />
              </div>
            )}
            <aside
              className="h-full overflow-y-auto border-l border-border/30 bg-sidebar"
              style={{ width: sidebarWidth, minWidth: sidebarWidth }}
            >
              <div className="flex items-center justify-end h-9 px-2 shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 hover:bg-surface-active"
                      onClick={() => {
                        setIsSidebarCollapsed((prev) => {
                          const next = !prev
                          localStorage.setItem('memry_journal_sidebar_collapsed', String(next))
                          return next
                        })
                      }}
                    >
                      <PanelRight className="h-3.5 w-3.5 text-foreground" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="flex items-center gap-2 text-xs">
                    Hide sidebar
                    <Kbd>⌘.</Kbd>
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="px-4 pb-4 w-full">
                <DatePickerCalendar
                  selected={selectedDateObj}
                  onSelect={(date) => {
                    if (date) navigateToDay(formatDateToISO(date))
                  }}
                  activityData={calendarActivityData}
                  className="w-full"
                  showWeekNumbers
                  onTodayClick={handleTodayClick}
                />
              </div>
              <div className="h-px mx-4 bg-border/30" />
              <div className="p-4 w-full">
                <JournalDayPanel date={selectedDate} />
              </div>
            </aside>
          </div>
        )}

        {/* Dialogs */}
        {entry && (
          <ExportDialog
            open={isExportDialogOpen}
            onOpenChange={setIsExportDialogOpen}
            noteId={entry.id}
            noteTitle={`Journal - ${formatDateParts(selectedDate).month} ${formatDateParts(selectedDate).day}, ${formatDateParts(selectedDate).year}`}
          />
        )}
        {entry && (
          <VersionHistory
            open={isVersionHistoryOpen}
            onOpenChange={setIsVersionHistoryOpen}
            noteId={entry.id}
            noteTitle={`Journal - ${formatDateParts(selectedDate).month} ${formatDateParts(selectedDate).day}, ${formatDateParts(selectedDate).year}`}
            onRestore={async () => {
              await forceReload()
              lastLoadedDateRef.current = null
              setEditorLoadCount((c) => c + 1)
            }}
          />
        )}
      </div>
    </JournalErrorBoundary>
  )
}

export default JournalPage
