/**
 * Regular Tab Component
 * Full-width tab with icon, title, and close button
 */

import { useState, useCallback, memo } from 'react'
import { X } from '@/lib/icons'
import type { Tab } from '@/contexts/tabs/types'
import { useTabs, useTabSettings } from '@/contexts/tabs'
import { TabIcon } from './tab-icon'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

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

/** Unsaved-changes dot, shown in place of the close button when it is hidden */
const ModifiedDot = ({
  label,
  className
}: {
  label: string
  className?: string
}): React.JSX.Element => (
  <div
    className={cn(
      'w-1.5 h-1.5 rounded-full',
      'bg-tint',
      'transition-transform duration-150',
      'animate-pulse',
      className
    )}
    aria-label={label}
  />
)

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
  const { t: tPhaseF } = useT('common')
  const { setActiveTab, closeTab } = useTabs()
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

  const handleMouseEnter = useCallback(() => setIsHovered(true), [])
  const handleMouseLeave = useCallback(() => setIsHovered(false), [])

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2 h-9 pt-0.5 px-4 cursor-pointer',
        'w-full min-w-0',
        // Compression tiers — tighten spacing, then drop the close button, then the title
        '@max-[124px]:px-2.5 @max-[124px]:gap-1.5',
        '@max-[76px]:px-0 @max-[76px]:gap-0 @max-[76px]:justify-center',
        'select-none',
        'border-e border-e-border/40',
        'border-b-2',
        'transition-colors duration-150 ease-out',

        isActive
          ? ['bg-background', 'border-b-sidebar-terracotta']
          : ['bg-transparent', 'border-b-transparent', 'hover:bg-foreground/[0.03]'],

        className
      )}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="tab"
      aria-selected={isActive}
      // Keeps the accessible name when the title is hidden at narrow widths
      aria-label={tab.title}
      tabIndex={isActive ? 0 : -1}
      data-testid={tab.type === 'home' ? 'nav-home' : undefined}
      data-tab-id={tab.id}
      data-group-id={groupId}
    >
      {/* Icon with smooth color transition */}
      <TabIcon
        type={tab.type}
        icon={tab.icon}
        emoji={tab.emoji}
        entityId={tab.entityId}
        className={cn(
          'w-4 h-4 flex-shrink-0 transition-colors duration-150',
          isActive ? 'text-foreground' : 'text-text-tertiary group-hover:text-text-secondary'
        )}
      />

      {/* Title with refined typography */}
      <span
        className={cn(
          'flex-1 truncate text-[13px] tracking-[-0.01em]',
          '@max-[76px]:hidden',
          'transition-colors duration-150',
          isActive
            ? 'text-foreground font-medium'
            : 'text-text-tertiary font-normal group-hover:text-text-secondary',
          tab.isDeleted && 'line-through opacity-50'
        )}
      >
        {tab.title}
      </span>

      {/* Close / Modified indicator with smooth animations */}
      <div className="w-4 h-4 flex-shrink-0 flex items-center justify-center @max-[76px]:hidden">
        {showCloseButton ? (
          <>
            {/* Close button with refined hover state — makes way for the dot when compressed */}
            <button
              type="button"
              onClick={handleClose}
              className={cn(
                'w-5 h-5 -me-0.5 rounded-md flex items-center justify-center',
                '@max-[124px]:hidden',
                'hover:bg-surface-active/70',
                'active:bg-surface-active',
                'transition-all duration-100',
                // Smooth fade in/out
                !isActive && 'opacity-0 group-hover:opacity-100'
              )}
              aria-label={`Close ${tab.title}`}
            >
              <X className="w-3 h-3 text-text-tertiary hover:text-foreground transition-colors" />
            </button>
            {tab.isModified && (
              <ModifiedDot
                className="hidden @max-[124px]:block"
                label={tPhaseF('phaseF.componentsTabsRegularTab.unsavedChanges')}
              />
            )}
          </>
        ) : tab.isModified ? (
          <ModifiedDot label={tPhaseF('phaseF.componentsTabsRegularTab.unsavedChanges')} />
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
