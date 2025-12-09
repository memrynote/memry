/**
 * Journal Page Component
 * Two-column layout with scrollable day cards area and sticky sidebar
 */

import { cn } from "@/lib/utils"
import { Calendar, Sparkles, FileText } from "lucide-react"

interface JournalPageProps {
    className?: string
}

/**
 * Main Journal Page with two-column layout
 * Left: Scrollable area for day cards (infinite scroll)
 * Right: Sticky sidebar with calendar, AI connections, and notes
 */
export function JournalPage({ className }: JournalPageProps): React.JSX.Element {
    return (
        <div
            className={cn(
                "flex h-full w-full overflow-hidden",
                className
            )}
        >
            {/* Left Section - Scrollable Day Cards Area */}
            <JournalScrollArea />

            {/* Right Section - Sticky Sidebar */}
            <JournalSidebar />
        </div>
    )
}

/**
 * Left section - Scrollable container for day cards
 */
function JournalScrollArea(): React.JSX.Element {
    return (
        <div
            className={cn(
                // Layout
                "flex-1 min-w-0",
                // Responsive width
                "w-[65%] min-w-[600px]",
                "max-lg:w-[60%] max-lg:min-w-[500px]",
                "max-md:w-full max-md:min-w-0",
                // Scrolling
                "overflow-y-auto overflow-x-hidden",
                "scroll-smooth",
                // Hide scrollbar but keep functionality
                "scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700",
                // Padding
                "px-6 py-10"
            )}
        >
            {/* Day Cards Container - centered with max-width */}
            <div className="mx-auto max-w-[800px] flex flex-col gap-6">
                {/* Placeholder for day cards - will be replaced in Prompt 02 & 03 */}
                <DayCardPlaceholder label="Past Day" variant="past" />
                <DayCardPlaceholder label="Today (Active)" variant="active" />
                <DayCardPlaceholder label="Future Day" variant="future" />
            </div>
        </div>
    )
}

/**
 * Right section - Sticky sidebar with calendar, AI, and notes
 */
function JournalSidebar(): React.JSX.Element {
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
                "flex flex-col gap-5"
            )}
        >
            {/* Calendar Section Placeholder */}
            <SidebarSection
                icon={Calendar}
                title="Calendar"
                iconColor="text-accent-blue"
            >
                <div className="h-48 rounded-lg border border-dashed border-border/60 flex items-center justify-center text-muted-foreground text-sm">
                    Calendar Heatmap
                </div>
            </SidebarSection>

            {/* AI Connections Section Placeholder */}
            <SidebarSection
                icon={Sparkles}
                title="AI Connections"
                iconColor="text-accent-purple"
            >
                <div className="h-32 rounded-lg border border-dashed border-border/60 flex items-center justify-center text-muted-foreground text-sm">
                    AI Connections
                </div>
            </SidebarSection>

            {/* Today's Notes Section Placeholder */}
            <SidebarSection
                icon={FileText}
                title="Today's Notes"
                iconColor="text-accent-green"
            >
                <div className="h-40 rounded-lg border border-dashed border-border/60 flex items-center justify-center text-muted-foreground text-sm">
                    Today's Notes
                </div>
            </SidebarSection>
        </aside>
    )
}

// =============================================================================
// PLACEHOLDER COMPONENTS
// =============================================================================

interface DayCardPlaceholderProps {
    label: string
    variant: "past" | "active" | "future"
}

/**
 * Placeholder for day cards - will be replaced in Prompt 03
 */
function DayCardPlaceholder({ label, variant }: DayCardPlaceholderProps): React.JSX.Element {
    return (
        <div
            className={cn(
                // Base styling
                "rounded-xl p-6 min-h-[200px]",
                "flex flex-col items-center justify-center gap-2",
                "transition-all duration-300",
                // Variant-specific styling
                variant === "past" && [
                    "opacity-50",
                    "bg-card border border-border/40",
                ],
                variant === "active" && [
                    "opacity-100",
                    "bg-card border-2 border-primary/30",
                    "shadow-lg shadow-primary/5",
                ],
                variant === "future" && [
                    "opacity-40",
                    "bg-card/50 border border-dashed border-border/60",
                ]
            )}
        >
            <span className="text-lg font-medium text-foreground/80">{label}</span>
            <span className="text-sm text-muted-foreground">
                Day cards will appear here
            </span>
        </div>
    )
}

interface SidebarSectionProps {
    icon: typeof Calendar
    title: string
    iconColor?: string
    children: React.ReactNode
}

/**
 * Reusable sidebar section with icon header
 */
function SidebarSection({
    icon: Icon,
    title,
    iconColor = "text-muted-foreground",
    children,
}: SidebarSectionProps): React.JSX.Element {
    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <Icon className={cn("size-4", iconColor)} />
                <h3 className="text-sm font-medium text-foreground">{title}</h3>
            </div>
            {children}
        </section>
    )
}

export default JournalPage
