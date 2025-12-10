/**
 * Journal Page Component
 * Two-column layout with infinite scroll day cards and sticky sidebar
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import {
    DayCard,
    JournalCalendar,
    NoteDrawer,
    AIConnectionsPanel,
    TodaysNotesSection,
    type HeatmapEntry,
    type AIConnection
} from '@/components/journal'
import { useJournalScroll } from '@/hooks/use-journal-scroll'
import { useNotes, type Note } from '@/hooks/use-notes'
import { formatDateToISO, addDays } from '@/lib/journal-utils'

interface JournalPageProps {
    className?: string
}

// =============================================================================
// DUMMY AI CONNECTIONS DATA
// =============================================================================

const DUMMY_AI_CONNECTIONS: AIConnection[] = [
    {
        id: 'conn-1',
        type: 'journal',
        date: 'Nov 15, 2024',
        preview: 'Also discussed Project Alpha timeline with the team today. Sarah mentioned concerns about Q2 deadlines...',
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
    {
        id: 'conn-4',
        type: 'note',
        title: 'Product Roadmap Draft',
        preview: 'Initial draft of Q1-Q2 product roadmap with major milestones...',
        score: 0.72,
        matchedKeywords: ['roadmap', 'milestones'],
    },
]

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Main Journal Page with two-column layout
 * Left: Infinite scroll area for day cards
 * Right: Sticky sidebar with calendar, AI connections, and notes
 */
