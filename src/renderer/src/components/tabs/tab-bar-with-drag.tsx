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
    const { splitView } = useTabs();
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

    // Handle split view
    const handleSplitRight = (): void => {
        splitView('horizontal', groupId);
    };

    return (
        <TabBarContextMenu groupId={groupId}>
            <div
                className={cn(
                    // Container with refined styling
                    'flex items-center h-full',
                    'bg-transparent',
                    // Subtle bottom edge treatment
                    'relative',
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
                        <div className="flex items-center px-1.5 gap-1">
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

                        {/* Refined divider */}
                        <div className="w-px h-5 bg-gray-200/60 dark:bg-gray-700/40 mx-1.5" />
                    </>
                )}

                {/* Scroll left button with smooth fade */}
                {canScrollLeft && (
                    <button
                        type="button"
                        onClick={scrollLeft}
                        className={cn(
                            'flex items-center justify-center w-7 h-full',
                            'bg-gradient-to-r from-gray-100/90 via-gray-100/60 to-transparent',
                            'dark:from-gray-900/90 dark:via-gray-900/60 dark:to-transparent',
                            'hover:from-gray-200/90 dark:hover:from-gray-800/90',
                            'transition-all duration-150 ease-out z-10',
                            'absolute left-0'
                        )}
                        aria-label="Scroll tabs left"
                    >
                        <ChevronLeft className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors" />
                    </button>
                )}

                {/* Regular tabs section (sortable) with smooth scrolling */}
                <div
                    ref={scrollRef}
                    className={cn(
                        'flex-1 flex items-center overflow-x-auto',
                        'scroll-smooth',
                        'scrollbar-none [&::-webkit-scrollbar]:hidden',
                        '[-ms-overflow-style:none] [scrollbar-width:none]',
                        canScrollLeft && 'pl-6',
                        canScrollRight && 'pr-6'
                    )}
                >
                    <SortableContext
                        items={regularTabs.map((t) => t.id)}
                        strategy={horizontalListSortingStrategy}
                    >
                        <div className="flex items-center gap-0.5 px-1">
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

                {/* Scroll right button with smooth fade */}
                {canScrollRight && (
                    <button
                        type="button"
                        onClick={scrollRight}
                        className={cn(
                            'flex items-center justify-center w-7 h-full',
                            'bg-gradient-to-l from-gray-100/90 via-gray-100/60 to-transparent',
                            'dark:from-gray-900/90 dark:via-gray-900/60 dark:to-transparent',
                            'hover:from-gray-200/90 dark:hover:from-gray-800/90',
                            'transition-all duration-150 ease-out z-10',
                            'absolute right-[72px]'
                        )}
                        aria-label="Scroll tabs right"
                    >
                        <ChevronRight className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors" />
                    </button>
                )}

                {/* Tab actions with refined styling */}
                <div className="flex items-center px-2 gap-1 border-l border-gray-200/50 dark:border-gray-700/40 ml-auto">
                    <TabBarAction
                        icon={<PanelRight className="w-4 h-4" />}
                        tooltip="Split Right"
                        onClick={handleSplitRight}
                    />
                    <TabBarAction
                        icon={<Bot className={cn("w-4 h-4 transition-colors duration-150", isAIAgentOpen && "text-blue-500 dark:text-blue-400")} />}
                        tooltip="AI Agent"
                        onClick={toggleAIAgent}
                    />
                </div>
            </div>
        </TabBarContextMenu>
    );
};

export default TabBarWithDrag;
