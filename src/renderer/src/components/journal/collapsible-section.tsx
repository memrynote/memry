/**
 * Collapsible Section Component
 * Reusable collapsible section for day card (Calendar Events, Overdue Tasks)
 */

import { useState, memo } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CollapsibleSectionProps {
    /** Section icon */
    icon: React.ReactNode
    /** Section title */
    title: string
    /** Count badge (number of items) */
    count?: number
    /** Count label (e.g., "meetings", "tasks") */
    countLabel?: string
    /** Initial collapsed state */
    defaultCollapsed?: boolean
    /** Section content */
    children: React.ReactNode
    /** Additional CSS classes */
    className?: string
}

/**
 * Collapsible section with header toggle
 * Used for Calendar Events and Overdue Tasks in day cards
 */
export const CollapsibleSection = memo(function CollapsibleSection({
    icon,
    title,
    count,
    countLabel,
    defaultCollapsed = true,
    children,
    className,
}: CollapsibleSectionProps): React.JSX.Element {
    const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)

    const toggleCollapse = () => setIsCollapsed(prev => !prev)

    return (
        <div className={cn("rounded-lg border border-border/40 bg-muted/20", className)}>
            {/* Header - always visible */}
            <button
                type="button"
                onClick={toggleCollapse}
                className={cn(
                    "w-full flex items-center justify-between px-4 py-3",
                    "hover:bg-muted/40 transition-colors",
                    "text-left"
                )}
            >
                <div className="flex items-center gap-2">
                    {icon}
                    <span className="text-sm font-medium text-foreground">{title}</span>
                </div>

                <div className="flex items-center gap-2">
                    {count !== undefined && count > 0 && (
                        <span className="text-xs text-muted-foreground">
                            {count} {countLabel || 'items'}
                        </span>
                    )}
                    {isCollapsed ? (
                        <ChevronDown className="size-4 text-muted-foreground" />
                    ) : (
                        <ChevronUp className="size-4 text-muted-foreground" />
                    )}
                </div>
            </button>

            {/* Content - collapsible */}
            {!isCollapsed && (
                <div className="px-4 pb-4 pt-1 border-t border-border/30">
                    {children}
                </div>
            )}
        </div>
    )
})

// =============================================================================
// NOTES SECTION (Always visible, not collapsible)
// =============================================================================

export interface NotesSectionProps {
    /** Notes for this day */
    notes: { id: string; time: string; title: string; preview?: string }[]
    /** Callback when a note is clicked */
    onNoteClick?: (noteId: string) => void
}

export const NotesSection = memo(function NotesSection({
    notes,
    onNoteClick,
}: NotesSectionProps): React.JSX.Element {
    return (
        <div className="rounded-lg border border-border/40 bg-muted/20">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border/30">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-base">📝</span>
                        <span className="text-sm font-medium text-foreground">Notes</span>
                    </div>
                    {notes.length > 0 && (
                        <span className="text-xs text-muted-foreground">({notes.length})</span>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="p-4">
                {notes.length > 0 ? (
                    <div className="flex flex-col gap-2">
                        {notes.map(note => (
                            <button
                                key={note.id}
                                type="button"
                                onClick={() => onNoteClick?.(note.id)}
                                className={cn(
                                    "flex flex-col gap-1 p-3 rounded-md",
                                    "bg-background/50 hover:bg-background transition-colors",
                                    "text-left w-full group"
                                )}
                            >
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">{note.time}</span>
                                    <span className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">→</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-sm">📄</span>
                                    <span className="text-sm font-medium text-foreground">{note.title}</span>
                                </div>
                                {note.preview && (
                                    <p className="text-xs text-muted-foreground line-clamp-1 pl-6">
                                        "{note.preview}"
                                    </p>
                                )}
                            </button>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                        No notes from this day
                    </p>
                )}
            </div>
        </div>
    )
})

// =============================================================================
// JOURNAL SECTION (Always visible, editor placeholder)
// =============================================================================

export interface JournalSectionProps {
    /** Whether this is an active/focused day */
    isActive?: boolean
    /** Placeholder text */
    placeholder?: string
}

export const JournalSection = memo(function JournalSection({
    isActive = false,
    placeholder = "Start writing...",
}: JournalSectionProps): React.JSX.Element {
    return (
        <div className="rounded-lg border border-border/40 bg-muted/20">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border/30">
                <div className="flex items-center gap-2">
                    <span className="text-base">✍️</span>
                    <span className="text-sm font-medium text-foreground">Journal</span>
                </div>
            </div>

            {/* Editor placeholder */}
            <div className="p-4">
                <div className={cn(
                    "rounded-lg border bg-background",
                    isActive ? "border-border" : "border-border/50"
                )}>
                    {/* Content area */}
                    <div className="p-4 min-h-[120px]">
                        <p className="text-sm text-muted-foreground italic">{placeholder}</p>
                    </div>

                    {/* Toolbar placeholder */}
                    <div className="px-4 py-2 border-t border-border/30 flex items-center justify-between">
                        <div className="flex items-center gap-1">
                            <ToolbarButton>B</ToolbarButton>
                            <ToolbarButton>I</ToolbarButton>
                            <ToolbarButton>U</ToolbarButton>
                            <ToolbarButton>S</ToolbarButton>
                            <span className="w-px h-4 bg-border mx-1" />
                            <ToolbarButton>🔗</ToolbarButton>
                            <ToolbarButton>📷</ToolbarButton>
                        </div>
                        <div className="flex items-center gap-1">
                            <ToolbarButton>⋮</ToolbarButton>
                            <ToolbarButton title="Focus mode">◱</ToolbarButton>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
})

// Helper component for toolbar buttons
function ToolbarButton({
    children,
    title
}: {
    children: React.ReactNode
    title?: string
}): React.JSX.Element {
    return (
        <button
            type="button"
            title={title}
            className={cn(
                "size-7 flex items-center justify-center rounded",
                "text-xs text-muted-foreground",
                "hover:bg-muted/50 transition-colors"
            )}
        >
            {children}
        </button>
    )
}

export default CollapsibleSection
