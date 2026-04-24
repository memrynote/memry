/**
 * SidebarDrillDownContainer Component
 *
 * Container that manages the drill-down navigation within the sidebar.
 * Handles sliding animations between main sidebar and detail views.
 */

import * as React from 'react'

import { cn } from '@/lib/utils'
import { useSidebarDrillDown, type DrillDownView } from '@/contexts/sidebar-drill-down'
import { TagDetailView } from './tag-detail-view'

interface SidebarDrillDownContainerProps {
  /** Main sidebar content (when at root) */
  children: React.ReactNode
  className?: string
}

export function SidebarDrillDownContainer({
  children,
  className
}: SidebarDrillDownContainerProps): React.JSX.Element {
  const { currentView, animationDirection } = useSidebarDrillDown()

  // Determine if we should show the main content or detail view
  const isMainView = currentView.type === 'main'

  return (
    <div className={cn('relative overflow-hidden flex-1 flex flex-col min-h-0', className)}>
      {/* Main sidebar content */}
      <div
        className={cn(
          'flex flex-col flex-1 min-h-0 transition-transform duration-200 ease-out',
          !isMainView && 'absolute inset-0 pointer-events-none',
          animationDirection === 'left' && !isMainView && '-translate-x-full',
          animationDirection === 'right' && !isMainView && 'translate-x-0',
          !isMainView && '-translate-x-full'
        )}
      >
        {children}
      </div>

      {/* Detail view */}
      <div
        className={cn(
          'absolute inset-0 transition-transform duration-200 ease-out bg-sidebar overflow-y-auto',
          isMainView && 'pointer-events-none',
          animationDirection === 'left' && !isMainView && 'translate-x-0',
          animationDirection === 'right' && !isMainView && 'translate-x-full',
          isMainView && 'translate-x-full'
        )}
      >
        <DetailViewRenderer view={currentView} />
      </div>
    </div>
  )
}

/**
 * Renders the appropriate detail view based on the view type.
 */
function DetailViewRenderer({ view }: { view: DrillDownView }): React.JSX.Element | null {
  switch (view.type) {
    case 'tag':
      return <TagDetailView tag={view.tag} color={view.color} />
    case 'main':
    default:
      return null
  }
}

export default SidebarDrillDownContainer
