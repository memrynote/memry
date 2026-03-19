/**
 * Accessible Tab Component
 * Tab with complete ARIA attributes and screen reader support
 */

import { useRef, useEffect } from 'react'
import { X } from '@/lib/icons'
import type { Tab } from '@/contexts/tabs/types'
import { useTabs, useTabSettings } from '@/contexts/tabs'
import { TabIcon } from './tab-icon'
import { cn } from '@/lib/utils'

interface AccessibleTabProps {
  /** Tab data */
  tab: Tab
  /** Group ID */
  groupId: string
  /** Index in tab list */
  index: number
  /** Total number of tabs */
  totalTabs: number
  /** Whether this tab is active */
  isActive: boolean
  /** Whether tab is focused for keyboard nav */
  isFocused?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Fully accessible tab with ARIA attributes
 */
export const AccessibleTab = ({
  tab,
  groupId,
  index,
  totalTabs,
  isActive,
  isFocused = false,
  className
}: AccessibleTabProps): React.JSX.Element => {
  const { setActiveTab, closeTab } = useTabs()
  const settings = useTabSettings()
  const tabRef = useRef<HTMLButtonElement>(null)

  // Focus when marked as focused (keyboard navigation)
  useEffect(() => {
    if (isFocused && tabRef.current) {
      tabRef.current.focus()
    }
  }, [isFocused])

  /**
   * Handle keyboard interactions
   */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (!tab.isPinned) {
          e.preventDefault()
          closeTab(tab.id, groupId)
        }
        break
    }
  }

  /**
   * Build accessible label
   */
  const buildLabel = (): string => {
    const parts = [tab.title]

    if (tab.isPinned) parts.push('pinned')
    if (tab.isModified) parts.push('unsaved changes')
    if (tab.isPreview) parts.push('preview')

    parts.push(`tab ${index + 1} of ${totalTabs}`)

    return parts.join(', ')
  }

  return (
    <button
      ref={tabRef}
      type="button"
      role="tab"
      id={`tab-${tab.id}`}
      aria-selected={isActive}
      aria-controls={`tabpanel-${tab.id}`}
      aria-label={buildLabel()}
      tabIndex={isActive ? 0 : -1}
      onClick={() => setActiveTab(tab.id, groupId)}
      onKeyDown={handleKeyDown}
      data-tab-id={tab.id}
      className={cn(
        'flex items-center gap-2 px-3 h-8 min-w-0',
        'border-b-2 transition-colors outline-none',
        'focus:ring-1 focus:ring-blue-500 focus:ring-inset',
        isActive
          ? 'bg-background border-blue-500 text-foreground'
          : 'bg-muted/50 border-transparent text-muted-foreground hover:bg-surface-active',
        className
      )}
    >
      {/* Icon */}
      <TabIcon
        type={tab.type}
        icon={tab.icon}
        emoji={tab.emoji}
        className="w-4 h-4 flex-shrink-0"
        aria-hidden="true"
      />

      {/* Title */}
      <span className="truncate text-sm">
        {tab.title}
        {/* Screen reader only: status */}
        {tab.isModified && <span className="sr-only">, unsaved changes</span>}
      </span>

      {/* Modified indicator */}
      {tab.isModified && (
        <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" aria-hidden="true" />
      )}

      {/* Preview indicator - only show when preview mode is enabled */}
      {tab.isPreview && !tab.isModified && settings.previewMode && (
        <span className="text-xs text-gray-400 italic" aria-hidden="true">
          preview
        </span>
      )}

      {/* Close button */}
      {!tab.isPinned && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            closeTab(tab.id, groupId)
          }}
          aria-label={`Close ${tab.title} tab`}
          className={cn(
            'p-0.5 rounded opacity-0 group-hover:opacity-100',
            'hover:bg-border',
            'focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-blue-500',
            isActive && 'opacity-100'
          )}
          tabIndex={-1}
        >
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </button>
  )
}

export default AccessibleTab
