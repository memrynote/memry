/**
 * Tab Drag Overlay
 * Visual representation of tab being dragged
 */

import type { Tab } from '@/contexts/tabs/types';
import { TabIcon } from './tab-icon';
import { cn } from '@/lib/utils';

interface TabDragOverlayProps {
    /** Tab data being dragged */
    tab: Tab;
}

/**
 * Overlay component shown while dragging a tab
 */
export const TabDragOverlay = ({ tab }: TabDragOverlayProps): React.JSX.Element => {
    return (
        <div
            className={cn(
                // Base styles matching RegularTab
                'flex items-center gap-2 h-9 px-3',
                'min-w-[100px] max-w-[200px]',
                'select-none pointer-events-none',
                // Lifted appearance
                'bg-white dark:bg-gray-800',
                'border border-gray-200 dark:border-gray-600',
                'rounded-md',
                'shadow-lg',
                'scale-105',
                // Active styling
                'border-b-2 border-b-blue-500'
            )}
        >
            {/* Icon */}
            <TabIcon
                type={tab.type}
                icon={tab.icon}
                className="w-4 h-4 text-gray-700 dark:text-gray-300"
            />

            {/* Title */}
            <span
                className={cn(
                    'flex-1 truncate text-sm text-gray-900 dark:text-gray-100',
                    tab.isPreview && 'italic'
                )}
            >
                {tab.title}
            </span>

            {/* Modified indicator */}
            {tab.isModified && (
                <div className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500" />
            )}
        </div>
    );
};

export default TabDragOverlay;
