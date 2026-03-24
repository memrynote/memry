/**
 * Journal Page - Contemplative Editorial Design
 * A refined, warm aesthetic that makes journaling feel premium
 * Left: Large journal writing area with dramatic date display
 * Right: Mini calendar + Schedule + Tasks + AI Connections
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, FileText } from '@/lib/icons'
import {
  AIConnectionsPanel,
  DayContextSidebar,
  JournalMonthView,
  JournalYearView,
  DefaultTemplateIndicator,
  JournalErrorBoundary,
  JournalNavigationRow,
  JournalDateDisplay,
  JournalStatsFooter,
  type ScheduleEvent,
  type JournalViewState
} from '@/components/journal'
import { ContentArea, type Block, type HeadingInfo } from '@/components/note'

import { TemplateSelector } from '@/components/note/template-selector'
import { TagsRow, type Tag } from '@/components/note/tags-row'
import { InfoSection } from '@/components/note/info-section'
import { OutlineInfoPanel, type HeadingItem } from '@/components/shared'
import { useActiveHeading } from '@/hooks/use-active-heading'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { usePropertySection } from '@/hooks/use-property-section'
import { useTemplates } from '@/hooks/use-templates'
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
  useYearStats,
  useDayContext,
  useAIConnections,
  type AIConnection
} from '@/hooks/use-journal'
import { tasksService } from '@/services/tasks-service'
import { parseConnectionDate } from '@/services/ai-connections-service'
import { journalService } from '@/services/journal-service'
import { useIsBookmarked } from '@/hooks/use-bookmarks'
import { createLogger } from '@/lib/logger'
import { FindBar } from '@/components/find-bar/find-bar'
import { useFindInPage } from '@/hooks/use-find-in-page'

const log = createLogger('Page:Journal')

// =============================================================================
// CONSTANTS
// =============================================================================

const EMPTY_EVENTS: ScheduleEvent[] = []

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

  // Layout state: Full Mode (default) or Compact Mode
  const [isCompactMode, setIsCompactMode] = useState(() => {
    const saved = localStorage.getItem('memry_journal_compact_mode')
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

  // Day context hook
  const { tasks: dayTasks, overdueCount } = useDayContext(selectedDate)

  // Tags hook
  const { tags: allAvailableTags } = useNoteTagsQuery()

  // State for InfoSection expansion (collapsed by default)
  const [isInfoExpanded, setIsInfoExpanded] = useState(false)

  // Template selector state
  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const { templates, getTemplate } = useTemplates({ autoLoad: true })

  // Journal settings
  const {
    settings: journalSettings,
    isLoading: isJournalSettingsLoading,
    setDefaultTemplate: setJournalDefaultTemplate
  } = useJournalSettings()

  // Editor settings
  const { settings: editorSettings } = useEditorSettings()

  // Bookmark state - use entry.id (e.g., "j2026-01-13") to match notes_cache lookup
  const { isBookmarked, toggle: toggleBookmark } = useIsBookmarked('journal', entry?.id ?? '')

  // Track auto-applying default template
  const [isApplyingDefaultTemplate, setIsApplyingDefaultTemplate] = useState(false)
  const hasAppliedDefaultForDateRef = useRef<string | null>(null)

  // Ref to track current entry tags for stable callbacks (prevents re-renders on content changes)
  const entryTagsRef = useRef<string[]>([])
  entryTagsRef.current = entry?.tags ?? []

  // Get default template info
  const defaultTemplateInfo = useMemo(() => {
    if (!journalSettings.defaultTemplate) return null
    const template = templates.find((t) => t.id === journalSettings.defaultTemplate)
    if (!template) return null
    return {
      id: template.id,
      name: template.name,
      icon: template.icon
    }
  }, [journalSettings.defaultTemplate, templates])

  // AI connections hook
  const {
    connections: aiConnections,
    isLoading: isAILoading,
    error: aiError,
    refresh: refreshAIConnections
  } = useAIConnections(entry?.content ?? '')

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

  const { activeHeadingId } = useActiveHeading({
    headings,
    offset: 120
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

  // Template Handlers
  const handleTemplateSelect = useCallback(
    async (templateId: string | null) => {
      setShowTemplateSelector(false)
      if (!templateId || templateId === 'blank') {
        try {
          await journalService.createEntry({ date: selectedDate, content: '' })
          lastLoadedDateRef.current = null
          setEditorLoadCount((c) => c + 1)
        } catch (err) {
          log.error('Failed to create blank entry:', err)
        }
        return
      }
      const template = await getTemplate(templateId)
      if (!template) return
      const parts = formatDateParts(selectedDate)
      const dateTitle = `${parts.month} ${parts.day}, ${parts.year}`
      const content = template.content.replace(/\{\{title\}\}/g, dateTitle)
      const properties: Record<string, unknown> = {}
      if (template.properties) {
        for (const prop of template.properties) properties[prop.name] = prop.value
      }
      try {
        await journalService.createEntry({
          date: selectedDate,
          content,
          tags: template.tags ?? [],
          properties
        })
        lastLoadedDateRef.current = null
        setEditorLoadCount((c) => c + 1)
      } catch (err) {
        log.error('Failed to apply template:', err)
      }
    },
    [selectedDate, getTemplate]
  )

  const handleApplyDefaultTemplate = useCallback(async () => {
    if (!defaultTemplateInfo?.id) return
    if (hasAppliedDefaultForDateRef.current === selectedDate) return
    setIsApplyingDefaultTemplate(true)
    hasAppliedDefaultForDateRef.current = selectedDate
    try {
      const template = await getTemplate(defaultTemplateInfo.id)
      if (!template) {
        setIsApplyingDefaultTemplate(false)
        return
      }
      const parts = formatDateParts(selectedDate)
      const dateTitle = `${parts.month} ${parts.day}, ${parts.year}`
      const content = template.content.replace(/\{\{title\}\}/g, dateTitle)
      const properties: Record<string, unknown> = {}
      if (template.properties) {
        for (const prop of template.properties) properties[prop.name] = prop.value
      }
      await journalService.createEntry({
        date: selectedDate,
        content,
        tags: template.tags ?? [],
        properties
      })
      lastLoadedDateRef.current = null
      setEditorLoadCount((c) => c + 1)
    } catch (err) {
      log.error('Failed to apply default template:', err)
    } finally {
      setIsApplyingDefaultTemplate(false)
    }
  }, [selectedDate, defaultTemplateInfo?.id, getTemplate])

  const handleStartBlank = useCallback(async () => {
    hasAppliedDefaultForDateRef.current = selectedDate
    try {
      await journalService.createEntry({ date: selectedDate, content: '' })
      lastLoadedDateRef.current = null
      setEditorLoadCount((c) => c + 1)
    } catch (err) {
      log.error('Failed to create blank entry:', err)
    }
  }, [selectedDate])

  useEffect(() => {
    if (
      !isEntryLoading &&
      loadedForDate === selectedDate &&
      !entry &&
      defaultTemplateInfo?.id &&
      hasAppliedDefaultForDateRef.current !== selectedDate
    ) {
      handleApplyDefaultTemplate()
    }
  }, [
    isEntryLoading,
    loadedForDate,
    selectedDate,
    entry,
    defaultTemplateInfo?.id,
    handleApplyDefaultTemplate
  ])

  const handleTaskToggle = useCallback(
    async (taskId: string) => {
      const task = dayTasks.find((t) => t.id === taskId)
      if (!task) return
      try {
        if (task.completed) await tasksService.uncomplete(taskId)
        else await tasksService.complete({ id: taskId })
      } catch (error) {
        log.error('Failed to toggle task completion:', error)
      }
    },
    [dayTasks]
  )

  const handleConnectionClick = useCallback(
    (connection: AIConnection) => {
      if (connection.type === 'journal' && connection.date) {
        const isoDate = parseConnectionDate(connection.date)
        if (isoDate) navigateToDay(isoDate)
      } else if (connection.type === 'note' && connection.title) {
        log.info('Navigate to note:', connection.title)
      }
    },
    [navigateToDay]
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
        if (isCompactMode) setIsCompactMode(false)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setIsCompactMode((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isCompactMode, viewState, navigateBack])

  useEffect(() => {
    localStorage.setItem('memry_journal_compact_mode', isCompactMode.toString())
  }, [isCompactMode])

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
        <main className={cn('flex-1 min-w-0 h-full relative transition-all duration-500 ease-out')}>
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
          <div className={cn('h-full overflow-y-auto')}>
            <div className={cn('mx-auto min-h-full flex flex-col pt-0 pb-10 lg:pb-16')}>
              {/* Header */}
              <header className="relative mb-8 lg:mb-6 w-full">
                <JournalDateDisplay
                  viewState={viewState}
                  dateParts={dateParts}
                  isToday={isToday}
                  isCompact={isCompactMode}
                  variant={isCompactMode ? 'compact' : 'flush'}
                >
                  <JournalNavigationRow
                    viewState={viewState}
                    isToday={isToday}
                    isCompact={isCompactMode}
                    isBookmarked={isBookmarked}
                    hasEntry={!!entry}
                    journalDate={entry?.date ?? null}
                    onPrevious={handleNavigationPrevious}
                    onNext={handleNavigationNext}
                    onToday={handleTodayClick}
                    onFocusToggle={() => setIsCompactMode(!isCompactMode)}
                    onBookmarkToggle={toggleBookmark}
                    onVersionHistory={() => setIsVersionHistoryOpen(true)}
                    onExport={() => setIsExportDialogOpen(true)}
                  />
                </JournalDateDisplay>
              </header>

              {/* Editor/Content Area with Sliding Animation */}
              <div className="flex-1 flex w-full overflow-hidden min-w-0">
                {/* Left Spacer */}
                <div
                  className="transition-all duration-500 ease-in-out"
                  style={{ flexGrow: isCompactMode ? 1 : 0 }}
                />

                <div
                  className={cn(
                    'flex flex-col transition-all duration-500 ease-in-out min-w-0 px-8 lg:px-12'
                  )}
                  style={{
                    width: isCompactMode ? 'min(100%, 48rem)' : '100%',
                    maxWidth: '100%'
                  }}
                >
                  {entryError && (
                    <div className="mb-4 px-4 py-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                      <span className="font-medium">Error:</span> {entryError}
                    </div>
                  )}

                  {viewState.type === 'day' && (
                    <>
                      {!isEntryLoading && !entry && (
                        <div className="mb-6">
                          {defaultTemplateInfo ? (
                            <DefaultTemplateIndicator
                              templateName={defaultTemplateInfo.name}
                              templateIcon={defaultTemplateInfo.icon}
                              isCreating={isApplyingDefaultTemplate}
                              onChangeTemplate={() => setShowTemplateSelector(true)}
                              onStartBlank={handleStartBlank}
                            />
                          ) : (
                            <button
                              onClick={() => setShowTemplateSelector(true)}
                              className={cn(
                                'w-full flex items-center gap-3 px-4 py-3 rounded-md',
                                'border border-dashed border-amber-300/50 dark:border-amber-700/50',
                                'bg-gradient-to-r from-amber-50/50 to-orange-50/30 dark:from-amber-950/20 dark:to-orange-950/10',
                                'hover:border-amber-400/60 dark:hover:border-amber-600/60 transition-all duration-200 text-left group'
                              )}
                            >
                              <div className="w-9 h-9 rounded-md bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center border border-amber-200/50 dark:border-amber-800/30 shadow-sm">
                                <FileText className="w-4 h-4 text-amber-700 dark:text-amber-400" />
                              </div>
                              <div className="flex-1">
                                <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
                                  Start with a template
                                </span>
                                <p className="text-xs text-amber-600/70 dark:text-amber-400/60 mt-0.5">
                                  Morning pages, daily reflection, gratitude journal, and more
                                </p>
                              </div>
                              <span className="text-xs text-amber-500/60 dark:text-amber-400/50 group-hover:text-amber-600 dark:group-hover:text-amber-300 transition-colors">
                                Choose template
                              </span>
                            </button>
                          )}
                        </div>
                      )}

                      {entry && (
                        <div
                          className={cn(
                            'mb-8 transition-all duration-500 ease-in-out',
                            isCompactMode ? 'pl-0' : 'pl-6 lg:pl-8'
                          )}
                        >
                          <div className="flex flex-col gap-3">
                            {/* Tags Row */}
                            <TagsRow
                              tags={journalTags}
                              availableTags={availableTags}
                              recentTags={recentTags}
                              onAddTag={handleAddTag}
                              onCreateTag={handleCreateTag}
                              onRemoveTag={handleRemoveTag}
                              className="mb-0"
                            />

                            {/* Divider - subtle */}
                            <div className="h-px w-full bg-border/40" />

                            {/* Properties Section */}
                            <InfoSection
                              properties={properties}
                              isExpanded={isInfoExpanded}
                              variant="embedded"
                              onToggleExpand={() => setIsInfoExpanded(!isInfoExpanded)}
                              onPropertyChange={handlePropertyChange}
                              onPropertyNameChange={handlePropertyNameChange}
                              onPropertyOrderChange={handlePropertyOrderChange}
                              onAddProperty={handleAddProperty}
                              onDeleteProperty={handleDeleteProperty}
                            />
                          </div>
                        </div>
                      )}

                      <div
                        ref={editorContainerRef}
                        role="presentation"
                        className={cn(
                          'editor-click-area min-h-[300px] relative transition-all duration-500 ease-in-out overflow-visible',
                          isCompactMode ? 'pl-0' : 'note-margin-line pl-6 lg:pl-8'
                        )}
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
                    </>
                  )}

                  {viewState.type === 'month' && (
                    <JournalMonthView
                      year={viewState.year}
                      month={viewState.month}
                      entries={monthEntries}
                      heatmapData={heatmapData}
                      onDayClick={navigateToDay}
                      className="flex-1"
                    />
                  )}

                  {viewState.type === 'year' && (
                    <JournalYearView
                      year={viewState.year}
                      monthStats={monthStats}
                      onMonthClick={(month) => navigateToMonth(viewState.year, month)}
                      className="flex-1"
                    />
                  )}
                </div>

                {/* Right Spacer */}
                <div className="flex-grow transition-all duration-500 ease-in-out" />
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

          {viewState.type === 'day' && !isCompactMode && (
            <OutlineInfoPanel
              headings={headings}
              onHeadingClick={handleHeadingClick}
              activeHeadingId={activeHeadingId ?? undefined}
              stats={documentStats}
            />
          )}
        </main>

        {/* Right Sidebar */}
        <aside
          className={cn(
            'shrink-0 h-full overflow-hidden border-l border-border/30 journal-sidebar-gradient hidden lg:block transition-[width,opacity] duration-500 ease-out',
            viewState.type !== 'day'
              ? 'w-0 opacity-0 border-l-0'
              : 'w-[320px] xl:w-[360px] opacity-100'
          )}
        >
          <div
            className={cn(
              'h-full overflow-y-auto scrollbar-thin p-5 xl:p-6 flex flex-col gap-6 w-[320px] xl:w-[360px] transition-opacity duration-500 ease-out',
              viewState.type !== 'day' ? 'opacity-0' : 'opacity-100'
            )}
          >
            <div
              className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-amber-500/[0.04] to-transparent dark:from-amber-400/[0.03] rounded-bl-[60px] pointer-events-none"
              aria-hidden="true"
            />
            {!isJournalSettingsLoading &&
              (journalSettings.showSchedule || journalSettings.showTasks) && (
                <section className="relative">
                  <DayContextSidebar
                    events={EMPTY_EVENTS}
                    tasks={dayTasks}
                    overdueCount={overdueCount}
                    isToday={isToday}
                    isPast={selectedDate < today}
                    showSchedule={journalSettings.showSchedule}
                    showTasks={journalSettings.showTasks}
                    onTaskClick={(id) => log.info('Task clicked:', id)}
                    onTaskToggle={handleTaskToggle}
                    onEventClick={(id) => log.info('Event clicked:', id)}
                  />
                </section>
              )}
            {!isJournalSettingsLoading && journalSettings.showAIConnections && (
              <section className="relative">
                <AIConnectionsPanel
                  connections={aiConnections}
                  isLoading={isAILoading}
                  error={aiError}
                  isNewUser={!entry && aiConnections.length === 0}
                  onConnectionClick={handleConnectionClick}
                  onRefresh={refreshAIConnections}
                  maxItems={3}
                />
              </section>
            )}
          </div>
        </aside>

        {/* Dialogs */}
        <TemplateSelector
          isOpen={showTemplateSelector}
          onClose={() => setShowTemplateSelector(false)}
          onSelect={handleTemplateSelect}
          isJournalContext
          journalDefaultTemplateId={journalSettings.defaultTemplate}
          onSetJournalDefault={setJournalDefaultTemplate}
        />
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
