/**
 * Tab Bar with Drag Support
 * Tab bar container with drag-to-reorder functionality
 * Uses parent DndContext from SplitViewContainer for cross-panel dragging
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import {
    SortableContext,
    horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ChevronLeft, ChevronRight, PanelRight, Bot } from 'lucide-react';
import { useAIAgent } from '@/contexts/ai-agent-context';
import { useTabGroup, useTabs } from '@/contexts/tabs';
import { SortableTab } from './sortable-tab';
import { PinnedTab } from './pinned-tab';
import { TabBarAction } from './tab-bar-action';
import { TabBarContextMenu } from './tab-bar-context-menu';
import { TabContextMenu } from './tab-context-menu';
import { cn } from '@/lib/utils';

interface TabBarWithDragProps {
    /** ID of the tab group to display */
    groupId: string;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Tab bar with drag-to-reorder support and context menu
 * DndContext is provided by SplitViewContainer for cross-panel support
 */
export const TabBarWithDrag = ({
    groupId,
    className,
}: TabBarWithDragProps): React.JSX.Element | null => {
    const { state, openTab, splitView } = useTabs();
    const group = useTabGroup(groupId);
    const { toggle: toggleAIAgent, isOpen: isAIAgentOpen } = useAIAgent();

    // Scroll state
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    // If group doesn't exist, don't render
    if (!group) return null;

    // Separate pinned and regular tabs
    const pinnedTabs = group.tabs.filter((t) => t.isPinned);
    const regularTabs = group.tabs.filter((t) => !t.isPinned);
    const isActiveGroup = state.activeGroupId === groupId;

    // Check scroll state
    const checkScroll = useCallback(() => {
        if (!scrollRef.current) return;
        const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
        setCanScrollLeft(scrollLeft > 0);
        setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
    }, []);

    // Set up scroll listener
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;

        checkScroll();
        el.addEventListener('scroll', checkScroll);

        const resizeObserver = new ResizeObserver(checkScroll);
        resizeObserver.observe(el);

        return () => {
            el.removeEventListener('scroll', checkScroll);
            resizeObserver.disconnect();
        };
    }, [checkScroll, regularTabs.length]);

    // Scroll handlers
    const scrollLeft = (): void => {
        scrollRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
    };

    const scrollRight = (): void => {
        scrollRef.current?.scrollBy({ left: 200, behavior: 'smooth' });
    };

    // Handle new tab
    const handleNewTab = (): void => {
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

    // Handle split view
    const handleSplitRight = (): void => {
        splitView('horizontal', groupId);
    };

    return (
        <TabBarContextMenu groupId={groupId}>
            <div
                className={cn(
                    // Container
                    'flex items-center h-9',
                    'bg-gray-100 dark:bg-gray-800',
                    'border-b border-gray-200 dark:border-gray-700',
                    // Active group indicator
                    isActiveGroup && 'bg-gray-100 dark:bg-gray-800',
                    className
                )}
                role="tablist"
                aria-label="Open tabs"
                aria-orientation="horizontal"
                data-group-id={groupId}
            >
                {/* Pinned tabs section (not in sortable context) */}
                {pinnedTabs.length > 0 && (
                    <>
                        <div className="flex items-center px-1 gap-0.5">
                            {pinnedTabs.map((tab) => (
                                <TabContextMenu
                                    key={tab.id}
                                    tab={tab}
                                    groupId={groupId}
                                >
                                    <PinnedTab
                                        tab={tab}
                                        groupId={groupId}
                                        isActive={tab.id === group.activeTabId}
                                    />
                                </TabContextMenu>
                            ))}
                        </div>

                        {/* Divider */}
                        <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />
                    </>
                )}

                {/* Scroll left button */}
                {canScrollLeft && (
                    <button
                        type="button"
                        onClick={scrollLeft}
                        className={cn(
                            'flex items-center justify-center w-6 h-9',
                            'bg-gradient-to-r from-gray-50 to-transparent',
                            'dark:from-gray-900 dark:to-transparent',
                            'hover:from-gray-100 dark:hover:from-gray-800',
                            'transition-colors z-10'
                        )}
                        aria-label="Scroll tabs left"
                    >
                        <ChevronLeft className="w-4 h-4 text-gray-500" />
                    </button>
                )}

                {/* Regular tabs section (sortable) */}
                <div
                    ref={scrollRef}
                    className={cn(
                        'flex-1 flex items-center overflow-x-auto',
                        'scrollbar-none [&::-webkit-scrollbar]:hidden',
                        '[-ms-overflow-style:none] [scrollbar-width:none]'
                    )}
                >
                    <SortableContext
                        items={regularTabs.map((t) => t.id)}
                        strategy={horizontalListSortingStrategy}
                    >
                        <div className="flex items-center">
                            {regularTabs.map((tab) => (
                                <SortableTab
                                    key={tab.id}
                                    tab={tab}
                                    groupId={groupId}
                                    isActive={tab.id === group.activeTabId}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </div>

                {/* Scroll right button */}
                {canScrollRight && (
                    <button
                        type="button"
                        onClick={scrollRight}
                        className={cn(
                            'flex items-center justify-center w-6 h-9',
                            'bg-gradient-to-l from-gray-50 to-transparent',
                            'dark:from-gray-900 dark:to-transparent',
                            'hover:from-gray-100 dark:hover:from-gray-800',
                            'transition-colors z-10'
                        )}
                        aria-label="Scroll tabs right"
                    >
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                    </button>
                )}

                {/* Tab actions */}
                <div className="flex items-center px-1 gap-0.5 border-l border-gray-200 dark:border-gray-700">
                    <TabBarAction
                        icon={<PanelRight className="w-4 h-4" />}
                        tooltip="Split Right"
                        onClick={handleSplitRight}
                    />
                    <TabBarAction
                        icon={<Bot className={cn("w-4 h-4", isAIAgentOpen && "text-blue-500")} />}
                        tooltip="AI Agent"
                        onClick={toggleAIAgent}
                    />
                </div>
            </div>
        </TabBarContextMenu>
    );
};

export default TabBarWithDrag;
