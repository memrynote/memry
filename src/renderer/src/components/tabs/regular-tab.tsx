/**
 * Regular Tab Component
 * Full-width tab with icon, title, and close button
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import type { Tab } from '@/contexts/tabs/types';
import { useTabs } from '@/contexts/tabs';
import { TabIcon } from './tab-icon';
import { cn } from '@/lib/utils';

interface RegularTabProps {
    /** Tab data */
    tab: Tab;
    /** Group ID this tab belongs to */
    groupId: string;
    /** Whether this is the active tab */
    isActive: boolean;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Regular tab component with full title and controls
 */
export const RegularTab = ({
    tab,
    groupId,
    isActive,
    className,
}: RegularTabProps): React.JSX.Element => {
    const { setActiveTab, closeTab, promotePreviewTab, state } = useTabs();
    const [isHovered, setIsHovered] = useState(false);

    // Determine if close button should be visible
    const showCloseButton =
        state.settings.tabCloseButton === 'always' ||
        (state.settings.tabCloseButton === 'hover' && isHovered) ||
        (state.settings.tabCloseButton === 'active' && isActive);

    // Handlers
    const handleClick = (): void => {
        setActiveTab(tab.id, groupId);
    };

    const handleClose = (e: React.MouseEvent): void => {
        e.stopPropagation();
        closeTab(tab.id, groupId);
    };

    const handleMouseDown = (e: React.MouseEvent): void => {
        // Middle-click to close
        if (e.button === 1) {
            e.preventDefault();
            closeTab(tab.id, groupId);
        }
    };

    const handleDoubleClick = (): void => {
        // Double-click promotes preview tab to permanent
        if (tab.isPreview) {
            promotePreviewTab(tab.id, groupId);
        }
    };

    return (
        <div
            className={cn(
                // Base styles
                'group relative flex items-center gap-2 h-9 px-3 cursor-pointer',
                'min-w-[100px] max-w-[200px]',
                'transition-colors duration-100',
                'select-none',

                // Active state - browser style with rounded top corners
                isActive
                    ? [
                        'bg-white dark:bg-gray-800',
                        'rounded-t-lg',
                        'border border-gray-200 dark:border-gray-600',
                        'border-b-0',
                        '-mb-px',
                        'z-10',
                    ]
                    : [
                        'bg-gray-100/50 dark:bg-gray-800/50',
                        'hover:bg-gray-200/50 dark:hover:bg-gray-700/50',
                    ],

                // Preview tab (italic)
                tab.isPreview && 'italic',

                className
            )}
            onClick={handleClick}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-tab-id={tab.id}
            data-group-id={groupId}
        >
            {/* Icon */}
            <TabIcon
                type={tab.type}
                icon={tab.icon}
                className={cn(
                    'w-4 h-4',
                    isActive
                        ? 'text-gray-700 dark:text-gray-300'
                        : 'text-gray-500 dark:text-gray-400'
                )}
            />

            {/* Title */}
            <span
                className={cn(
                    'flex-1 truncate text-sm',
                    isActive
                        ? 'text-gray-900 dark:text-gray-100'
                        : 'text-gray-600 dark:text-gray-400',
                    tab.isPreview && 'italic',
                    tab.isDeleted && 'line-through opacity-60'
                )}
            >
                {tab.title}
            </span>

            {/* Close / Modified indicator */}
            <div className="w-4 h-4 flex-shrink-0 flex items-center justify-center">
                {tab.isModified && !showCloseButton ? (
                    // Modified dot
                    <div
                        className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500"
                        aria-label="Unsaved changes"
                    />
                ) : showCloseButton ? (
                    // Close button
                    <button
                        type="button"
                        onClick={handleClose}
                        className={cn(
                            'w-4 h-4 rounded flex items-center justify-center',
                            'hover:bg-gray-200 dark:hover:bg-gray-600',
                            'transition-colors',
                            // Hide on inactive tabs until hovered
                            !isActive && 'opacity-0 group-hover:opacity-100'
                        )}
                        aria-label={`Close ${tab.title}`}
                    >
                        <X className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                    </button>
                ) : null}
            </div>
        </div>
    );
};

export default RegularTab;
