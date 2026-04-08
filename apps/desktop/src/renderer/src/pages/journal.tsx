/**
 * Journal Page - Contemplative Editorial Design
 * A refined, warm aesthetic that makes journaling feel premium
 * Full-width journal writing area with breadcrumb navigation
 * Day context (calendar + tasks) available via global Day Panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { Loader2 } from '@/lib/icons'
import {
  JournalMonthView,
  JournalYearView,
  JournalErrorBoundary,
  JournalBreadcrumb,
  JournalHeaderActions,
  JournalDateDisplay,
  JournalStatsFooter,
  type JournalViewState
} from '@/components/journal'
import { ContentArea, type Block, type HeadingInfo } from '@/components/note'
import { BacklinksSection, type Backlink } from '@/components/note/backlinks'

import { TagsRow, type Tag } from '@/components/note/tags-row'
import { InfoSection } from '@/components/note/info-section'
import { GhostAffordanceRow } from '@/components/note/ghost-affordance-row'
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
  const tabDate = activeTab?.viewState?.date as string | undefined

  // Get initial date from tab viewState or default to today
  const initialDate = tabDate || today
  const [selectedDateState, setSelectedDateState] = useState(initialDate)
  const [viewState, setViewState] = useState<JournalViewState>({ type: 'day', date: initialDate })
  const selectedDate = tabDate || selectedDateState
  const currentViewState = useMemo<JournalViewState>(() => {
    if (tabDate && viewState.type === 'day' && viewState.date !== tabDate) {
      return { type: 'day', date: tabDate }
    }

    return viewState
  }, [tabDate, viewState])

  const [isFullWidth, setIsFullWidth] = useState(() => {
    const saved = localStorage.getItem('memry_journal_full_width')
    return saved === 'true'
  })

  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false)

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
    if (!saveError) return

    const toastId = toast.error(saveError, {
      description: 'Your content is still in memory. Click to retry saving.',
      action: {
        label: 'Retry',
        onClick: () => {
          void retrySave()
        }
      },
      duration: Infinity,
      onDismiss: dismissSaveError
    })

    return () => {
      toast.dismiss(toastId)
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

  const [editorRevision, setEditorRevision] = useState(0)

  const editorLoadState = loadedForDate === selectedDate ? 'loaded' : 'pending'
  const editorState = useMemo(
    () => ({
      key: `${selectedDate}-${editorLoadState}-${externalUpdateCount}-${editorRevision}`,
      content: editorLoadState === 'loaded' ? entry?.content ?? '' : ''
    }),
    [selectedDate, editorLoadState, externalUpdateCount, editorRevision, entry?.content]
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

  const focusAtEndRef = useRef<(() => void) | null>(null)

  // Find in page (Cmd+F)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const isActiveJournal = activeTab?.type === 'journal'
  const findInPage = useFindInPage(
    editorContainerRef as RefObject<HTMLElement | null>,
    isActiveJournal && currentViewState.type === 'day'
  )

  // Date parts and heatmap
  const isToday = selectedDate === today
  const selectedDateObj = parseISODate(selectedDate)
  const dateParts = useMemo(() => formatDateParts(selectedDate), [selectedDate])

  const currentYear = dateParts.year
  const { data: heatmapData } = useJournalHeatmap(currentYear)

  const viewMonth = currentViewState.type === 'month' ? currentViewState.month : dateParts.monthIndex
  const viewYear =
    currentViewState.type === 'month' || currentViewState.type === 'year'
      ? currentViewState.year
      : dateParts.year

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

    const year = currentViewState.type === 'year' ? currentViewState.year : dateParts.year
    return getMonthStats(year, heatmapData)
  }, [yearStatsData, currentViewState, dateParts.year, heatmapData])

  const journalScrollRef = useRef<HTMLDivElement>(null)
  const [marqueeZoneEl, setMarqueeZoneEl] = useState<HTMLDivElement | null>(null)

  // Click anywhere in the marquee zone (full scroll area, minus metadata
  // and editable text) → focus editor at end. Attached imperatively so it
  // coexists with the marquee hook's own mousedown listener.
  useEffect(() => {
    if (!marqueeZoneEl) return
    const handler = (event: MouseEvent): void => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-marquee-ignore]')) return
      if (target.closest('button, a, input, textarea, select, [role="button"]')) return
      if (
        target.closest('[contenteditable="true"]')?.contains(target) &&
        target.closest('.bn-block-content')
      )
        return
      event.preventDefault()
      focusAtEndRef.current?.()
    }
    marqueeZoneEl.addEventListener('mousedown', handler)
    return () => marqueeZoneEl.removeEventListener('mousedown', handler)
  }, [marqueeZoneEl])

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
    properties: rawProperties,
    newlyAddedPropertyId,
    handlePropertyChange,
    handleAddProperty,
    handleDeleteProperty,
    handlePropertyNameChange,
    handlePropertyOrderChange
  } = usePropertySection({ entityId: entry?.id ?? null, includeExplicitType: true })

  const properties = useMemo(() => rawProperties.filter((p) => p.name !== 'date'), [rawProperties])

  // Navigation
  const navigateToMonth = useCallback((year: number, month: number) => {
    setViewState({ type: 'month', year, month })
  }, [])

  const navigateToYear = useCallback((year: number) => {
    setViewState({ type: 'year', year })
  }, [])

  const navigateToDay = useCallback(
    (date: string) => {
      setSelectedDateState(date)
      setViewState({ type: 'day', date })
      openTab({
        type: 'journal',
        title: 'Journal',
        icon: 'book-open',
        path: '/journal',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { date }
      })
    },
    [openTab]
  )

  const navigateBack = useCallback(() => {
    if (currentViewState.type === 'month') {
      navigateToYear(currentViewState.year)
    } else if (currentViewState.type === 'year') {
      navigateToDay(selectedDate)
    }
  }, [currentViewState, selectedDate, navigateToYear, navigateToDay])

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
    if (currentViewState.type === 'month') {
      const newMonth = currentViewState.month === 0 ? 11 : currentViewState.month - 1
      const newYear =
        currentViewState.month === 0 ? currentViewState.year - 1 : currentViewState.year
      setViewState({ type: 'month', year: newYear, month: newMonth })
    }
  }, [currentViewState])

  const handleNextMonth = useCallback(() => {
    if (currentViewState.type === 'month') {
      const newMonth = currentViewState.month === 11 ? 0 : currentViewState.month + 1
      const newYear =
        currentViewState.month === 11 ? currentViewState.year + 1 : currentViewState.year
      setViewState({ type: 'month', year: newYear, month: newMonth })
    }
  }, [currentViewState])

  const handlePreviousYear = useCallback(() => {
    if (currentViewState.type === 'year') {
      setViewState({ type: 'year', year: currentViewState.year - 1 })
    }
  }, [currentViewState])

  const handleNextYear = useCallback(() => {
    if (currentViewState.type === 'year') {
      setViewState({ type: 'year', year: currentViewState.year + 1 })
    }
  }, [currentViewState])

  const handleNavigationPrevious = useCallback(() => {
    switch (currentViewState.type) {
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
  }, [currentViewState.type, handlePreviousDay, handlePreviousMonth, handlePreviousYear])

  const handleNavigationNext = useCallback(() => {
    switch (currentViewState.type) {
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
  }, [currentViewState.type, handleNextDay, handleNextMonth, handleNextYear])

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
        if (currentViewState.type === 'month' || currentViewState.type === 'year') {
          e.preventDefault()
          navigateBack()
          return
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setIsFullWidth((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [currentViewState, navigateBack])

  useEffect(() => {
    localStorage.setItem('memry_journal_full_width', isFullWidth.toString())
  }, [isFullWidth])

  const handleErrorRecover = useCallback(() => {
    setEditorRevision((count) => count + 1)
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
              viewState={currentViewState}
              isToday={isToday}
              onPreviousDay={handlePreviousDay}
              onNextDay={handleNextDay}
              onMonthClick={navigateToMonth}
              onYearClick={navigateToYear}
              onTodayClick={handleTodayClick}
            />
            <JournalHeaderActions
              viewState={currentViewState}
              isBookmarked={isBookmarked}
              isFullWidth={isFullWidth}
              hasEntry={!!entry}
              journalDate={entry?.date ?? null}
              onPrevious={handleNavigationPrevious}
              onNext={handleNavigationNext}
              onToggleFullWidth={() => setIsFullWidth(!isFullWidth)}
              onBookmarkToggle={toggleBookmark}
              onVersionHistory={() => setIsVersionHistoryOpen(true)}
              onExport={() => setIsExportDialogOpen(true)}
              onOpenSettings={() => openSettingsModal('journal')}
            />
          </div>

          <div ref={journalScrollRef} className="flex-1 overflow-y-auto overflow-x-visible">
            <div
              ref={setMarqueeZoneEl}
              className="marquee-zone relative min-h-full w-full flex flex-col"
            >
              <div
                className="mx-auto w-full px-8 lg:px-12 min-h-full flex flex-col pt-6 pb-10 lg:pb-16 transition-[max-width] duration-300 ease-in-out"
                style={{ maxWidth: isFullWidth ? '100%' : '64rem' }}
              >
                <div
                  className="flex flex-col flex-1 mx-auto w-full transition-[max-width] duration-300 ease-in-out"
                  style={{ maxWidth: journalContentWidth ?? '100%' }}
                >
                  {entryError && (
                    <div className="mb-4 px-4 py-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                      <span className="font-medium">Error:</span> {entryError}
                    </div>
                  )}

                  {currentViewState.type === 'day' && (
                    <>
                      <div className="group/metadata flex flex-col pb-[15px]" data-marquee-ignore>
                        <JournalDateDisplay viewState={currentViewState} dateParts={dateParts} />
                        <TagsRow
                          tags={journalTags}
                          availableTags={availableTags}
                          recentTags={recentTags}
                          onAddTag={handleAddTag}
                          onCreateTag={handleCreateTag}
                          onRemoveTag={handleRemoveTag}
                          className="mb-0"
                          hideWhenEmpty
                        />
                        {properties.length > 0 && (
                          <InfoSection
                            properties={properties}
                            newlyAddedPropertyId={newlyAddedPropertyId}
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
                        <GhostAffordanceRow
                          availableTags={availableTags}
                          recentTags={recentTags}
                          currentTagIds={journalTags.map((t) => t.id)}
                          onAddTag={handleAddTag}
                          onCreateTag={handleCreateTag}
                          onAddProperty={handleAddProperty}
                          hasTags={journalTags.length > 0}
                        />
                      </div>

                      <div
                        ref={editorContainerRef}
                        role="presentation"
                        className="editor-click-area flex-1 pb-[30vh] relative overflow-visible"
                        style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}
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
                            focusAtEndRef={focusAtEndRef}
                            marqueeZoneEl={marqueeZoneEl}
                          />
                        )}
                      </div>

                      {entry && backlinks.length > 0 && (
                        <div className="mt-6" data-marquee-ignore>
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

                  {currentViewState.type === 'month' && (
                    <div className="flex flex-col flex-1" data-marquee-ignore>
                      <JournalDateDisplay
                        viewState={currentViewState}
                        dateParts={null}
                        className="mb-6"
                      />
                      <JournalMonthView
                        year={currentViewState.year}
                        month={currentViewState.month}
                        entries={monthEntries}
                        heatmapData={heatmapData}
                        onDayClick={navigateToDay}
                        className="flex-1"
                      />
                    </div>
                  )}

                  {currentViewState.type === 'year' && (
                    <div className="flex flex-col flex-1" data-marquee-ignore>
                      <JournalDateDisplay
                        viewState={currentViewState}
                        dateParts={null}
                        className="mb-6"
                      />
                      <JournalYearView
                        year={currentViewState.year}
                        monthStats={monthStats}
                        onMonthClick={(month) => navigateToMonth(currentViewState.year, month)}
                        className="flex-1"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Stats Footer - sticky at bottom of scroll area */}
            {!isJournalSettingsLoading &&
              journalSettings.showStatsFooter &&
              currentViewState.type === 'day' &&
              documentStats && (
                <JournalStatsFooter
                  wordCount={documentStats.wordCount}
                  characterCount={documentStats.characterCount}
                  createdAt={documentStats.createdAt}
                  modifiedAt={documentStats.modifiedAt}
                />
              )}
          </div>

          {currentViewState.type === 'day' && (
            <OutlineInfoPanel
              headings={headings}
              onHeadingClick={handleHeadingClick}
              activeHeadingId={activeHeadingId ?? undefined}
              stats={documentStats}
            />
          )}
        </main>

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
            onRestore={() => {
              void (async () => {
                await forceReload()
                setEditorRevision((count) => count + 1)
              })()
            }}
          />
        )}
      </div>
    </JournalErrorBoundary>
  )
}

export default JournalPage
