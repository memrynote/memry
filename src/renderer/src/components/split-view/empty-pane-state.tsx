/**
 * Empty Pane State Component
 * Placeholder shown when a pane has no tabs
 */

import { FileText, Inbox } from 'lucide-react'
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
      className={cn(
        'h-full flex flex-col items-center justify-center',
        'p-8',
        // Subtle background pattern
        'bg-gradient-to-b from-gray-50/50 to-white dark:from-gray-900/50 dark:to-gray-900',
        className
      )}
    >
      {/* Icon with refined styling */}
      <div className="relative mb-6">
        <div className="absolute inset-0 blur-xl bg-gray-200/50 dark:bg-gray-700/30 rounded-full scale-150" />
        <div className="relative p-4 rounded-2xl bg-gray-100/80 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/30">
          <FileText className="w-8 h-8 text-gray-400 dark:text-gray-500" />
        </div>
      </div>

      {/* Typography with refined hierarchy */}
      <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">No tabs open</h3>
      <p className="text-sm text-gray-400 dark:text-gray-500 mb-8 text-center max-w-[240px] leading-relaxed">
        Open a page from the sidebar or create a new tab to get started
      </p>

      {/* Action buttons with refined styling */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleOpenInbox}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 rounded-lg',
            'bg-gray-900 dark:bg-gray-100',
            'text-white dark:text-gray-900',
            'text-sm font-medium',
            'shadow-[0_1px_2px_rgba(0,0,0,0.1),0_2px_4px_rgba(0,0,0,0.05)]',
            'hover:shadow-[0_2px_4px_rgba(0,0,0,0.12),0_4px_8px_rgba(0,0,0,0.08)]',
            'hover:bg-gray-800 dark:hover:bg-gray-200',
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
              'bg-gray-100/80 dark:bg-gray-800/60',
              'text-gray-600 dark:text-gray-400',
              'text-sm font-medium',
              'border border-gray-200/60 dark:border-gray-700/40',
              'hover:bg-gray-200/60 dark:hover:bg-gray-700/40',
              'hover:text-gray-700 dark:hover:text-gray-300',
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
