/**
 * Empty Pane State Component
 * Placeholder shown when a pane has no tabs
 */

import { FileText, Inbox } from '@/lib/icons'
import { useTabs } from '@/contexts/tabs'
import { cn } from '@/lib/utils'

interface EmptyPaneStateProps {
  /** Group ID for this pane */
  groupId: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Empty state placeholder for panes with no tabs
 * Features elegant, minimal design with subtle visual depth
 */
export const EmptyPaneState = ({ groupId, className }: EmptyPaneStateProps): React.JSX.Element => {
  const { openTab, dispatch, state } = useTabs()

  // Check if there are other groups (can close this pane)
  const groupIds = Object.keys(state.tabGroups)
  const canClose = groupIds.length > 1

  const handleOpenInbox = (): void => {
    openTab(
      {
        type: 'inbox',
        title: 'Inbox',
        icon: 'inbox',
        path: '/inbox',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }

  const handleClosePane = (): void => {
    dispatch({
      type: 'CLOSE_SPLIT',
      payload: { groupId }
    })
  }

  return (
    <div
      data-testid="empty-pane-state"
      className={cn(
        'h-full flex flex-col items-center justify-center',
        'p-8',
        // Subtle background pattern
        'bg-gradient-to-b from-background/50 to-background',
        className
      )}
    >
      {/* Icon with refined styling */}
      <div className="relative mb-6">
        <div className="absolute inset-0 blur-xl bg-surface-active/50 rounded-full scale-150" />
        <div className="relative p-4 rounded-2xl bg-muted/80 border border-border/50">
          <FileText className="w-8 h-8 text-text-tertiary" />
        </div>
      </div>

      {/* Typography with refined hierarchy */}
      <h3 className="text-lg font-medium text-foreground mb-2">No tabs open</h3>
      <p className="text-sm text-text-tertiary mb-8 text-center max-w-[240px] leading-relaxed">
        Open a page from the sidebar or create a new tab to get started
      </p>

      {/* Action buttons with refined styling */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleOpenInbox}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 rounded-lg',
            'bg-primary',
            'text-primary-foreground',
            'text-sm font-medium',
            'shadow-[0_1px_2px_rgba(0,0,0,0.1),0_2px_4px_rgba(0,0,0,0.05)]',
            'hover:shadow-[0_2px_4px_rgba(0,0,0,0.12),0_4px_8px_rgba(0,0,0,0.08)]',
            'hover:bg-primary/90',
            'active:scale-[0.98]',
            'transition-all duration-150 ease-out'
          )}
        >
          <Inbox className="w-4 h-4" />
          Open Inbox
        </button>

        {canClose && (
          <button
            type="button"
            onClick={handleClosePane}
            className={cn(
              'px-4 py-2.5 rounded-lg',
              'bg-muted/80',
              'text-muted-foreground',
              'text-sm font-medium',
              'border border-border/60',
              'hover:bg-surface-active/60',
              'hover:text-foreground',
              'active:scale-[0.98]',
              'transition-all duration-150 ease-out'
            )}
          >
            Close Pane
          </button>
        )}
      </div>
    </div>
  )
}

export default EmptyPaneState
