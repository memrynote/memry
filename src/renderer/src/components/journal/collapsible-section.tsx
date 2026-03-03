/**
 * Collapsible Section Component
 * Reusable collapsible section for day card (Calendar Events, Overdue Tasks)
 * With smooth animations and accessibility
 */

import { useState, useRef, useEffect, memo, useId } from 'react'
import { ChevronDown, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { JournalEditor } from './journal-editor'

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
 * Collapsible section with animated header toggle
 * Used for Calendar Events and Overdue Tasks in day cards
 */
export const CollapsibleSection = memo(function CollapsibleSection({
  icon,
  title,
  count,
  countLabel,
  defaultCollapsed = true,
  children,
  className
}: CollapsibleSectionProps): React.JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState<number>(0)
  const headerId = useId()
  const contentId = useId()

  // Measure content height for animation
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight)
    }
  }, [children])

  const toggleCollapse = () => setIsCollapsed((prev) => !prev)

  return (
    <div
      className={cn('rounded-lg border border-border/40 bg-muted/20 overflow-hidden', className)}
    >
      {/* Header - always visible */}
      <button
        id={headerId}
        type="button"
        onClick={toggleCollapse}
        aria-expanded={!isCollapsed}
        aria-controls={contentId}
        className={cn(
          'w-full flex items-center justify-between px-4 py-3',
          'hover:bg-muted/40 transition-colors duration-150',
          'text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
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
          <ChevronDown
            className={cn(
              'size-4 text-muted-foreground transition-transform duration-200',
              !isCollapsed && 'rotate-180'
            )}
          />
        </div>
      </button>

      {/* Content - animated */}
      <div
        id={contentId}
        role="region"
        aria-labelledby={headerId}
        aria-hidden={isCollapsed}
        style={{
          maxHeight: isCollapsed ? 0 : contentHeight,
          opacity: isCollapsed ? 0 : 1
        }}
        className={cn(
          'transition-all duration-250 ease-out overflow-hidden',
          isCollapsed ? 'invisible' : 'visible'
        )}
      >
        <div ref={contentRef} className="px-4 pb-4 pt-1 border-t border-border/30">
          {children}
        </div>
      </div>
    </div>
  )
})

// =============================================================================
// JOURNAL SECTION (Always visible, uses real Tiptap editor)
// =============================================================================

export interface JournalSectionProps {
  /** Whether this is an active/focused day */
  isActive?: boolean
  /** Placeholder text */
  placeholder?: string
  /** Initial content */
  content?: string
  /** Content change callback */
  onContentChange?: (content: string) => void
}

export const JournalSection = memo(function JournalSection({
  isActive = false,
  placeholder = 'Start writing...',
  content = '',
  onContentChange
}: JournalSectionProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/40 bg-muted/20">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Pencil className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Journal</span>
        </div>
      </div>

      {/* Tiptap Editor */}
      <div className="p-4">
        <JournalEditor
          content={content}
          placeholder={placeholder}
          isActive={isActive}
          onContentChange={onContentChange}
        />
      </div>
    </div>
  )
})

export default CollapsibleSection
