/**
 * Day Card Component
 * Renders a single day in the journal infinite scroll with full structure
 */

import { forwardRef, memo, useMemo } from 'react'
import { Calendar, Clock, Sun, Sunrise, Sunset, Moon, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDayHeader, getTimeBasedGreeting, getSpecialDayLabel } from '@/lib/journal-utils'
import { CollapsibleSection, JournalSection } from './collapsible-section'

// =============================================================================
// TYPES
// =============================================================================

export interface CalendarEvent {
    id: string
    time: string
    title: string
    attendeeCount?: number
}

export interface OverdueTask {
    id: string
    title: string
    dueDate: string
    completed: boolean
}

export interface DayCardProps {
    /** Date in ISO format (YYYY-MM-DD) */
    date: string
    /** Whether this day is currently active (centered in viewport) */
    isActive: boolean
    /** Whether this is today */
    isToday: boolean
    /** Whether this is a future date */
    isFuture: boolean
    /** Opacity based on distance from active day */
    opacity: number
    /** Calendar events for this day */
    calendarEvents?: CalendarEvent[]
    /** Overdue tasks for this day */
    overdueTasks?: OverdueTask[]
    /** Additional CSS classes */
    className?: string
}

// =============================================================================
// GREETING ICON MAPPING
// =============================================================================

function getGreetingIcon(icon: string): React.ReactNode {
    switch (icon) {
        case '🌅': return <Sunrise className="size-4 text-amber-500" />
        case '☀️': return <Sun className="size-4 text-yellow-500" />
        case '🌆': return <Sunset className="size-4 text-orange-500" />
        case '🌙': return <Moon className="size-4 text-indigo-400" />
        default: return <Sun className="size-4 text-yellow-500" />
    }
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Day Card - displays a single day with full structure:
 * - Header with date, day name, greeting (for today)
 * - Collapsible Calendar Events section
 * - Collapsible Overdue Tasks section
 * - Journal editor placeholder
 */
export const DayCard = memo(forwardRef<HTMLDivElement, DayCardProps>(({
    date,
    isActive,
    isToday,
    isFuture,
    opacity,
    calendarEvents = [],
    overdueTasks = [],
    className,
}, ref) => {
    const header = formatDayHeader(date)
    const greeting = useMemo(() => isToday ? getTimeBasedGreeting() : null, [isToday])
    const specialLabel = getSpecialDayLabel(date)

    return (
        <div
            ref={ref}
            data-date={date}
            style={{ opacity }}
            className={cn(
                // Base styling
                "rounded-xl transition-all duration-150",
                // Background
                "bg-card",
                // Border (solid for past, dashed for future)
                isFuture
                    ? "border border-dashed border-border/60"
                    : "border border-border/40",
                // Active state
                isActive && [
                    "border-2",
                    isFuture
                        ? "border-dashed border-primary/40"
                        : "border-primary/30",
                    "shadow-lg shadow-primary/5",
                ],
                className
            )}
        >
            {/* Header */}
            <DayCardHeader
                dateStr={header.dateStr}
                dayName={header.dayName}
                specialLabel={specialLabel}
                greeting={greeting}
                isActive={isActive}
                isFuture={isFuture}
            />

            {/* Sections Container */}
            <div className="p-4 flex flex-col gap-4">
                {/* Calendar Events - only show if has events */}
                {calendarEvents.length > 0 && (
                    <CollapsibleSection
                        icon={<Calendar className="size-4 text-accent-blue" />}
                        title="Calendar Events"
                        count={calendarEvents.length}
                        countLabel={calendarEvents.length === 1 ? 'meeting' : 'meetings'}
                    >
                        <div className="flex flex-col gap-2 mt-2">
                            {calendarEvents.map(event => (
                                <div
                                    key={event.id}
                                    className="flex items-start justify-between p-3 rounded-md bg-background/50"
                                >
                                    <div>
                                        <p className="text-xs text-muted-foreground">{event.time}</p>
                                        <p className="text-sm font-medium text-foreground">{event.title}</p>
                                    </div>
                                    {event.attendeeCount && (
                                        <span className="text-xs text-muted-foreground">
                                            ({event.attendeeCount} people)
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </CollapsibleSection>
                )}

                {/* Overdue Tasks - only show if has tasks (and not future) */}
                {!isFuture && overdueTasks.length > 0 && (
                    <CollapsibleSection
                        icon={<Clock className="size-4 text-accent-orange" />}
                        title="Overdue Tasks"
                        count={overdueTasks.length}
                        countLabel={overdueTasks.length === 1 ? 'task' : 'tasks'}
                    >
                        <div className="flex flex-col gap-1 mt-2">
                            {overdueTasks.map(task => (
                                <div
                                    key={task.id}
                                    className="flex items-center justify-between py-2 px-1"
                                >
                                    <div className="flex items-center gap-2">
                                        <Square className="size-4 text-muted-foreground" />
                                        <span className="text-sm text-foreground">{task.title}</span>
                                    </div>
                                    <span className="text-xs text-muted-foreground">{task.dueDate}</span>
                                </div>
                            ))}
                        </div>
                    </CollapsibleSection>
                )}

                {/* Journal Section - always visible */}
                <JournalSection
                    isActive={isActive}
                    placeholder={isFuture ? "Plan your day..." : "Start writing..."}
                />
            </div>
        </div>
    )
}))

DayCard.displayName = 'DayCard'

// =============================================================================
// HEADER COMPONENT
// =============================================================================

interface DayCardHeaderProps {
    dateStr: string
    dayName: string
    specialLabel: string | null
    greeting: { greeting: string; icon: string } | null
    isActive: boolean
    isFuture: boolean
}

function DayCardHeader({
    dateStr,
    dayName,
    specialLabel,
    greeting,
    isActive,
    isFuture,
}: DayCardHeaderProps): React.JSX.Element {
    return (
        <header className={cn(
            "px-6 py-4",
            "border-b border-border/30",
            "flex items-start justify-between"
        )}>
            {/* Left side - Date info */}
            <div className="flex flex-col gap-1">
                {/* Date */}
                <h2 className={cn(
                    "text-lg font-semibold",
                    isActive ? "text-foreground" : "text-foreground/80",
                    isFuture && !isActive && "text-foreground/60"
                )}>
                    {dateStr}
                </h2>

                {/* Day name + special label */}
                <div className="flex items-center gap-2">
                    <span className={cn(
                        "text-xs uppercase tracking-wide font-medium",
                        isActive ? "text-muted-foreground" : "text-muted-foreground/70"
                    )}>
                        {dayName}
                    </span>

                    {specialLabel && (
                        <>
                            <span className="text-muted-foreground/50">•</span>
                            <span className={cn(
                                "text-xs font-medium",
                                specialLabel === 'Today'
                                    ? "text-primary"
                                    : "text-muted-foreground"
                            )}>
                                {specialLabel}
                            </span>
                        </>
                    )}
                </div>
            </div>

            {/* Right side - Greeting (only for today) */}
            {greeting && (
                <div className="flex items-center gap-2 text-sm">
                    {getGreetingIcon(greeting.icon)}
                    <span className="text-muted-foreground">{greeting.greeting}</span>
                </div>
            )}
        </header>
    )
}

export default DayCard