export function JournalPage({ className }: JournalPageProps): React.JSX.Element {
    const journal = useJournalScroll()
    const { getTodaysNotes, createNote, getNote } = useNotes()
    const todaysNotes = getTodaysNotes()

    // Drawer state
    const [drawerState, setDrawerState] = useState<{
        isOpen: boolean
        noteId: string | null
    }>({
        isOpen: false,
        noteId: null
    })

    // Focus Mode state
    const [viewMode, setViewMode] = useState<'full' | 'focus'>('full')

    // Restore Focus Mode from localStorage
    useEffect(() => {
        const saved = localStorage.getItem('memry_journal_view_mode')
        if (saved === 'focus') setViewMode('focus')
    }, [])

    // Save Focus Mode to localStorage
    useEffect(() => {
        localStorage.setItem('memry_journal_view_mode', viewMode)
    }, [viewMode])

    // Toggle Focus Mode
    const toggleFocusMode = useCallback(() => {
        setViewMode(prev => prev === 'focus' ? 'full' : 'focus')
    }, [])

    // Keyboard shortcuts for Focus Mode
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Escape exits Focus Mode
            if (e.key === 'Escape' && viewMode === 'focus') {
                setViewMode('full')
            }
            // Cmd/Ctrl + \ toggles Focus Mode
            if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
                e.preventDefault()
                toggleFocusMode()
            }
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [viewMode, toggleFocusMode])

    // Get the current note for drawer
    const currentNote = useMemo(() => {
        if (!drawerState.noteId) return null
        return getNote(drawerState.noteId) || null
    }, [drawerState.noteId, getNote])

    // Generate dummy heatmap data for demo
    const heatmapData = useMemo(() => {
        const data: HeatmapEntry[] = []
        const todayDate = new Date()
        // Generate random data for past 60 days
        for (let i = -60; i <= 0; i++) {
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

    // Handle calendar day click - scroll to that date
    const handleCalendarDayClick = useCallback((date: string) => {
        journal.scrollToDate(date)
    }, [journal])

    // Handle note click - open drawer
    const handleNoteClick = useCallback((noteId: string) => {
        setDrawerState({ isOpen: true, noteId })
    }, [])

    // Close drawer
    const handleCloseDrawer = useCallback(() => {
        setDrawerState({ isOpen: false, noteId: null })
    }, [])

    // Open note in full page (placeholder)
    const handleOpenFullPage = useCallback((noteId: string) => {
        console.log('Open note in full page:', noteId)
        // TODO: Navigate to full page note editor
    }, [])

    return (
        <div
            className={cn(
                "flex h-full w-full overflow-hidden transition-all duration-300",
                viewMode === 'focus' && "justify-center",
                className
            )}
        >
            {/* Left Section - Scrollable Day Cards Area */}
            <JournalScrollArea
                journal={journal}
                viewMode={viewMode}
                onToggleFocusMode={toggleFocusMode}
            />

            {/* Right Section - Sticky Sidebar (hidden when drawer is open OR in focus mode) */}
            {viewMode === 'full' && (
                <JournalSidebar
                    activeDate={journal.state.activeDate}
                    onTodayClick={() => journal.scrollToToday(true)}
                    onDayClick={handleCalendarDayClick}
                    heatmapData={heatmapData}
                    isHidden={drawerState.isOpen}
                    todaysNotes={todaysNotes}
                    activeNoteId={drawerState.noteId}
                    onNoteClick={handleNoteClick}
                    onCreateNote={(title) => {
                        const note = createNote(title)
                        handleNoteClick(note.id)
                    }}
                />
            )}

            {/* Note Drawer */}
            <NoteDrawer
                note={currentNote}
                isOpen={drawerState.isOpen}
                onClose={handleCloseDrawer}
                onOpenFullPage={handleOpenFullPage}
            />
        </div>
    )
}

// =============================================================================
// SCROLL AREA
// =============================================================================

interface JournalScrollAreaProps {
    journal: ReturnType<typeof useJournalScroll>
    viewMode: 'full' | 'focus'
    onToggleFocusMode: () => void
}

function JournalScrollArea({
    journal,
    viewMode,
    onToggleFocusMode,
}: JournalScrollAreaProps): React.JSX.Element {
    const { state, scrollContainerRef, registerDayCardRef, getOpacity } = journal

    // Create ref callback for each day card
    const createRefCallback = useCallback((date: string) => {
        return (element: HTMLDivElement | null) => {
            registerDayCardRef(date, element)
        }
    }, [registerDayCardRef])

    return (
        <div
            ref={scrollContainerRef}
            className={cn(
                // Layout
                "flex-1 min-w-0",
                // Responsive width (only in full mode)
                viewMode === 'full' ? [
                    "w-[65%] min-w-[600px]",
                    "max-lg:w-[60%] max-lg:min-w-[500px]",
                    "max-md:w-full max-md:min-w-0",
                ] : "w-full",
                // Scrolling
                "overflow-y-auto overflow-x-hidden",
                // Hide scrollbar but keep functionality
                "scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700",
                // Padding
                "px-6 py-10",
                // Transition
                "transition-all duration-300"
            )}
        >
            {/* Loading indicator for past days */}
            {state.isLoadingPast && (
                <div className="flex items-center justify-center py-4 mb-4">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Loading past days...</span>
                </div>
            )}

            {/* Day Cards Container */}
            <div className={cn(
                "mx-auto flex flex-col gap-6",
                viewMode === 'focus' ? "max-w-[700px]" : "max-w-[800px]"
            )}>
                {state.days.map((day) => (
                    <DayCard
                        key={day.date}
                        ref={createRefCallback(day.date)}
                        date={day.date}
                        isActive={day.date === state.activeDate}
                        isToday={day.isToday}
                        isFuture={day.isFuture}
                        opacity={getOpacity(day.date)}
                        viewMode={viewMode}
                        onToggleFocusMode={onToggleFocusMode}
                        // Hide sections in focus mode
                        calendarEvents={viewMode === 'focus' ? [] : (day.isToday ? [
                            { id: '1', time: '9:00 AM', title: 'Team Standup', attendeeCount: 5 },
                            { id: '2', time: '2:00 PM', title: 'Design Review', attendeeCount: 3 },
                            { id: '3', time: '4:30 PM', title: '1:1 with Sarah' },
                        ] : [])}
                        overdueTasks={viewMode === 'focus' ? [] : (day.isToday ? [
                            { id: '1', title: 'Review PRs', dueDate: 'Dec 8', completed: false },
                            { id: '2', title: 'Update documentation', dueDate: 'Dec 8', completed: false },
                            { id: '3', title: 'Send invoice to client', dueDate: 'Dec 6', completed: false },
                        ] : [])}
                    />
                ))}
            </div>

            {/* Loading indicator for future days */}
            {state.isLoadingFuture && (
                <div className="flex items-center justify-center py-4 mt-4">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Loading future days...</span>
                </div>
            )}
        </div>
    )
}

// =============================================================================
// SIDEBAR
// =============================================================================

interface JournalSidebarProps {
    activeDate: string
    onTodayClick: () => void
    onDayClick: (date: string) => void
    heatmapData: HeatmapEntry[]
    isHidden?: boolean
    todaysNotes: Note[]
    activeNoteId: string | null
    onNoteClick: (noteId: string) => void
    onCreateNote: (title: string) => void
}

function JournalSidebar({
    activeDate,
    onTodayClick,
    onDayClick,
    heatmapData,
    isHidden = false,
    todaysNotes,
    activeNoteId,
    onNoteClick,
    onCreateNote,
}: JournalSidebarProps): React.JSX.Element {
    return (
        <aside
            className={cn(
                // Layout
                "shrink-0",
                // Responsive width
                "w-[35%] min-w-[320px] max-w-[400px]",
                "max-lg:w-[40%] max-lg:min-w-[300px]",
                // Hide on mobile (will become drawer in future)
                "max-md:hidden",
                // Positioning
                "sticky top-0 h-full",
                // Scrolling for internal content
                "overflow-y-auto",
                // Styling
                "border-l border-border/50",
                "bg-muted/30",
                // Padding
                "p-6",
                // Spacing between sections
                "flex flex-col gap-5",
                // Hide when drawer is open
                isHidden && "invisible"
            )}
        >
            {/* Calendar Section */}
            <JournalCalendar
                selectedDate={activeDate}
                onDayClick={onDayClick}
                onTodayClick={onTodayClick}
                heatmapData={heatmapData}
            />

            {/* AI Connections Panel */}
            <AIConnectionsPanel
                connections={DUMMY_AI_CONNECTIONS}
                isLoading={false}
                onConnectionClick={(conn) => {
                    console.log('Connection clicked:', conn)
                    // TODO: Navigate to connection
                }}
                onRefresh={() => {
                    console.log('Refresh connections')
                    // TODO: Re-analyze connections
                }}
            />

            {/* Today's Notes Section */}
            <TodaysNotesSection
                notes={todaysNotes}
                onNoteClick={onNoteClick}
                activeNoteId={activeNoteId}
                onCreate={onCreateNote}
            />
        </aside>
    )
}

export default JournalPage
