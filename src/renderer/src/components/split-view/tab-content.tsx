/**
 * Tab Content Component
 * Routes to the correct view based on tab type
 */

import { useRef, useEffect } from 'react';
import type { Tab } from '@/contexts/tabs/types';
import { useTabs } from '@/contexts/tabs';
import { cn } from '@/lib/utils';

interface TabContentProps {
    /** Tab data */
    tab: Tab;
    /** Group ID this tab belongs to */
    groupId: string;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Renders the appropriate view for a tab type
 */
export const TabContent = ({
    tab,
    groupId,
    className,
}: TabContentProps): React.JSX.Element => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const { dispatch } = useTabs();

    // Save scroll position on unmount or tab change
    useEffect(() => {
        const scrollElement = scrollRef.current;

        return () => {
            if (scrollElement) {
                dispatch({
                    type: 'SAVE_TAB_STATE',
                    payload: {
                        tabId: tab.id,
                        groupId,
                        scrollPosition: scrollElement.scrollTop,
                    },
                });
            }
        };
    }, [tab.id, groupId, dispatch]);

    // Restore scroll position on mount
    useEffect(() => {
        if (scrollRef.current && tab.scrollPosition) {
            scrollRef.current.scrollTop = tab.scrollPosition;
        }
    }, [tab.id, tab.scrollPosition]);

    // Render content based on tab type
    const renderContent = (): React.ReactNode => {
        switch (tab.type) {
            case 'inbox':
                // Placeholder - will integrate with actual views
                return <PlaceholderView title="Inbox" icon="inbox" />;

            case 'home':
                return <PlaceholderView title="Home" icon="home" />;

            case 'all-tasks':
                return <PlaceholderView title="All Tasks" icon="list-checks" />;

            case 'today':
                return <PlaceholderView title="Today" icon="star" />;

            case 'upcoming':
                return <PlaceholderView title="Upcoming" icon="calendar" />;

            case 'completed':
                return <PlaceholderView title="Completed" icon="check-circle" />;

            case 'project':
                return (
                    <PlaceholderView
                        title={tab.title}
                        icon="folder"
                        subtitle={`Project: ${tab.entityId}`}
                    />
                );

            case 'note':
                return (
                    <PlaceholderView
                        title={tab.title}
                        icon="file-text"
                        subtitle={`Note: ${tab.entityId}`}
                    />
                );

            case 'journal':
                return (
                    <PlaceholderView
                        title={tab.title}
                        icon="book-open"
                        subtitle={`Journal: ${tab.entityId}`}
                    />
                );

            case 'search':
                return (
                    <PlaceholderView
                        title="Search Results"
                        icon="search"
                        subtitle={`Query: ${tab.viewState?.query ?? ''}`}
                    />
                );

            case 'settings':
                return <PlaceholderView title="Settings" icon="settings" />;

            case 'collection':
                return (
                    <PlaceholderView
                        title={tab.title}
                        icon="bookmark"
                        subtitle={`Collection: ${tab.entityId}`}
                    />
                );

            default:
                return (
                    <div className="p-4 text-gray-500">
                        Unknown tab type: {tab.type}
                    </div>
                );
        }
    };

    return (
        <div
            ref={scrollRef}
            className={cn('h-full overflow-auto', className)}
            data-tab-content={tab.id}
        >
            {renderContent()}
        </div>
    );
};

// =============================================================================
// PLACEHOLDER VIEW (temporary until real views are integrated)
// =============================================================================

interface PlaceholderViewProps {
    title: string;
    icon: string;
    subtitle?: string;
}

const PlaceholderView = ({
    title,
    icon,
    subtitle,
}: PlaceholderViewProps): React.JSX.Element => {
    return (
        <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 p-8">
            <div className="text-6xl mb-4 opacity-30">
                {/* Icon placeholder - will use TabIcon when integrated */}
                📄
            </div>
            <h2 className="text-xl font-medium text-gray-600 dark:text-gray-300 mb-2">
                {title}
            </h2>
            {subtitle && (
                <p className="text-sm text-gray-400 dark:text-gray-500">{subtitle}</p>
            )}
            <p className="text-xs text-gray-300 dark:text-gray-600 mt-4">
                Content view will be integrated here
            </p>
        </div>
    );
};

export default TabContent;
