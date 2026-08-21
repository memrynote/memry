/**
 * Journal Page - Contemplative Editorial Design
 * A refined, warm aesthetic that makes journaling feel premium
 * Full-width journal writing area with breadcrumb navigation
 * Day context (calendar + tasks) available via global Day Panel
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type UIEvent
} from 'react'
import { cn } from '@/lib/utils'
import { useReducedMotion } from 'motion/react'
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
import { isOutsideAllBlocks } from '@/components/note/content-area/marquee-hit-test'
import { BacklinksSection, type Backlink, backlinkId } from '@/components/note/backlinks'

import { TagsRow, type Tag } from '@/components/note/tags-row'
import { InfoSection, type NewProperty } from '@/components/note/info-section'
import { GhostAffordanceRow } from '@/components/note/ghost-affordance-row'
import { OutlineInfoPanel, type HeadingItem } from '@/components/shared'
import { useActiveHeading } from '@/hooks/use-active-heading'
import { useReviewRailShift } from '@/hooks/use-review-rail-shift'
import { useNoteTagsQuery, useNoteLinksQuery } from '@/hooks/use-notes-query'
import { usePropertiesCollapsed } from '@/hooks/use-properties-collapsed'
import { usePropertySection } from '@/hooks/use-property-section'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { useToday } from '@/hooks/use-today'
import { useEditorSettings, EDITOR_NORMAL_CONTENT_WIDTH } from '@/hooks/use-editor-settings'
import { ExportDialog } from '@/components/note/export-dialog'
import { VersionHistory } from '@/components/note/version-history'
import { toast } from 'sonner'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { useTabViewState } from '@/hooks/use-tab-view-state'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import {
  DEFAULT_JOURNAL_DRILL,
  JOURNAL_DATE_KEY,
  JOURNAL_VIEW_STATE_KEYS,
  journalScrollKey,
  parseJournalDrill,
  resolveJournalDate,
  toJournalViewState,
  type JournalDrill
} from './journal-view-state'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import { scrollToHeadingBlock } from '@/lib/scroll-to-heading'
import { splitWikiTarget, normalizeHeading } from '@memry/shared/wiki-target'
import {
  createJournalDateLabels,
  formatDateToISO,
  formatDateParts,
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
import { ReviewBadgeLayer, ReviewRail, useCriticMarkupReview } from '@/components/note/review'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Page:Journal')

function isTextInputElement(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
}

function isContentEditableElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  const contentEditableAttr = element.getAttribute('contenteditable')
  return (
    element.isContentEditable ||
    element.contentEditable === 'true' ||
    element.contentEditable === 'plaintext-only' ||
    contentEditableAttr === 'true' ||
    contentEditableAttr === 'plaintext-only'
  )
}

function isKeyboardEditingElementFocused(): boolean {
  const activeElement = document.activeElement
  return isTextInputElement(activeElement) || isContentEditableElement(activeElement)
}

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
  const { t, i18n: _i18n } = useT('journal')
  const { t: commonT } = useT('common')
  const activeTab = useActiveTab()
  const { openTab, state: tabState } = useTabs()
  const identity = useTabIdentity()
  const today = useToday()
  const dateLabels = useMemo(() => createJournalDateLabels(t), [t])
  // The date is read off THIS tab, not off the globally active one: a journal
  // sitting in the inactive pane of a split view would otherwise read another
  // tab's `date` key, or none at all. Reactive, because `openTab` writes the
  // date into the tab and the page has to follow it.
  const tabDate = useMemo(() => {
    if (!identity) return undefined
    const tab = tabState.tabGroups[identity.groupId]?.tabs.find((t) => t.id === identity.tabId)
    const raw = tab?.viewState?.[JOURNAL_DATE_KEY]
    return typeof raw === 'string' ? raw : undefined
  }, [identity, tabState.tabGroups])

  // Get initial date from tab viewState or default to today
  const initialDate = resolveJournalDate(tabDate, today)
  const [selectedDateState, setSelectedDateState] = useState(initialDate)
  // The drill level lives in the tab: month and year view used to be local
  // state, so drilling up and switching tabs put the user back on a day.
  const [drill, setDrill] = useTabViewState<JournalDrill>({
    key: JOURNAL_VIEW_STATE_KEYS.drill,
    defaultValue: DEFAULT_JOURNAL_DRILL,
    parse: parseJournalDrill
  })
  const selectedDate = resolveJournalDate(tabDate, selectedDateState)
  const currentViewState = useMemo<JournalViewState>(
    () => toJournalViewState(drill, selectedDate),
    [drill, selectedDate]
  )

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
      description: t('toast.unsavedRetry'),
      action: {
        label: commonT('button.retry'),
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
  }, [saveError, retrySave, dismissSaveError, commonT, t])

  // Backlinks hook
  const { incoming: rawBacklinks, isLoading: backlinksLoading } = useNoteLinksQuery(
    entry?.id ?? null
  )

  // Tags hook
  const { tags: allAvailableTags } = useNoteTagsQuery()

  // Journal settings
  const { settings: journalSettings, isLoading: isJournalSettingsLoading } = useJournalSettings()

  // Editor settings — width follows the global setting (Normal / Full) unless
  // the user overrides it for Journal, which applies to every journal page.
  const { settings: editorSettings } = useEditorSettings()

  const [journalWidthOverride, setJournalWidthOverride] = useState<boolean | null>(() => {
    const saved = localStorage.getItem('memry_journal_full_width')
    return saved === null ? null : saved === 'true'
  })
  const isFullWidth = journalWidthOverride ?? editorSettings.width === 'full'
  const journalContentWidth = isFullWidth ? undefined : EDITOR_NORMAL_CONTENT_WIDTH

  const toggleJournalWidth = useCallback(() => {
    setJournalWidthOverride((prev) => {
      const current = prev ?? editorSettings.width === 'full'
      const next = !current
      localStorage.setItem('memry_journal_full_width', String(next))
      return next
    })
  }, [editorSettings.width])

  // Settings modal
  const { open: openSettingsModal } = useSettingsModal()

  // Bookmark state - use entry.id (e.g., "j2026-01-13") to match notes_cache lookup
  const { isBookmarked, toggle: toggleBookmark } = useIsBookmarked('journal', entry?.id ?? '')

  const entryTags = useMemo(() => entry?.tags ?? [], [entry?.tags])

  const [editorRevision, setEditorRevision] = useState(0)

  const editorLoadState = loadedForDate === selectedDate ? 'loaded' : 'pending'
  // `externalUpdateCount` is deliberately NOT part of the key: an external
  // update (device sync, an on-disk edit, an agent write) is handed to the live
  // editor via `externalContentRevision` instead of throwing the editor away and
  // building a new one for every remote change. `editorRevision` stays in the
  // key — it is the error-boundary recovery path, where a fresh editor is the
  // point.
  const editorState = useMemo(
    () => ({
      key: `${selectedDate}-${editorLoadState}-${editorRevision}`,
      content: editorLoadState === 'loaded' ? (entry?.content ?? '') : ''
    }),
    [selectedDate, editorLoadState, editorRevision, entry?.content]
  )

  const isDataPending = isEntryLoading || loadedForDate !== selectedDate
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false)
  if (!isDataPending && showLoadingSpinner) {
    setShowLoadingSpinner(false)
  }

  useEffect(() => {
    if (isDataPending) {
      const timer = setTimeout(() => setShowLoadingSpinner(true), 150)
      return () => clearTimeout(timer)
    }
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
  const dateParts = useMemo(
    () => formatDateParts(selectedDate, dateLabels),
    [selectedDate, dateLabels]
  )
  const journalNoteTitle = useMemo(
    () =>
      t('export.noteTitle', {
        month: dateParts.month,
        day: dateParts.day,
        year: dateParts.year
      }),
    [dateParts.day, dateParts.month, dateParts.year, t]
  )

  const currentYear = dateParts.year
  const { data: heatmapData } = useJournalHeatmap(currentYear)

  const viewMonth =
    currentViewState.type === 'month' ? currentViewState.month : dateParts.monthIndex
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
        const monthName = getMonthName(month, dateLabels)

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
    return getMonthStats(year, heatmapData, dateLabels)
  }, [yearStatsData, currentViewState, dateParts.year, heatmapData, dateLabels])

  const journalScrollRef = useRef<HTMLDivElement>(null)
  const [journalScrollEl, setJournalScrollEl] = useState<HTMLDivElement | null>(null)
  const setJournalScrollRef = useCallback((el: HTMLDivElement | null) => {
    journalScrollRef.current = el
    setJournalScrollEl(el)
  }, [])
  const getJournalScrollEl = useCallback(() => journalScrollRef.current, [])
  // Day view throws the editor away and rebuilds it from a key on every date
  // change and on every load transition, so an offset applied while the entry
  // is still pending lands on an empty editor and gets clamped to 0. Waiting
  // for `loaded` is enough — the hook re-runs when `enabled` flips. Month and
  // year view have no editor and never wait.
  useTabScrollRestore({
    getScrollElement: getJournalScrollEl,
    enabled: currentViewState.type !== 'day' || editorLoadState === 'loaded',
    key: journalScrollKey(currentViewState)
  })
  const prefersReducedMotion = useReducedMotion()
  // Scroll-edge effect for the floating chrome (state only flips at the 0 boundary)
  const [isChromeScrolled, setIsChromeScrolled] = useState(false)
  const handleChromeScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setIsChromeScrolled(e.currentTarget.scrollTop > 0)
  }, [])
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
      // BlockNote's side menu, drag-handle menu, toolbars and their nested
      // dropdowns render inside the marquee zone (not portaled). A mousedown on
      // one must NOT focus the editor: stealing focus unmounts the menu between
      // mousedown and mouseup, so the item's click never fires. Mirror the
      // marquee hook's exclusion list, plus menu roles for nested submenus.
      if (
        target.closest(
          '.bn-side-menu, .bn-formatting-toolbar, .bn-suggestion-menu, .bn-link-toolbar, .bn-drag-handle-menu, .bn-menu-dropdown, [role="menu"]'
        )
      )
        return
      // "Outside every block" — deliberately NOT the same test as the marquee
      // start rule's "is there text here". See marquee-hit-test.ts.
      if (!isOutsideAllBlocks(target)) return
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
  const [pendingTagColors, setPendingTagColors] = useState(() => new Map<string, string>())

  // Maps keyed by lowercase: tag identity is case-insensitive, display keeps user casing
  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      map.set(t.tag.toLowerCase(), t.color)
    }
    // Just-created tags aren't in allAvailableTags until reindex+refetch;
    // without this the editor pill falls back to the hashed default color
    for (const [key, color] of pendingTagColors) {
      if (!map.has(key)) map.set(key, color)
    }
    return map
  }, [allAvailableTags, pendingTagColors])

  const tagIconMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      if (t.icon) map.set(t.tag.toLowerCase(), t.icon)
    }
    return map
  }, [allAvailableTags])

  const journalTags: Tag[] = useMemo(() => {
    return (entry?.tags || []).map((tagName) => ({
      id: tagName,
      name: tagName,
      color:
        tagColorMap.get(tagName.toLowerCase()) ?? pendingTagColors.get(tagName.toLowerCase()) ?? '',
      icon: tagIconMap.get(tagName.toLowerCase()) ?? null
    }))
  }, [entry?.tags, tagColorMap, tagIconMap, pendingTagColors])

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

  const [propertiesCollapsed, togglePropertiesCollapsed, setPropertiesCollapsed] =
    usePropertiesCollapsed(entry?.id ?? '')

  const handleAddPropertyWithExpand = useCallback(
    (newProp: NewProperty) => {
      setPropertiesCollapsed(false)
      handleAddProperty(newProp)
    },
    [handleAddProperty, setPropertiesCollapsed]
  )

  const properties = useMemo(() => rawProperties.filter((p) => p.name !== 'date'), [rawProperties])

  // Navigation
  const navigateToMonth = useCallback(
    (year: number, month: number) => {
      setDrill({ type: 'month', year, month })
    },
    [setDrill]
  )

  const navigateToYear = useCallback(
    (year: number) => {
      setDrill({ type: 'year', year })
    },
    [setDrill]
  )

  const navigateToDay = useCallback(
    (date: string) => {
      setSelectedDateState(date)
      setDrill({ type: 'day' })
      openTab({
        type: 'journal',
        title: t('title'),
        icon: 'book-open',
        path: '/journal',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { date }
      })
    },
    [openTab, setDrill, t]
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
      setDrill({ type: 'month', year: newYear, month: newMonth })
    }
  }, [currentViewState, setDrill])

  const handleNextMonth = useCallback(() => {
    if (currentViewState.type === 'month') {
      const newMonth = currentViewState.month === 11 ? 0 : currentViewState.month + 1
      const newYear =
        currentViewState.month === 11 ? currentViewState.year + 1 : currentViewState.year
      setDrill({ type: 'month', year: newYear, month: newMonth })
    }
  }, [currentViewState, setDrill])

  const handlePreviousYear = useCallback(() => {
    if (currentViewState.type === 'year') {
      setDrill({ type: 'year', year: currentViewState.year - 1 })
    }
  }, [currentViewState, setDrill])

  const handleNextYear = useCallback(() => {
    if (currentViewState.type === 'year') {
      setDrill({ type: 'year', year: currentViewState.year + 1 })
    }
  }, [currentViewState, setDrill])

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
  const review = useCriticMarkupReview({
    markdown: editorState.content,
    onMarkdownChange: handleMarkdownChange
  })
  const hasReviewContent = review.marks.length > 0 || !!review.activeDraft
  const {
    shiftStyle: railShiftStyle,
    railHidden,
    setContentEl: setRailContentEl
  } = useReviewRailShift(journalScrollEl, {
    railEnabled: hasReviewContent,
    fullWidth: isFullWidth
  })
  // Full width keeps the reserved grid column; otherwise the rail hangs off the
  // centered content column and the group is shifted as a unit.
  const showGridRail = hasReviewContent && isFullWidth
  const showCanvasRail = hasReviewContent && !isFullWidth && !railHidden
  const handleContentChange = useCallback((_newBlocks: Block[]) => {}, [])
  const handleLinkClick = useCallback(
    (href: string) => window.open(href, '_blank', 'noopener,noreferrer'),
    []
  )

  /**
   * Scrolls to a heading by TEXT, which is all `[[#Heading]]` carries — a block
   * id is minted per document and means nothing to the link that named it.
   * Matching is trimmed and case-folded, and the first heading that matches
   * wins: the link records no level and no ordinal. Same rule as the note page.
   */
  const scrollToHeadingText = useCallback(
    (headingText: string, smooth: boolean): boolean => {
      const wanted = normalizeHeading(headingText)
      const match = headings.find((heading) => normalizeHeading(heading.text) === wanted)
      if (!match) return false
      return scrollToHeadingBlock(editorContainerRef.current, match.id, { smooth })
    },
    [headings]
  )

  const handleInternalLinkClick = useCallback(
    async (linkedNoteIdOrTitle: string) => {
      const target = linkedNoteIdOrTitle?.trim()
      if (!target) return

      // `[[#Heading]]` addresses the entry it is written in: no tab, no lookup,
      // just a jump inside content already on screen.
      const sameEntry = splitWikiTarget(target)
      if (sameEntry.heading && !sameEntry.note) {
        scrollToHeadingText(sameEntry.heading, !prefersReducedMotion)
        return
      }

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
            // The heading rides along; the note page does the positioning.
            openTab({
              type: 'note',
              title: resolution.title,
              icon: 'file-text',
              path: `/notes/${resolution.id}`,
              entityId: resolution.id,
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false,
              ...(resolution.heading && { viewState: { headingText: resolution.heading } })
            })
            break
          case 'create':
            toast.info(t('toast.noteNotFound', { target }))
            break
          case 'not-found':
            toast.error(t('toast.fileNotFound', { target }))
            break
        }
      } catch (err) {
        log.error('Failed to resolve wiki link:', err)
        toast.error(t('toast.openLinkedItemFailed'))
      }
    },
    [openTab, t, scrollToHeadingText, prefersReducedMotion]
  )

  const handleHeadingClick = useCallback(
    (headingId: string) => {
      // Scoped to this pane. `document.querySelector` returns whichever pane is
      // first in the DOM, so in split view the outline scrolled the pane the
      // user was not looking at.
      scrollToHeadingBlock(editorContainerRef.current, headingId, {
        smooth: !prefersReducedMotion
      })
    },
    [prefersReducedMotion]
  )

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
      const currentTags = entryTags
      if (tagToAdd && !currentTags.includes(tagToAdd.name)) {
        updateTags([...currentTags, tagToAdd.name])
      }
    },
    [availableTags, entryTags, updateTags]
  )

  const handleCreateTag = useCallback(
    (name: string, color: string) => {
      setPendingTagColors((prev) => new Map(prev).set(name.toLowerCase(), color))
      const currentTags = entryTags
      if (!currentTags.includes(name)) {
        updateTags([...currentTags, name])
      }
    },
    [entryTags, updateTags]
  )

  const handleRemoveTag = useCallback(
    (tagId: string) => {
      const currentTags = entryTags
      updateTags(currentTags.filter((t) => t !== tagId))
    },
    [entryTags, updateTags]
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
        id: backlinkId(bl.sourceId, bl.via),
        noteId: bl.sourceId,
        noteTitle: bl.sourceTitle,
        folder: folderPath,
        date: new Date(),
        mentions: (bl.contexts ?? []).map((ctx, i) => ({
          id: `mention-${bl.sourceId}-${i}`,
          snippet: ctx.snippet,
          linkStart: ctx.linkStart,
          linkEnd: ctx.linkEnd
        })),
        via: bl.via
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
          isPreview: false,
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
        const activeElement = document.activeElement
        if (isContentEditableElement(activeElement)) {
          e.preventDefault()
          activeElement.blur()
          return
        }

        if (currentViewState.type === 'month' || currentViewState.type === 'year') {
          e.preventDefault()
          navigateBack()
          return
        }
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (currentViewState.type !== 'day') return
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
        if (isKeyboardEditingElementFocused()) return

        e.preventDefault()
        if (e.key === 'ArrowLeft') {
          handlePreviousDay()
        } else {
          handleNextDay()
        }
        return
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [currentViewState, handleNextDay, handlePreviousDay, navigateBack])

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
        <main
          className={cn('flex-1 min-w-0 h-full relative flex flex-col')}
          style={{ '--note-chrome-height': '2.25rem' } as CSSProperties}
        >
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

          <div
            data-scrolled={isChromeScrolled || undefined}
            className="note-chrome absolute top-0 inset-x-0 z-30 flex items-center justify-between h-9 py-2 ps-6 pe-3 text-xs/4 [font-synthesis:none]"
          >
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
              onToggleFullWidth={toggleJournalWidth}
              onBookmarkToggle={(...args) => void toggleBookmark(...args)}
              onVersionHistory={() => setIsVersionHistoryOpen(true)}
              onExport={() => setIsExportDialogOpen(true)}
              onOpenSettings={() => openSettingsModal('journal')}
            />
          </div>

          <div
            ref={setJournalScrollRef}
            onScroll={handleChromeScroll}
            className="flex-1 overflow-y-auto overflow-x-visible"
          >
            <div
              ref={setMarqueeZoneEl}
              className="marquee-zone relative min-h-full w-full flex flex-col"
            >
              <div
                className={cn(
                  'mx-auto w-full min-h-full flex flex-col pt-15 pb-10 lg:pb-16 transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                  isFullWidth ? 'px-24 max-[920px]:px-8' : 'px-8 lg:px-12'
                )}
                style={{ maxWidth: isFullWidth ? '100%' : '64rem' }}
              >
                {/* No entrance animation: a day/view switch paints immediately */}
                <div
                  key={`${currentViewState.type}-${selectedDate}`}
                  className="flex flex-col flex-1 mx-auto w-full transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                >
                  {entryError && (
                    <div className="mb-4 px-4 py-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                      <span className="font-medium">{t('toast.errorPrefix')}</span> {entryError}
                    </div>
                  )}

                  {currentViewState.type === 'day' && (
                    <div
                      ref={setRailContentEl}
                      className={cn(
                        'w-full',
                        showGridRail
                          ? 'grid items-start gap-x-12 [grid-template-columns:minmax(0,1fr)_20rem] max-[920px]:grid-cols-1'
                          : 'mx-auto flex flex-col flex-1',
                        showCanvasRail && 'review-canvas'
                      )}
                      style={
                        {
                          maxWidth: isFullWidth ? '100%' : (journalContentWidth ?? '640px'),
                          ...railShiftStyle
                        } as CSSProperties
                      }
                    >
                      <div className="min-w-0 flex flex-col flex-1">
                        <div
                          className="group/metadata flex flex-col gap-2.5 pb-[15px]"
                          data-marquee-ignore
                        >
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
                            hideAddButton
                          />
                          {properties.length > 0 && (
                            <InfoSection
                              properties={properties}
                              newlyAddedPropertyId={newlyAddedPropertyId}
                              isExpanded={!propertiesCollapsed}
                              variant="embedded"
                              onToggleExpand={togglePropertiesCollapsed}
                              onPropertyChange={handlePropertyChange}
                              onPropertyNameChange={handlePropertyNameChange}
                              onPropertyOrderChange={handlePropertyOrderChange}
                              onAddProperty={handleAddPropertyWithExpand}
                              onDeleteProperty={handleDeleteProperty}
                              hideAddButton
                            />
                          )}

                          {/* Ghost affordance: add tag/property — fades in on hover/focus,
                              placed below the metadata so it never sits above the date */}
                          <GhostAffordanceRow
                            availableTags={availableTags}
                            recentTags={recentTags}
                            currentTagIds={journalTags.map((t) => t.id)}
                            onAddTag={handleAddTag}
                            onCreateTag={handleCreateTag}
                            onAddProperty={handleAddPropertyWithExpand}
                            existingNames={properties.map((p) => p.name)}
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
                              initialContent={review.editorInitialContent}
                              contentType="markdown"
                              externalContentRevision={externalUpdateCount}
                              placeholder={
                                selectedDate > today
                                  ? t('editor.placeholder.future')
                                  : isToday
                                    ? t('editor.placeholder.today')
                                    : t('editor.placeholder.past')
                              }
                              stickyToolbar={editorSettings.toolbarMode === 'sticky'}
                              spellCheck={editorSettings.spellCheck}
                              onContentChange={handleContentChange}
                              onMarkdownChange={handleMarkdownChange}
                              onHeadingsChange={handleHeadingsChange}
                              onLinkClick={handleLinkClick}
                              onInternalLinkClick={(...args) =>
                                void handleInternalLinkClick(...args)
                              }
                              focusAtEndRef={focusAtEndRef}
                              marqueeZoneEl={marqueeZoneEl}
                              review={{
                                plainMarkdown: review.plainMarkdown,
                                marks: review.marks,
                                hoveredMarkId: review.hoveredMarkId,
                                onEditorReady: review.handleEditorReady,
                                onAddComment: review.openCommentComposer,
                                getMarkdownSourceOffsetForEditorOffset:
                                  review.getMarkdownSourceOffsetForEditorOffset,
                                getEditorOffsetForMarkdownSourceOffset:
                                  review.getEditorOffsetForMarkdownSourceOffset,
                                onPersistCurrentMarkdown: review.persistCurrentMarkdown,
                                onPlainMarkdownChange: review.handlePlainMarkdownChange,
                                onHoveredMarkChange: review.setHoveredMarkId,
                                onMarkPositionsChange: review.setMarkPositions,
                                onReplaceMarksFromYjs: review.replaceMarksFromYjs
                              }}
                            />
                          )}
                          <ReviewBadgeLayer
                            review={review}
                            targetId={entry?.id}
                            containerRef={editorContainerRef}
                            active={railHidden}
                          />
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
                      </div>
                      {(showGridRail || showCanvasRail) && (
                        <div
                          data-journal-review-rail
                          data-marquee-ignore
                          className={
                            showGridRail
                              ? 'max-[920px]:hidden min-w-0 self-start'
                              : 'review-canvas-rail'
                          }
                        >
                          <ReviewRail review={review} targetId={entry?.id} />
                        </div>
                      )}
                    </div>
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
            noteTitle={journalNoteTitle}
          />
        )}
        {entry && (
          <VersionHistory
            open={isVersionHistoryOpen}
            onOpenChange={setIsVersionHistoryOpen}
            noteId={entry.id}
            noteTitle={journalNoteTitle}
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
