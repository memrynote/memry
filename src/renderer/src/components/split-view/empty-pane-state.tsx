/**
 * Empty Pane State Component
 * Placeholder shown when a pane has no tabs
 */

import { FileText, Inbox } from 'lucide-react';
import { useTabs } from '@/contexts/tabs';
import { cn } from '@/lib/utils';

interface EmptyPaneStateProps {
    /** Group ID for this pane */
    groupId: string;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Empty state placeholder for panes with no tabs
 */
export const EmptyPaneState = ({
    groupId,
    className,
}: EmptyPaneStateProps): React.JSX.Element => {
    const { openTab, dispatch, state } = useTabs();

    // Check if there are other groups (can close this pane)
    const groupIds = Object.keys(state.tabGroups);
    const canClose = groupIds.length > 1;

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
                isDeleted: false,
            },
            { groupId }
        );
    };

    const handleClosePane = (): void => {
        dispatch({
            type: 'CLOSE_SPLIT',
            payload: { groupId },
        });
    };

    return (
        <div
            className={cn(
                'h-full flex flex-col items-center justify-center',
                'text-gray-400 dark:text-gray-500 p-8',
                className
            )}
        >
            <FileText className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-lg mb-2">No tabs open</p>
            <p className="text-sm mb-6 text-center">
                Open a page from the sidebar or create a new tab
            </p>

            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={handleOpenInbox}
                    className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-lg',
                        'bg-blue-500 text-white',
                        'hover:bg-blue-600 transition-colors'
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
                            'px-4 py-2 rounded-lg',
                            'bg-gray-100 dark:bg-gray-800',
                            'text-gray-700 dark:text-gray-300',
                            'hover:bg-gray-200 dark:hover:bg-gray-700',
                            'transition-colors'
                        )}
                    >
                        Close Pane
                    </button>
                )}
            </div>
        </div>
    );
};

export default EmptyPaneState;
