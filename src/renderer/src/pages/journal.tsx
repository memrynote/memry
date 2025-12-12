/**
 * Journal Page - Redesigned
 * Clean 2-column layout with single-day focus
 * Left: Large journal writing area (using BlockNote editor)
 * Right: Mini calendar + Schedule + Tasks + AI Connections
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Sun, Sunrise, Sunset, Moon, Maximize2, Minimize2, ChevronLeft, ChevronRight } from 'lucide-react'
import { useSidebar } from '@/components/ui/sidebar'
import {
    JournalCalendar,
    AIConnectionsPanel,
    DayContextSidebar,
    DateBreadcrumb,
    JournalMonthView,
    JournalYearView,
    type HeatmapEntry,
    type AIConnection,
    type ScheduleEvent,
    type DayTask,
    type JournalViewState,
} from '@/components/journal'
import { ContentArea, type Block } from '@/components/note'
import { BacklinksSection, type Backlink } from '@/components/note/backlinks'
import { Button } from '@/components/ui/button'
import {
    formatDateToISO,
    formatDateParts,
    getTodayString,
    parseISODate,
    addDays,
    getTimeBasedGreeting,
    getMonthStats,
} from '@/lib/journal-utils'

// =============================================================================
// DUMMY DATA
// =============================================================================

const DUMMY_AI_CONNECTIONS: AIConnection[] = [
    {
        id: 'conn-1',
        type: 'journal',
        date: 'Nov 15, 2024',
        preview: 'Also discussed Project Alpha timeline with the team today. Sarah mentioned concerns about...',
        score: 0.92,
        matchedKeywords: ['Project Alpha', 'timeline', 'team'],
    },
    {
        id: 'conn-2',
        type: 'note',
        title: 'Meeting Notes - Q3 Planning',
        preview: 'Key decisions about resource allocation and hiring plans for the next quarter...',
        score: 0.87,
        matchedKeywords: ['decisions', 'hiring', 'Q3'],
    },
    {
        id: 'conn-3',
        type: 'journal',
        date: 'Oct 28, 2024',
        preview: 'Feeling optimistic about the project direction after today\'s review session...',
        score: 0.78,
        matchedKeywords: ['project', 'review'],
    },
]

const DUMMY_EVENTS: ScheduleEvent[] = [
    { id: '1', time: '9:00', title: 'Team Standup', type: 'meeting', attendeeCount: 5 },
    { id: '2', time: '11:00', title: 'Design Review', type: 'meeting', attendeeCount: 3 },
    { id: '3', time: '14:00', title: 'Client Call', type: 'meeting', attendeeCount: 2 },
    { id: '4', time: '16:00', title: 'Deep Work', type: 'focus' },
]

const DUMMY_TASKS: DayTask[] = [
    { id: '1', title: 'Review PRs from team', completed: false, priority: 'high' },
    { id: '2', title: 'Update documentation', completed: false, priority: 'medium' },
    { id: '3', title: 'Send invoice to client', completed: false, priority: 'urgent', isOverdue: true },
    { id: '4', title: 'Weekly report', completed: true },
]

const DUMMY_JOURNAL_BACKLINKS: Backlink[] = [
    {
        id: 'jbl-1',
        noteId: 'note-101',
        noteTitle: 'Project Alpha Planning',
        folder: 'Projects',
        date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        mentions: [
            {
                id: 'jm-1',
                snippet: '...as discussed in my [[journal entry]], the timeline needs adjustment for Q1...',
                linkStart: 20,
                linkEnd: 35,
            },
        ],
    },
    {
        id: 'jbl-2',
        noteId: 'note-102',
        noteTitle: 'Weekly Retrospective',
        folder: 'Work',
        date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        mentions: [
            {
                id: 'jm-2',
                snippet: '...referencing thoughts from [[this day]] about team productivity improvements...',
                linkStart: 28,
                linkEnd: 38,
            },
        ],
    },
    {
        id: 'jbl-3',
        noteId: 'note-103',
        noteTitle: 'Personal Goals 2024',
        folder: 'Personal',
        date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        mentions: [
            {
                id: 'jm-3',
                snippet: '...the reflections from [[December 13]] helped clarify my priorities...',
                linkStart: 24,
                linkEnd: 36,
            },
            {
                id: 'jm-4',
                snippet: '...mentioned in [[journal]] that I want to focus more on deep work...',
                linkStart: 16,
                linkEnd: 23,
            },
        ],
    },
]

// =============================================================================
// GREETING HELPERS
// =============================================================================

function getGreetingIcon(icon: string): React.ReactNode {
    switch (icon) {
        case '🌅': return <Sunrise className="size-5 text-amber-500" />
        case '☀️': return <Sun className="size-5 text-yellow-500" />
        case '🌆': return <Sunset className="size-5 text-orange-500" />
        case '🌙': return <Moon className="size-5 text-indigo-400" />
        default: return <Sun className="size-5 text-yellow-500" />
    }
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

interface JournalPageProps {
    className?: string
}

export function JournalPage({ className }: JournalPageProps): React.JSX.Element {
    const today = getTodayString()
    const [selectedDate, setSelectedDate] = useState(today)
    const [focusMode, setFocusMode] = useState(false)

    // Sync left sidebar with focus mode (hide when focus mode is on)
    const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()
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

    // View state for breadcrumb navigation
    const [viewState, setViewState] = useState<JournalViewState>({ type: 'day', date: selectedDate })

    // BlockNote editor state
    const [_blocks, setBlocks] = useState<Block[]>([])

    // Calculate if selected date is today
    const isToday = selectedDate === today
    const selectedDateObj = parseISODate(selectedDate)

    // Format date for display
    const dateDisplay = useMemo(() => {
        const date = selectedDateObj
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' })
        const monthDay = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

        return { dayName, monthDay }
    }, [selectedDateObj])

    // Get date parts for current selected date
    const dateParts = useMemo(() => formatDateParts(selectedDate), [selectedDate])

    // Get greeting for today
    const greeting = useMemo(() => isToday ? getTimeBasedGreeting() : null, [isToday])

    // Generate dummy heatmap data (extended to cover full year for year view)
    const heatmapData = useMemo(() => {
        const data: HeatmapEntry[] = []
        const todayDate = new Date()
        // Generate data for the past 365 days to cover full year view
        for (let i = -365; i <= 0; i++) {
            const date = addDays(todayDate, i)
            const dateStr = formatDateToISO(date)
            const charCount = Math.random() > 0.3 ? Math.floor(Math.random() * 1500) : 0
            const level = charCount === 0 ? 0
                : charCount <= 100 ? 1
                    : charCount <= 500 ? 2
                        : charCount <= 1000 ? 3
                            : 4
            data.push({ date: dateStr, characterCount: charCount, level: level as 0 | 1 | 2 | 3 | 4 })
        }
        return data
    }, [])

    // Generate month stats for year view
    const monthStats = useMemo(() => {
        const year = viewState.type === 'year' ? viewState.year : dateParts.year
        return getMonthStats(year, heatmapData)
    }, [viewState, dateParts.year, heatmapData])

    // Generate dummy entry data for month view (preview text)
    const monthEntries = useMemo(() => {
        const entries = new Map<string, { preview: string; characterCount: number }>()
        heatmapData.forEach(entry => {
            if (entry.characterCount > 0) {
                entries.set(entry.date, {
                    preview: 'Sample journal entry content for this day...',
                    characterCount: entry.characterCount,
                })
            }
        })
        return entries
    }, [heatmapData])

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
    const handleDayClick = useCallback((date: string) => {
        navigateToDay(date)
    }, [navigateToDay])

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

    // BlockNote content handlers
    const handleContentChange = useCallback((newBlocks: Block[]) => {
        setBlocks(newBlocks)
        // TODO: Save journal content for selectedDate
    }, [])

    const handleLinkClick = useCallback((href: string) => {
        window.open(href, '_blank', 'noopener,noreferrer')
    }, [])

    const handleInternalLinkClick = useCallback((noteId: string) => {
        console.log('Navigate to note:', noteId)
        // TODO: Navigate to linked note
    }, [])

    const handleBacklinkClick = useCallback((noteId: string) => {
        console.log('Backlink clicked, navigate to note:', noteId)
        // TODO: Navigate to linked note
    }, [])

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
                setFocusMode(prev => !prev)
            }
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [focusMode, viewState, navigateBack])

    // Persist focus mode
    useEffect(() => {
        const saved = localStorage.getItem('memry_journal_focus_mode')
        if (saved === 'true') setFocusMode(true)
    }, [])

    useEffect(() => {
        localStorage.setItem('memry_journal_focus_mode', focusMode.toString())
    }, [focusMode])

    return (
        <div
            className={cn(
                "flex h-full w-full overflow-hidden bg-background",
                "transition-all duration-300",
                className
            )}
        >
            {/* Main Content Area - Journal Writing */}
            <main className={cn(
                "flex-1 min-w-0 h-full overflow-y-auto",
                "transition-all duration-300",
                focusMode ? "px-8" : "px-6 lg:px-10"
            )}>
                <div className={cn(
                    "mx-auto h-full flex flex-col",
                    focusMode ? "max-w-3xl" : "max-w-4xl",
                    "py-8 lg:py-12"
                )}>
                    {/* Header */}
                    <header className="mb-8">
                        {/* Date & Greeting Row */}
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                {/* Clickable Date Breadcrumb */}
                                <DateBreadcrumb
                                    viewState={viewState}
                                    onMonthClick={navigateToMonth}
                                    onYearClick={navigateToYear}
                                    onBackClick={navigateBack}
                                    className="mb-1"
                                />

                                {/* Day name + Today label + Navigation (only in day view) */}
                                {viewState.type === 'day' && (
                                    <div className="flex items-center gap-2">
                                        {/* Day Navigation Arrows */}
                                        <div className="flex items-center gap-0.5">
                                            <button
                                                type="button"
                                                onClick={handlePreviousDay}
                                                aria-label="Previous day"
                                                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                                            >
                                                <ChevronLeft className="size-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleNextDay}
                                                aria-label="Next day"
                                                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                                            >
                                                <ChevronRight className="size-4" />
                                            </button>
                                        </div>
                                        <span className="text-sm text-muted-foreground uppercase tracking-wide">
                                            {dateDisplay.dayName}
                                        </span>
                                        {isToday && (
                                            <>
                                                <span className="text-muted-foreground/50">·</span>
                                                <span className="text-sm font-medium text-primary">
                                                    Today
                                                </span>
                                            </>
                                        )}
                                    </div>
                                )}

                                {/* Subtitle for month/year views */}
                                {viewState.type === 'month' && (
                                    <p className="text-sm text-muted-foreground">
                                        All journal entries for this month
                                    </p>
                                )}
                                {viewState.type === 'year' && (
                                    <p className="text-sm text-muted-foreground">
                                        Select a month to view entries
                                    </p>
                                )}
                            </div>

                            {/* Right side - Greeting & Focus Toggle (only in day view) */}
                            {viewState.type === 'day' && (
                                <div className="flex items-center gap-3">
                                    {/* Greeting (only for today) */}
                                    {greeting && !focusMode && (
                                        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50">
                                            {getGreetingIcon(greeting.icon)}
                                            <span className="text-sm text-muted-foreground">
                                                {greeting.greeting}
                                            </span>
                                        </div>
                                    )}

                                    {/* Focus Mode Toggle */}
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={cn(
                                            "size-9",
                                            focusMode && "bg-muted"
                                        )}
                                        onClick={() => setFocusMode(!focusMode)}
                                        title={focusMode ? "Exit Focus Mode (Esc)" : "Enter Focus Mode (⌘\\)"}
                                    >
                                        {focusMode ? (
                                            <Minimize2 className="size-4" />
                                        ) : (
                                            <Maximize2 className="size-4" />
                                        )}
                                    </Button>
                                </div>
                            )}
                        </div>
                    </header>

                    {/* Conditional Content Rendering */}
                    {viewState.type === 'day' && (
                        /* Journal Editor - Main Writing Area (BlockNote) + Backlinks */
                        <>
                            <div
                                className="editor-click-area flex-1"
                                onMouseDown={(e) => {
                                    const target = e.target as HTMLElement
                                    // If clicking directly on editable text, let it work normally
                                    if (target.closest('[contenteditable="true"]')?.contains(target) &&
                                        target.closest('.bn-block-content')) {
                                        return
                                    }
                                    // If clicking on buttons or links, let it work normally
                                    if (target.closest('button, a, input')) {
                                        return
                                    }
                                    // Focus editor for all other clicks (empty areas)
                                    const editor = (e.currentTarget as HTMLElement).querySelector('.bn-editor [contenteditable="true"]') as HTMLElement
                                    if (editor) {
                                        e.preventDefault()
                                        editor.focus()
                                    }
                                }}
                            >
                                <ContentArea
                                    placeholder={
                                        selectedDate > today
                                            ? "Plan your day..."
                                            : "Start writing..."
                                    }
                                    onContentChange={handleContentChange}
                                    onLinkClick={handleLinkClick}
                                    onInternalLinkClick={handleInternalLinkClick}
                                />
                            </div>

                            {/* Backlinks Section */}
                            <BacklinksSection
                                backlinks={DUMMY_JOURNAL_BACKLINKS}
                                isLoading={false}
                                initialCount={5}
                                collapsible={true}
                                onBacklinkClick={handleBacklinkClick}
                            />
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
            </main>

            {/* Right Sidebar - Context Panel (with collapse animation) */}
            <aside className={cn(
                "shrink-0 h-full overflow-hidden",
                "border-l border-border/40",
                "bg-muted/20",
                // Hide on smaller screens
                "hidden lg:block",
                // Smooth transition for width and opacity (matching left sidebar)
                "transition-[width,opacity] duration-200 ease-linear",
                // Collapsed state
                focusMode || viewState.type !== 'day'
                    ? "w-0 opacity-0 border-l-0"
                    : "w-[320px] lg:w-[360px] opacity-100"
            )}>
                <div className={cn(
                    "h-full overflow-y-auto",
                    "p-4 lg:p-5",
                    "flex flex-col gap-4",
                    "w-[320px] lg:w-[360px]",
                    // Fade content
                    "transition-opacity duration-200 ease-linear",
                    focusMode || viewState.type !== 'day' ? "opacity-0" : "opacity-100"
                )}>
                    {/* Mini Calendar */}
                    <JournalCalendar
                        selectedDate={selectedDate}
                        onDayClick={handleDayClick}
                        onTodayClick={handleTodayClick}
                        heatmapData={heatmapData}
                    />

                    {/* Day Context - Events & Tasks */}
                    <DayContextSidebar
                        events={isToday ? DUMMY_EVENTS : []}
                        tasks={isToday ? DUMMY_TASKS : []}
                        overdueCount={isToday ? 1 : 0}
                        isToday={isToday}
                        onTaskClick={(id) => console.log('Task clicked:', id)}
                        onTaskToggle={(id) => console.log('Task toggled:', id)}
                        onEventClick={(id) => console.log('Event clicked:', id)}
                    />

                    {/* AI Connections */}
                    <AIConnectionsPanel
                        connections={DUMMY_AI_CONNECTIONS}
                        isLoading={false}
                        onConnectionClick={(conn) => console.log('Connection clicked:', conn)}
                        onRefresh={() => console.log('Refresh connections')}
                        maxItems={3}
                    />
                </div>
            </aside>
        </div>
    )
}

export default JournalPage
