/**
 * Recently Closed Menu Component
 * Dropdown showing recently closed tabs with reopen functionality
 */

import { History, X } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useTabs } from '@/contexts/tabs';
import { TabIcon } from '@/components/tabs';
import { cn } from '@/lib/utils';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format time ago string
 */
const formatTimeAgo = (timestamp: number): string => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
};

// =============================================================================
// COMPONENT
// =============================================================================

interface RecentlyClosedMenuProps {
    /** Additional CSS classes */
    className?: string;
}

/**
 * Dropdown menu showing recently closed tabs
 */
export const RecentlyClosedMenu = ({
    className,
}: RecentlyClosedMenuProps): React.JSX.Element | null => {
    const { state, dispatch, reopenClosedTab } = useTabs();

    // Don't render if no recently closed tabs
    if (state.recentlyClosed.length === 0) {
        return (
            <button
                type="button"
                disabled
                className={cn(
                    'p-2 rounded text-gray-300 dark:text-gray-600 cursor-not-allowed',
                    className
                )}
                title="No recently closed tabs"
            >
                <History className="w-4 h-4" />
            </button>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800',
                        'text-gray-500 dark:text-gray-400 transition-colors',
                        className
                    )}
                    title="Recently closed tabs"
                >
                    <History className="w-4 h-4" />
                </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="flex items-center justify-between">
                    <span>Recently Closed</span>
                    <span className="text-xs text-gray-400 font-normal">
                        {state.recentlyClosed.length} tabs
                    </span>
                </DropdownMenuLabel>

                <DropdownMenuSeparator />

                {state.recentlyClosed.map((closed, index) => (
                    <DropdownMenuItem
                        key={`${closed.tab.id}-${closed.closedAt}`}
                        onClick={() => {
                            if (index === 0) {
                                reopenClosedTab();
                            } else {
                                dispatch({
                                    type: 'REOPEN_SPECIFIC_CLOSED_TAB',
                                    payload: { index },
                                });
                            }
                        }}
                        className="flex items-center gap-2 cursor-pointer"
                    >
                        <TabIcon type={closed.tab.type} className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate flex-1">{closed.tab.title}</span>
                        <span className="text-xs text-gray-400 flex-shrink-0">
                            {formatTimeAgo(closed.closedAt)}
                        </span>
                    </DropdownMenuItem>
                ))}

                <DropdownMenuSeparator />

                <DropdownMenuItem
                    onClick={() => dispatch({ type: 'CLEAR_RECENTLY_CLOSED' })}
                    className="text-red-600 dark:text-red-400 cursor-pointer"
                >
                    <X className="w-4 h-4 mr-2" />
                    Clear All
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default RecentlyClosedMenu;
