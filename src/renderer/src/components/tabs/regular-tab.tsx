/**
 * Regular Tab Component
 * Full-width tab with icon, title, and close button
 */

import { useState, useCallback, memo } from 'react'
import { X } from 'lucide-react'
import type { Tab } from '@/contexts/tabs/types'
import { useTabs, useTabSettings } from '@/contexts/tabs'
import { TabIcon } from './tab-icon'
import { cn } from '@/lib/utils'

interface RegularTabProps {
  /** Tab data */
  tab: Tab
  /** Group ID this tab belongs to */
  groupId: string
  /** Whether this is the active tab */
  isActive: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Regular tab component with full title and controls
 * Memoized to prevent unnecessary re-renders when other tabs change
 */
const RegularTabComponent = ({
  tab,
  groupId,
  isActive,
  className
}: RegularTabProps): React.JSX.Element => {
  const { setActiveTab, closeTab, promotePreviewTab } = useTabs()
  const settings = useTabSettings()
  const [isHovered, setIsHovered] = useState(false)

  // Determine if close button should be visible
  const showCloseButton =
    settings.tabCloseButton === 'always' ||
    (settings.tabCloseButton === 'hover' && isHovered) ||
    (settings.tabCloseButton === 'active' && isActive)

  // Memoized handlers to prevent unnecessary re-renders
  const handleClick = useCallback((): void => {
    setActiveTab(tab.id, groupId)
  }, [setActiveTab, tab.id, groupId])

  const handleClose = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation()
      closeTab(tab.id, groupId)
    },
    [closeTab, tab.id, groupId]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      // Middle-click to close
      if (e.button === 1) {
        e.preventDefault()
        closeTab(tab.id, groupId)
      }
    },
    [closeTab, tab.id, groupId]
  )

  const handleDoubleClick = useCallback((): void => {
    // Double-click promotes preview tab to permanent
    if (tab.isPreview) {
      promotePreviewTab(tab.id, groupId)
    }
  }, [promotePreviewTab, tab.id, tab.isPreview, groupId])

  const handleMouseEnter = useCallback(() => setIsHovered(true), [])
  const handleMouseLeave = useCallback(() => setIsHovered(false), [])

  return (
    <div
      className={cn(
        // Base styles - consistent sizing for all states
        'group relative flex items-center gap-2 h-9 px-3 cursor-pointer',
        'min-w-[100px] max-w-[180px]',
        'select-none',
        // All tabs have border (transparent for inactive) to maintain consistent size
        'border',
        // All tabs extend down to overlap header border
        '-mb-px',
        // Rounded top corners for browser-style
        'rounded-t-lg',
        // Smooth color transitions only (not size)
        'transition-colors duration-150 ease-out',

        // Active state - visible borders and content background
        isActive
          ? [
              'bg-white dark:bg-gray-900',
              'border-gray-200 dark:border-gray-700',
              'border-b-transparent',
              'z-10'
            ]
          : [
              // Inactive tabs - transparent borders
              'bg-transparent',
              'border-transparent',
              'hover:bg-gray-200/50 dark:hover:bg-gray-700/40'
            ],

        // Preview tab styling - only show italic if preview mode is enabled
        tab.isPreview && settings.previewMode && 'italic',

        className
      )}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-tab-id={tab.id}
      data-group-id={groupId}
    >
      {/* Icon with smooth color transition */}
      <TabIcon
        type={tab.type}
        icon={tab.icon}
        emoji={tab.emoji}
        className={cn(
          'w-4 h-4 flex-shrink-0 transition-colors duration-150',
          isActive
            ? 'text-gray-700 dark:text-gray-200'
            : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400'
        )}
      />

      {/* Title with refined typography */}
      <span
        className={cn(
          'flex-1 truncate text-[13px] font-medium tracking-[-0.01em]',
          'transition-colors duration-150',
          isActive
            ? 'text-gray-800 dark:text-gray-100'
            : 'text-gray-500 dark:text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300',
          tab.isPreview && settings.previewMode && 'italic font-normal',
          tab.isDeleted && 'line-through opacity-50'
        )}
      >
        {tab.title}
      </span>

      {/* Close / Modified indicator with smooth animations */}
      <div className="w-4 h-4 flex-shrink-0 flex items-center justify-center">
        {tab.isModified && !showCloseButton ? (
          // Modified dot with pulse animation
          <div
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              'bg-blue-400 dark:bg-blue-500',
              'transition-transform duration-150',
              'animate-pulse'
            )}
            aria-label="Unsaved changes"
          />
        ) : showCloseButton ? (
          // Close button with refined hover state
          <button
            type="button"
            onClick={handleClose}
            className={cn(
              'w-5 h-5 -mr-0.5 rounded-md flex items-center justify-center',
              'hover:bg-gray-200/70 dark:hover:bg-gray-600/50',
              'active:bg-gray-300/70 dark:active:bg-gray-500/50',
              'transition-all duration-100',
              // Smooth fade in/out
              !isActive && 'opacity-0 group-hover:opacity-100'
            )}
            aria-label={`Close ${tab.title}`}
          >
            <X className="w-3 h-3 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Memoized RegularTab - only re-renders when its specific props change
 * Custom comparison for tab object to check relevant properties
 */
export const RegularTab = memo(RegularTabComponent, (prevProps, nextProps) => {
  // Compare primitive props
  if (prevProps.groupId !== nextProps.groupId) return false
  if (prevProps.isActive !== nextProps.isActive) return false
  if (prevProps.className !== nextProps.className) return false

  // Compare relevant tab properties (not lastAccessedAt which changes frequently)
  const prevTab = prevProps.tab
  const nextTab = nextProps.tab
  if (prevTab.id !== nextTab.id) return false
  if (prevTab.title !== nextTab.title) return false
  if (prevTab.type !== nextTab.type) return false
  if (prevTab.icon !== nextTab.icon) return false
  if (prevTab.emoji !== nextTab.emoji) return false
  if (prevTab.isPreview !== nextTab.isPreview) return false
  if (prevTab.isModified !== nextTab.isModified) return false
  if (prevTab.isPinned !== nextTab.isPinned) return false
  if (prevTab.isDeleted !== nextTab.isDeleted) return false

  return true // Props are equal, skip re-render
})

export default RegularTab
