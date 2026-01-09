/**
 * Journal Page - Contemplative Editorial Design
 * A refined, warm aesthetic that makes journaling feel premium
 * Left: Large journal writing area with dramatic date display
 * Right: Mini calendar + Schedule + Tasks + AI Connections
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Sun,
  Sunrise,
  Sunset,
  Moon,
  Maximize2,
  Minimize2,
  Loader2,
  FileText,
  MoreHorizontal,
  History,
  Bookmark
} from 'lucide-react'
import { useSidebar } from '@/components/ui/sidebar'
import {
  JournalCalendar,
  AIConnectionsPanel,
  DayContextSidebar,
  DateBreadcrumb,
  JournalMonthView,
  JournalYearView,
  DefaultTemplateIndicator,
  JournalErrorBoundary,
  type ScheduleEvent,
  type JournalViewState
} from '@/components/journal'
import { ContentArea, type Block, type HeadingInfo } from '@/components/note'

import { TemplateSelector } from '@/components/note/template-selector'
import { TagsRow, type Tag } from '@/components/note/tags-row'
import {
  InfoSection,
  type Property,
  type NewProperty,
  type PropertyType
} from '@/components/note/info-section'
import { OutlineInfoPanel, type HeadingItem } from '@/components/shared'
import { useActiveHeading } from '@/hooks/use-active-heading'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useJournalProperties } from '@/hooks/use-journal-properties'
import { useTemplates } from '@/hooks/use-templates'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { useNoteEditorSettings } from '@/hooks/use-note-editor-settings'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ExportDialog } from '@/components/note/export-dialog'
import { VersionHistory } from '@/components/note/version-history'
import { toast } from 'sonner'
import { useTabs } from '@/contexts/tabs'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import {
  formatDateToISO,
  formatDateParts,
  getTodayString,
  parseISODate,
  addDays,
  getTimeBasedGreeting,
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
import { useActiveTab } from '@/contexts/tabs'
import { useIsBookmarked } from '@/hooks/use-bookmarks'
import { JournalReminderButton } from '@/components/journal/journal-reminder-button'

// =============================================================================
// CONSTANTS
// =============================================================================

// Note: Calendar events are not yet implemented (spec mentions "can be mocked initially")
// Using empty array - will be populated when calendar integration is added
const EMPTY_EVENTS: ScheduleEvent[] = []

// =============================================================================
// GREETING HELPERS
// =============================================================================

function getGreetingIcon(icon: string): React.ReactNode {
  const iconClass = 'size-4'
  switch (icon) {
    case '🌅':
      return <Sunrise className={cn(iconClass, 'text-amber-500')} />
    case '☀️':
      return <Sun className={cn(iconClass, 'text-amber-400')} />
    case '🌆':
      return <Sunset className={cn(iconClass, 'text-orange-500')} />
    case '🌙':
      return <Moon className={cn(iconClass, 'text-indigo-400')} />
    default:
      return <Sun className={cn(iconClass, 'text-amber-400')} />
  }
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

interface JournalPageProps {
  className?: string
}

export function JournalPage({ className }: JournalPageProps): React.JSX.Element {
  const activeTab = useActiveTab()
  const today = getTodayString()

  // Get initial date from tab viewState (e.g., from search navigation) or default to today
  const initialDate = (activeTab?.viewState?.date as string) || today
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [focusMode, setFocusMode] = useState(() => {
    const saved = localStorage.getItem('memry_journal_focus_mode')
    return saved === 'true'
  })
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false)

  // Headings state for outline panel
  const [headings, setHeadings] = useState<HeadingItem[]>([])

  // Journal entry hook - loads/saves entry for selected date
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
        duration: Infinity, // Keep until dismissed or retry succeeds
        onDismiss: () => {
          dismissSaveError()
        }
      })
    }
  }, [saveError, retrySave, dismissSaveError])

  // Day context hook - loads tasks for selected date
  const { tasks: dayTasks, overdueCount } = useDayContext(selectedDate)

  // Tags hook - get available tags from the system
  const { tags: allAvailableTags } = useNoteTagsQuery()

  // Properties hook - manage journal entry properties
  const {
    properties: backendProperties,
    updateProperty: updateBackendProperty,
    addProperty: addBackendProperty,
    removeProperty: removeBackendProperty
  } = useJournalProperties(entry?.date ?? null, entry?.properties)

  // State for InfoSection expansion
  const [isInfoExpanded, setIsInfoExpanded] = useState(false)

  // Template selector state
  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const { templates, getTemplate } = useTemplates({ autoLoad: true })

  // Journal settings (default template)
  const { settings: journalSettings, setDefaultTemplate: setJournalDefaultTemplate } =
    useJournalSettings()

  // Editor settings (toolbar mode)
  const { settings: editorSettings } = useNoteEditorSettings()

  // Bookmark state for journal entry
  const { isBookmarked, toggle: toggleBookmark } = useIsBookmarked('journal', entry?.date ?? '')

  // Track if we're auto-applying the default template
  const [isApplyingDefaultTemplate, setIsApplyingDefaultTemplate] = useState(false)
  const hasAppliedDefaultForDateRef = useRef<string | null>(null)

  // Get default template info for the indicator
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

  // AI connections hook - analyzes entry content and finds related entries/notes
  const {
    connections: aiConnections,
    isLoading: isAILoading,
    error: aiError,
    refresh: refreshAIConnections
  } = useAIConnections(entry?.content ?? '')

  // Track when we've loaded content for the editor
  // Using a counter + ref approach to ensure proper remounting
  const [editorLoadCount, setEditorLoadCount] = useState(0)
  const lastLoadedDateRef = useRef<string | null>(null)

  // Sync editor when entry finishes loading for selected date
  useEffect(() => {
    // Skip if still loading
    if (isEntryLoading) {
      return
    }

    // Skip if data is not for the selected date
    if (loadedForDate !== selectedDate) {
      return
    }

    // Skip if we already loaded for this date
    if (lastLoadedDateRef.current === selectedDate) {
      return
    }

    // Mark as loaded and trigger editor remount by incrementing counter
    lastLoadedDateRef.current = selectedDate
    setEditorLoadCount((c) => c + 1)
  }, [selectedDate, isEntryLoading, loadedForDate])

  // Reset the ref when selected date changes (to allow loading new date)
  useEffect(() => {
    if (lastLoadedDateRef.current !== null && lastLoadedDateRef.current !== selectedDate) {
      lastLoadedDateRef.current = null
    }
  }, [selectedDate])

  // Editor state derived directly from entry
  // Key includes loadCount and externalUpdateCount to force remount when content loads or is externally updated
  const editorState = useMemo(
    () => ({
      key: `${selectedDate}-${editorLoadCount}-${externalUpdateCount}`,
      content: entry?.content ?? ''
    }),
    [selectedDate, editorLoadCount, externalUpdateCount, entry?.content]
  )

  // Determine if we should show loading state
  // Show loading when:
  // 1. Hook is actively loading, OR
  // 2. Data hasn't been loaded for the selected date yet
  const isDataPending = isEntryLoading || loadedForDate !== selectedDate

  // Delayed loading indicator - only show spinner if loading takes > 150ms
  // This prevents the flash of loading state for cached/fast responses
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false)

  useEffect(() => {
    if (isDataPending) {
      // Start a timer to show the spinner after 150ms
      const timer = setTimeout(() => setShowLoadingSpinner(true), 150)
      return () => clearTimeout(timer)
    }
    // Data is ready - hide spinner immediately
    setShowLoadingSpinner(false)
    return undefined
  }, [isDataPending])

  // Final loading state for rendering
  const showEditorLoading = isDataPending && showLoadingSpinner

  // Sync left sidebar with focus mode (hide when focus mode is on)
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()
  const { openTab } = useTabs()
  const previousSidebarState = useRef<boolean | null>(null)

  useEffect(() => {
    // Store the previous sidebar state before hiding
    if (previousSidebarState.current === null) {
      previousSidebarState.current = sidebarOpen
    }

    if (focusMode) {
      // Hide left sidebar when focus mode is enabled
      setSidebarOpen(false)
    } else {
      // Restore left sidebar when focus mode is disabled
      if (previousSidebarState.current !== null) {
        setSidebarOpen(previousSidebarState.current)
      }
    }
  }, [focusMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore sidebar state on unmount
  useEffect(() => {
    return () => {
      if (previousSidebarState.current !== null) {
        setSidebarOpen(previousSidebarState.current)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync date when navigating from search (tab viewState changes externally)
  // This effect fires when a user clicks a journal entry in search results,
  // which updates the tab's viewState with the target date
  useEffect(() => {
    const tabDate = activeTab?.viewState?.date as string
    if (tabDate && tabDate !== selectedDate) {
      setSelectedDate(tabDate)
      // Also update the local viewState to show day view for that date
      setViewState({ type: 'day', date: tabDate })
    }
  }, [activeTab?.viewState?.date]) // eslint-disable-line react-hooks/exhaustive-deps

  // View state for breadcrumb navigation
  const [viewState, setViewState] = useState<JournalViewState>({ type: 'day', date: initialDate })

  // Calculate if selected date is today
  const isToday = selectedDate === today
  const selectedDateObj = parseISODate(selectedDate)

  // Get date parts for current selected date
  const dateParts = useMemo(() => formatDateParts(selectedDate), [selectedDate])

  // Get greeting for today
  const greeting = useMemo(() => (isToday ? getTimeBasedGreeting() : null), [isToday])

  // Load real heatmap data from backend
  const currentYear = useMemo(() => dateParts.year, [dateParts.year])
  const { data: heatmapData } = useJournalHeatmap(currentYear)

  // Get month and year for the current view
  const viewMonth = viewState.type === 'month' ? viewState.month : dateParts.monthIndex
  const viewYear =
    viewState.type === 'month' || viewState.type === 'year' ? viewState.year : dateParts.year

  // Load real month entries data when in month view
  const { data: monthEntriesData } = useMonthEntries(viewYear, viewMonth + 1) // +1 because API uses 1-12

  // Load real year stats when in year view
  const { data: yearStatsData } = useYearStats(viewYear)

  // Transform monthEntriesData to Map for JournalMonthView component
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

  // Transform yearStatsData to MonthStat[] for JournalYearView component
  // If we have real data from the backend, transform it; otherwise use heatmap-based fallback
  const monthStats: MonthStat[] = useMemo(() => {
    if (yearStatsData.length > 0) {
      // Transform backend MonthStats[] to UI MonthStat[]
      // Backend returns data only for months with entries, so fill all 12 months
      const statsMap = new Map(yearStatsData.map((s) => [s.month, s]))
      const result: MonthStat[] = []

      for (let month = 0; month < 12; month++) {
        const backendStats = statsMap.get(month + 1) // Backend uses 1-12
        const monthName = getMonthName(month)

        if (backendStats) {
          // Calculate activity dots from entry count and average level
          // We'll create 5 dots based on the average level
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
          // No entries for this month
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

    // Fallback to heatmap-based calculation (for initial render before backend data loads)
    const year = viewState.type === 'year' ? viewState.year : dateParts.year
    return getMonthStats(year, heatmapData)
  }, [yearStatsData, viewState, dateParts.year, heatmapData])

  // Track active heading based on scroll position (for outline panel)
  const { activeHeadingId } = useActiveHeading({
    headings,
    offset: 120 // Account for header height
  })

  // Compute document stats for the Info tab in OutlineInfoPanel
  const documentStats = useMemo(() => {
    if (!entry) return undefined
    return {
      wordCount: entry.wordCount ?? 0,
      characterCount: entry.characterCount ?? 0,
      createdAt: entry.createdAt ?? null,
      modifiedAt: entry.modifiedAt ?? null
    }
  }, [entry])

  // ==========================================================================
  // TAGS & PROPERTIES COMPUTATIONS
  // ==========================================================================

  // Build a lookup map of tag colors from backend
  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      map.set(t.tag, t.color)
    }
    return map
  }, [allAvailableTags])

  // Convert entry tags to Tag[] format for TagsRow
  const journalTags: Tag[] = useMemo(() => {
    return (entry?.tags || []).map((tagName) => ({
      id: tagName,
      name: tagName,
      color: tagColorMap.get(tagName) ?? 'stone'
    }))
  }, [entry?.tags, tagColorMap])

  // Convert available tags to Tag[] format
  const availableTags: Tag[] = useMemo(() => {
    return allAvailableTags.map((t) => ({
      id: t.tag,
      name: t.tag,
      color: t.color
    }))
  }, [allAvailableTags])

  // Recent tags for quick access
  const recentTags = useMemo(() => {
    return availableTags.slice(0, 4)
  }, [availableTags])

  // Type mapping for backend PropertyValue to UI Property
  const mapPropertyType = useCallback((backendType: string): PropertyType => {
    const typeMap: Record<string, PropertyType> = {
      text: 'text',
      number: 'number',
      checkbox: 'checkbox',
      date: 'date',
      select: 'select',
      multiselect: 'multiSelect',
      url: 'url',
      rating: 'rating'
    }
    return typeMap[backendType] ?? 'text'
  }, [])

  // Convert backend properties to UI format
  const properties: Property[] = useMemo(() => {
    return backendProperties.map((prop) => ({
      id: prop.name,
      name: prop.name,
      type: mapPropertyType(prop.type),
      value: prop.value,
      isCustom: true
    }))
  }, [backendProperties, mapPropertyType])

  // ==========================================================================
  // NAVIGATION CALLBACKS
  // ==========================================================================

  // Navigate to month view
  const navigateToMonth = useCallback((year: number, month: number) => {
    setViewState({ type: 'month', year, month })
  }, [])

  // Navigate to year view
  const navigateToYear = useCallback((year: number) => {
    setViewState({ type: 'year', year })
  }, [])

  // Navigate to specific day
  const navigateToDay = useCallback((date: string) => {
    setSelectedDate(date)
    setViewState({ type: 'day', date })
  }, [])

  // Navigate back one level
  const navigateBack = useCallback(() => {
    if (viewState.type === 'month') {
      navigateToYear(viewState.year)
    } else if (viewState.type === 'year') {
      navigateToDay(selectedDate)
    }
  }, [viewState, selectedDate, navigateToYear, navigateToDay])

  // Handle calendar day click
  const handleDayClick = useCallback(
    (date: string) => {
      navigateToDay(date)
    },
    [navigateToDay]
  )

  // Handle today click
  const handleTodayClick = useCallback(() => {
    navigateToDay(today)
  }, [today, navigateToDay])

  // Navigate to previous day
  const handlePreviousDay = useCallback(() => {
    const prevDay = addDays(selectedDateObj, -1)
    navigateToDay(formatDateToISO(prevDay))
  }, [selectedDateObj, navigateToDay])

  // Navigate to next day
  const handleNextDay = useCallback(() => {
    const nextDay = addDays(selectedDateObj, 1)
    navigateToDay(formatDateToISO(nextDay))
  }, [selectedDateObj, navigateToDay])

  // BlockNote content handlers - save markdown content via journal service
  const handleMarkdownChange = useCallback(
    (markdown: string) => {
      updateContent(markdown)
    },
    [updateContent]
  )

  // Block change handler (we don't need this for saving, but keep for potential future use)
  const handleContentChange = useCallback((_newBlocks: Block[]) => {
    // Content changes are handled by handleMarkdownChange
  }, [])

  const handleLinkClick = useCallback((href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleInternalLinkClick = useCallback(
    async (linkedNoteIdOrTitle: string) => {
      const target = linkedNoteIdOrTitle?.trim()
      if (!target) return

      try {
        // Use format-aware resolution to handle notes and files
        const resolution = await resolveWikiLink(target)

        switch (resolution.type) {
          case 'file':
            // Open file in appropriate viewer (image, video, PDF, audio)
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
            // Open note in editor
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
            // For journal, just show info that note doesn't exist
            // (don't auto-create from journal context)
            toast.info(`Note "${target}" not found`)
            break

          case 'not-found':
            // File-like target not found - show error
            toast.error(`File not found: ${target}`)
            break
        }
      } catch (err) {
        console.error('[JournalPage] Failed to resolve wiki link:', err)
        toast.error('Failed to open linked item')
      }
    },
    [openTab]
  )

  // Heading handlers for outline panel
  const handleHeadingClick = useCallback((headingId: string) => {
    const element = document.querySelector(`[data-id="${headingId}"]`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
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

  // ==========================================================================
  // TAG HANDLERS
  // ==========================================================================

  const handleAddTag = useCallback(
    (tagId: string) => {
      const tagToAdd = availableTags.find((t) => t.id === tagId)
      if (tagToAdd && entry && !entry.tags.includes(tagToAdd.name)) {
        const newTags = [...entry.tags, tagToAdd.name]
        updateTags(newTags)
      }
    },
    [availableTags, entry, updateTags]
  )

  const handleCreateTag = useCallback(
    (name: string, _color: string) => {
      if (entry && !entry.tags.includes(name)) {
        const newTags = [...entry.tags, name]
        updateTags(newTags)
      }
    },
    [entry, updateTags]
  )

  const handleRemoveTag = useCallback(
    (tagId: string) => {
      if (entry) {
        const newTags = entry.tags.filter((t) => t !== tagId)
        updateTags(newTags)
      }
    },
    [entry, updateTags]
  )

  // ==========================================================================
  // PROPERTY HANDLERS
  // ==========================================================================

  // Default values for property types when creating new properties
  const getDefaultValueForType = useCallback((type: PropertyType): unknown => {
    switch (type) {
      case 'checkbox':
        return false
      case 'number':
      case 'rating':
        return 0
      case 'multiSelect':
        return []
      case 'date':
        return null
      default:
        return ''
    }
  }, [])

  const handlePropertyChange = useCallback(
    async (propertyId: string, value: unknown) => {
      try {
        await updateBackendProperty(propertyId, value)
      } catch (err) {
        console.error('[JournalPage] Failed to update property:', err)
      }
    },
    [updateBackendProperty]
  )

  const handleAddProperty = useCallback(
    async (newProp: NewProperty) => {
      const defaultValue = getDefaultValueForType(newProp.type)
      try {
        await addBackendProperty(newProp.name, defaultValue)
      } catch (err) {
        console.error('[JournalPage] Failed to add property:', err)
      }
    },
    [addBackendProperty, getDefaultValueForType]
  )

  const handleDeleteProperty = useCallback(
    async (propertyId: string) => {
      try {
        await removeBackendProperty(propertyId)
      } catch (err) {
        console.error('[JournalPage] Failed to delete property:', err)
      }
    },
    [removeBackendProperty]
  )

  // ==========================================================================
  // TEMPLATE HANDLERS
  // ==========================================================================

  const handleTemplateSelect = useCallback(
    async (templateId: string | null) => {
      setShowTemplateSelector(false)

      if (!templateId || templateId === 'blank') {
        // User selected blank template or cancelled - create empty entry
        try {
          await journalService.createEntry({ date: selectedDate, content: '' })
          // Force editor remount to show the new entry
          lastLoadedDateRef.current = null
          setEditorLoadCount((c) => c + 1)
        } catch (err) {
          console.error('[JournalPage] Failed to create blank entry:', err)
        }
        return
      }

      // Get the full template
      const template = await getTemplate(templateId)
      if (!template) {
        console.error('[JournalPage] Template not found:', templateId)
        return
      }

      // Apply template: replace {{title}} placeholder with the date
      const parts = formatDateParts(selectedDate)
      const dateTitle = `${parts.month} ${parts.day}, ${parts.year}`
      const content = template.content.replace(/\{\{title\}\}/g, dateTitle)

      // Convert template properties array to record
      const properties: Record<string, unknown> = {}
      if (template.properties) {
        for (const prop of template.properties) {
          properties[prop.name] = prop.value
        }
      }

      try {
        // Create the journal entry with template content, tags, and properties
        await journalService.createEntry({
          date: selectedDate,
          content,
          tags: template.tags ?? [],
          properties
        })

        // Force editor remount to show the new content
        lastLoadedDateRef.current = null
        setEditorLoadCount((c) => c + 1)
      } catch (err) {
        console.error('[JournalPage] Failed to apply template:', err)
      }
    },
    [selectedDate, getTemplate]
  )

  // Auto-apply default template when navigating to a new date with no entry
  const handleApplyDefaultTemplate = useCallback(async () => {
    if (!defaultTemplateInfo?.id) return
    if (hasAppliedDefaultForDateRef.current === selectedDate) return

    setIsApplyingDefaultTemplate(true)
    hasAppliedDefaultForDateRef.current = selectedDate

    try {
      const template = await getTemplate(defaultTemplateInfo.id)
      if (!template) {
        console.error('[JournalPage] Default template not found:', defaultTemplateInfo.id)
        setIsApplyingDefaultTemplate(false)
        return
      }

      // Apply template: replace {{title}} placeholder with the date
      const parts = formatDateParts(selectedDate)
      const dateTitle = `${parts.month} ${parts.day}, ${parts.year}`
      const content = template.content.replace(/\{\{title\}\}/g, dateTitle)

      // Convert template properties array to record
      const properties: Record<string, unknown> = {}
      if (template.properties) {
        for (const prop of template.properties) {
          properties[prop.name] = prop.value
        }
      }

      await journalService.createEntry({
        date: selectedDate,
        content,
        tags: template.tags ?? [],
        properties
      })

      // Force editor remount to show the new content
      lastLoadedDateRef.current = null
      setEditorLoadCount((c) => c + 1)
    } catch (err) {
      console.error('[JournalPage] Failed to apply default template:', err)
    } finally {
      setIsApplyingDefaultTemplate(false)
    }
  }, [selectedDate, defaultTemplateInfo?.id, getTemplate])

  // Handle start blank - create empty entry
  const handleStartBlank = useCallback(async () => {
    hasAppliedDefaultForDateRef.current = selectedDate
    try {
      await journalService.createEntry({
        date: selectedDate,
        content: ''
      })
      // Force editor remount
      lastLoadedDateRef.current = null
      setEditorLoadCount((c) => c + 1)
    } catch (err) {
      console.error('[JournalPage] Failed to create blank entry:', err)
    }
  }, [selectedDate])

  // Auto-apply default template when navigating to a date with no entry
  useEffect(() => {
    // Only auto-apply if:
    // 1. Not loading
    // 2. No entry exists for this date
    // 3. Default template is set
    // 4. Haven't already applied for this date
    if (
      !isEntryLoading &&
      loadedForDate === selectedDate &&
      !entry &&
      defaultTemplateInfo?.id &&
      hasAppliedDefaultForDateRef.current !== selectedDate
    ) {
      // Auto-apply the default template
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

  // Handle task completion toggle from DayContextSidebar
  const handleTaskToggle = useCallback(
    async (taskId: string) => {
      // Find the task to determine if it's completed
      const task = dayTasks.find((t) => t.id === taskId)
      if (!task) return

      try {
        if (task.completed) {
          await tasksService.uncomplete(taskId)
        } else {
          await tasksService.complete({ id: taskId })
        }
        // Note: The useDayContext hook will auto-refresh via task events
      } catch (error) {
        console.error('Failed to toggle task completion:', error)
      }
    },
    [dayTasks]
  )

  // Handle AI connection click - navigate to related content
  const handleConnectionClick = useCallback(
    (connection: AIConnection) => {
      if (connection.type === 'journal' && connection.date) {
        // Parse the human-readable date (e.g., "Nov 15, 2024") to ISO format
        const isoDate = parseConnectionDate(connection.date)
        if (isoDate) {
          navigateToDay(isoDate)
        } else {
          console.warn('Could not parse connection date:', connection.date)
        }
      } else if (connection.type === 'note' && connection.title) {
        // Log for now - will integrate with notes navigation in future
        console.log('Navigate to note:', connection.title)
      }
    },
    [navigateToDay]
  )

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape: Navigate back or exit focus mode
      if (e.key === 'Escape') {
        // If in month or year view, navigate back
        if (viewState.type === 'month' || viewState.type === 'year') {
          e.preventDefault()
          navigateBack()
          return
        }
        // Otherwise exit focus mode if active
        if (focusMode) {
          setFocusMode(false)
        }
      }
      // Cmd/Ctrl + \ toggles focus mode
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setFocusMode((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [focusMode, viewState, navigateBack])

  // Persist focus mode - save to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('memry_journal_focus_mode', focusMode.toString())
  }, [focusMode])

  // Handle error boundary recovery
  const handleErrorRecover = useCallback(() => {
    // Force reload entry
    lastLoadedDateRef.current = null
    setEditorLoadCount((c) => c + 1)
  }, [])

  return (
    <JournalErrorBoundary
      date={selectedDate}
      onRecover={handleErrorRecover}
      onError={(error, errorInfo) => {
        console.error('[JournalPage] Error caught by boundary:', error, errorInfo)
      }}
    >
      <div
        className={cn(
          'flex h-full w-full overflow-hidden bg-background',
          'transition-all duration-500 ease-out',
          className
        )}
      >
        {/* Main Content Area - Journal Writing */}
        <main
          className={cn(
            'flex-1 min-w-0 h-full relative',
            'transition-all duration-500 ease-out',
            focusMode ? 'journal-focus-paper' : ''
          )}
        >
          {/* Scrollable content area */}
          <div className={cn('h-full overflow-y-auto', focusMode ? 'px-8' : 'px-6 lg:px-8')}>
            <div
              className={cn(
                'mx-auto min-h-full flex flex-col',
                'transition-all duration-500 ease-out',
                focusMode ? 'max-w-xl' : 'max-w-2xl',
                focusMode ? 'py-20 lg:py-28' : 'py-10 lg:py-16'
              )}
            >
              {/* Header - Centered Breadcrumb Navigation */}
              <header className={cn('relative mb-8 lg:mb-12', '')}>
                {/* Content layer */}
                <div className="relative z-10">
                  {/* Top bar with greeting (left), breadcrumb (center), focus toggle (right) */}
                  <div className="flex items-center justify-between gap-4">
                    {/* Left side - Greeting (only for today in day view, hidden in focus mode) */}
                    <div className="flex-1 flex justify-start">
                      {viewState.type === 'day' && greeting && !focusMode && (
                        <div
                          className={cn(
                            'hidden sm:flex items-center gap-2',
                            'px-3 py-1.5 rounded-lg',
                            'bg-gradient-to-r from-amber-50/80 to-orange-50/60',
                            'dark:from-amber-950/30 dark:to-orange-950/20',
                            'journal-greeting-glow',
                            'transition-all duration-300',
                            ''
                          )}
                        >
                          {getGreetingIcon(greeting.icon)}
                          <span className="text-sm font-medium text-amber-800/80 dark:text-amber-200/80">
                            {greeting.greeting}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Center - Breadcrumb Navigation */}
                    <DateBreadcrumb
                      viewState={viewState}
                      onMonthClick={navigateToMonth}
                      onYearClick={navigateToYear}
                      onBackClick={navigateBack}
                      onPreviousDay={handlePreviousDay}
                      onNextDay={handleNextDay}
                    />

                    {/* Right side - Focus Mode Toggle */}
                    <div className="flex-1 flex items-center justify-end gap-2">
                      {/* Focus Mode Toggle */}
                      {viewState.type === 'day' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'size-8 rounded-lg',
                            'text-muted-foreground/60 hover:text-foreground',
                            'hover:bg-foreground/5',
                            'transition-all duration-200',
                            focusMode && 'bg-foreground/5 text-foreground',
                            ''
                          )}
                          onClick={() => setFocusMode(!focusMode)}
                          aria-pressed={focusMode}
                          aria-label={focusMode ? 'Exit Focus Mode' : 'Enter Focus Mode'}
                          title={focusMode ? 'Exit Focus Mode (Esc)' : 'Enter Focus Mode (⌘\\)'}
                        >
                          {focusMode ? (
                            <Minimize2 className="size-4" />
                          ) : (
                            <Maximize2 className="size-4" />
                          )}
                        </Button>
                      )}

                      {/* Reminder Button */}
                      {viewState.type === 'day' && entry && (
                        <JournalReminderButton journalDate={entry.date} disabled={false} />
                      )}

                      {/* Bookmark Button */}
                      {viewState.type === 'day' && entry && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 transition-all duration-200"
                          onClick={toggleBookmark}
                          title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
                        >
                          <Bookmark
                            className={`size-4 ${isBookmarked ? 'fill-current text-amber-500' : ''}`}
                          />
                          <span className="sr-only">
                            {isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
                          </span>
                        </Button>
                      )}

                      {/* More Options Menu (3 dots) */}
                      {viewState.type === 'day' && entry && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 transition-all duration-200"
                            >
                              <MoreHorizontal className="size-4" />
                              <span className="sr-only">More options</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setIsVersionHistoryOpen(true)}>
                              <History className="mr-2 h-4 w-4" />
                              Version History
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setIsExportDialogOpen(true)}>
                              Export
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>

                  {/* Month view subtitle */}
                  {viewState.type === 'month' && (
                    <p className="text-center font-serif text-sm text-muted-foreground/60 italic mt-2 ">
                      All journal entries for this month
                    </p>
                  )}

                  {/* Year view subtitle */}
                  {viewState.type === 'year' && (
                    <p className="text-center font-serif text-sm text-muted-foreground/60 italic mt-2 ">
                      Select a month to view entries
                    </p>
                  )}
                </div>
              </header>

              {/* Error Banner */}
              {entryError && (
                <div className="mb-4 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  <span className="font-medium">Error:</span> {entryError}
                </div>
              )}

              {/* Conditional Content Rendering */}
              {viewState.type === 'day' && (
                /* Journal Editor - Main Writing Area (BlockNote) + Backlinks */
                <>
                  {/* Template Prompt - Show when there's no entry and not loading */}
                  {!isEntryLoading && !entry && !focusMode && (
                    <div className="mb-6 ">
                      {/* Default template is set - show indicator and auto-apply */}
                      {defaultTemplateInfo ? (
                        <DefaultTemplateIndicator
                          templateName={defaultTemplateInfo.name}
                          templateIcon={defaultTemplateInfo.icon}
                          isCreating={isApplyingDefaultTemplate}
                          onChangeTemplate={() => setShowTemplateSelector(true)}
                          onStartBlank={handleStartBlank}
                        />
                      ) : (
                        /* No default template - show original prompt */
                        <button
                          onClick={() => setShowTemplateSelector(true)}
                          className={cn(
                            'w-full flex items-center gap-3 px-4 py-3 rounded-lg',
                            'border border-dashed border-amber-300/50 dark:border-amber-700/50',
                            'bg-gradient-to-r from-amber-50/50 to-orange-50/30',
                            'dark:from-amber-950/20 dark:to-orange-950/10',
                            'hover:border-amber-400/60 dark:hover:border-amber-600/60',
                            'hover:from-amber-50/70 hover:to-orange-50/50',
                            'dark:hover:from-amber-950/30 dark:hover:to-orange-950/20',
                            'transition-all duration-200',
                            'text-left group'
                          )}
                        >
                          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center border border-amber-200/50 dark:border-amber-800/30 shadow-sm">
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

                  {/* Tags Section - Hidden in focus mode */}
                  {!focusMode && entry && (
                    <div className="mb-4 " style={{ paddingLeft: '24px' }}>
                      <TagsRow
                        tags={journalTags}
                        availableTags={availableTags}
                        recentTags={recentTags}
                        onAddTag={handleAddTag}
                        onCreateTag={handleCreateTag}
                        onRemoveTag={handleRemoveTag}
                      />
                    </div>
                  )}

                  {/* Properties Section - Hidden in focus mode */}
                  {!focusMode && entry && (
                    <div className="mb-4 " style={{ paddingLeft: '24px' }}>
                      <InfoSection
                        properties={properties}
                        isExpanded={isInfoExpanded}
                        onToggleExpand={() => setIsInfoExpanded(!isInfoExpanded)}
                        onPropertyChange={handlePropertyChange}
                        onAddProperty={handleAddProperty}
                        onDeleteProperty={handleDeleteProperty}
                      />
                    </div>
                  )}

                  <div
                    className={cn(
                      'editor-click-area min-h-[300px] relative',
                      '',
                      // Notebook margin line (only when not in focus mode)
                      !focusMode && 'journal-margin-line pl-6 lg:pl-8'
                    )}
                    onMouseDown={(e) => {
                      const target = e.target as HTMLElement
                      // If clicking directly on editable text, let it work normally
                      if (
                        target.closest('[contenteditable="true"]')?.contains(target) &&
                        target.closest('.bn-block-content')
                      ) {
                        return
                      }
                      // If clicking on buttons or links, let it work normally
                      if (target.closest('button, a, input')) {
                        return
                      }
                      // Focus editor for all other clicks (empty areas)
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
                /* Month View - List of all entries */
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
                /* Year View - Grid of month cards */
                <JournalYearView
                  year={viewState.year}
                  monthStats={monthStats}
                  onMonthClick={(month) => navigateToMonth(viewState.year, month)}
                  className="flex-1"
                />
              )}
            </div>
          </div>

          {/* Floating outline panel with Info tab - only show in day view, hidden in focus mode */}
          {viewState.type === 'day' && !focusMode && (
            <OutlineInfoPanel
              headings={headings}
              onHeadingClick={handleHeadingClick}
              activeHeadingId={activeHeadingId ?? undefined}
              stats={documentStats}
            />
          )}
        </main>

        {/* Right Sidebar - Context Panel */}
        <aside
          className={cn(
            'shrink-0 h-full overflow-hidden',
            'border-l border-border/30',
            'journal-sidebar-gradient',
            // Hide on smaller screens
            'hidden lg:block',
            // Smooth transition for width and opacity
            'transition-[width,opacity] duration-500 ease-out',
            // Collapsed state
            focusMode || viewState.type !== 'day'
              ? 'w-0 opacity-0 border-l-0'
              : 'w-[320px] xl:w-[360px] opacity-100'
          )}
        >
          <div
            className={cn(
              'h-full overflow-y-auto scrollbar-thin',
              'p-5 xl:p-6',
              'flex flex-col gap-6',
              'w-[320px] xl:w-[360px]',
              // Fade content
              'transition-opacity duration-500 ease-out',
              focusMode || viewState.type !== 'day' ? 'opacity-0' : 'opacity-100'
            )}
          >
            {/* Decorative corner accent */}
            <div
              className={cn(
                'absolute top-0 right-0 w-24 h-24',
                'bg-gradient-to-bl from-amber-500/[0.04] to-transparent',
                'dark:from-amber-400/[0.03]',
                'rounded-bl-[60px]',
                'pointer-events-none'
              )}
              aria-hidden="true"
            />

            {/* Mini Calendar */}
            <section className="relative ">
              <h3 className="journal-section-label mb-3">Calendar</h3>
              <JournalCalendar
                selectedDate={selectedDate}
                onDayClick={handleDayClick}
                onTodayClick={handleTodayClick}
                heatmapData={heatmapData}
              />
            </section>

            {/* Day Context - Events & Tasks */}
            <section className="relative ">
              <h3 className="journal-section-label mb-3">
                {isToday ? "Today's Schedule" : 'Schedule'}
              </h3>
              <DayContextSidebar
                events={EMPTY_EVENTS}
                tasks={dayTasks}
                overdueCount={overdueCount}
                isToday={isToday}
                isPast={selectedDate < today}
                onTaskClick={(id) => console.log('Task clicked:', id)}
                onTaskToggle={handleTaskToggle}
                onEventClick={(id) => console.log('Event clicked:', id)}
              />
            </section>

            {/* AI Connections */}
            <section className="relative ">
              <h3 className="journal-section-label mb-3">Connected Thoughts</h3>
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
          </div>
        </aside>

        {/* Template Selector Dialog */}
        <TemplateSelector
          isOpen={showTemplateSelector}
          onClose={() => setShowTemplateSelector(false)}
          onSelect={handleTemplateSelect}
          isJournalContext
          journalDefaultTemplateId={journalSettings.defaultTemplate}
          onSetJournalDefault={setJournalDefaultTemplate}
        />

        {/* Export Dialog */}
        {entry && (
          <ExportDialog
            open={isExportDialogOpen}
            onOpenChange={setIsExportDialogOpen}
            noteId={entry.id}
            noteTitle={`Journal - ${formatDateParts(selectedDate).month} ${formatDateParts(selectedDate).day}, ${formatDateParts(selectedDate).year}`}
          />
        )}

        {/* Version History Panel */}
        {entry && (
          <VersionHistory
            open={isVersionHistoryOpen}
            onOpenChange={setIsVersionHistoryOpen}
            noteId={entry.id}
            noteTitle={`Journal - ${formatDateParts(selectedDate).month} ${formatDateParts(selectedDate).day}, ${formatDateParts(selectedDate).year}`}
            onRestore={async () => {
              // Force reload entry after restore (discards pending changes)
              await forceReload()
              // Reset editor load tracking to force remount with new content
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
