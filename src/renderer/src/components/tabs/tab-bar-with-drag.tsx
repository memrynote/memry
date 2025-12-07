/**
 * Tab Bar with Drag Support
 * Tab bar container with drag-to-reorder functionality
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import {
    DndContext,
    DragOverlay,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    type DragStartEvent,
    type DragEndEvent,
    type DragOverEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ChevronLeft, ChevronRight, PanelRight, PanelBottom, Plus } from 'lucide-react';
import { useTabGroup, useTabs } from '@/contexts/tabs';
import { SortableTab } from './sortable-tab';
import { PinnedTab } from './pinned-tab';
import { TabBarAction } from './tab-bar-action';
import { TabDragOverlay } from './tab-drag-overlay';
import { TabBarContextMenu } from './tab-bar-context-menu';
import { cn } from '@/lib/utils';
import type { Tab } from '@/contexts/tabs/types';

interface TabBarWithDragProps {
    /** ID of the tab group to display */
    groupId: string;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Tab bar with drag-to-reorder support and context menu
 */
export const TabBarWithDrag = ({
    groupId,
    className,
}: TabBarWithDragProps): React.JSX.Element | null => {
    const { state, openTab, splitView, dispatch } = useTabs();
    const group = useTabGroup(groupId);

    // Drag state
    const [activeTab, setActiveTab] = useState<Tab | null>(null);

    // Scroll state
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    // Configure drag sensors with activation delay
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5, // 5px movement to start drag
            },
        })
    );

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

    // Drag handlers
    const handleDragStart = (event: DragStartEvent): void => {
        const draggedTab = group.tabs.find((t) => t.id === event.active.id);
        if (draggedTab) {
            setActiveTab(draggedTab);
        }
    };

    const handleDragOver = (_event: DragOverEvent): void => {
        // Could be used for cross-group dragging feedback
    };

    const handleDragEnd = (event: DragEndEvent): void => {
        const { active, over } = event;
        setActiveTab(null);

        if (!over || active.id === over.id) return;

        // Check if dragging between groups (for split view)
        const sourceGroupId = active.data.current?.groupId as string | undefined;
        const targetGroupId = over.data.current?.groupId as string | undefined;

        if (sourceGroupId && targetGroupId && sourceGroupId !== targetGroupId) {
            // Cross-group move
            const targetIndex = over.data.current?.index ?? 0;
            dispatch({
                type: 'MOVE_TAB',
                payload: {
                    tabId: active.id as string,
                    fromGroupId: sourceGroupId,
                    toGroupId: targetGroupId,
                    toIndex: targetIndex,
                },
            });
        } else {
            // Same group reorder
            const oldIndex = regularTabs.findIndex((t) => t.id === active.id);
            const newIndex = regularTabs.findIndex((t) => t.id === over.id);

            if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
                // Adjust indices to account for pinned tabs
                const pinnedCount = pinnedTabs.length;
                dispatch({
                    type: 'REORDER_TABS',
                    payload: {
                        groupId,
                        fromIndex: oldIndex + pinnedCount,
                        toIndex: newIndex + pinnedCount,
                    },
                });
            }
        }
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
            },
            { groupId }
        );
    };

    // Handle split view
    const handleSplitRight = (): void => {
        splitView('horizontal', groupId);
    };

    const handleSplitDown = (): void => {
        splitView('vertical', groupId);
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
        >
            <TabBarContextMenu groupId={groupId}>
                <div
                    className={cn(
                        // Container
                        'flex items-center h-9',
                        'bg-gray-50 dark:bg-gray-900',
                        'border-b border-gray-200 dark:border-gray-700',
                        // Active group indicator
                        isActiveGroup && 'bg-gray-100/50 dark:bg-gray-800/50',
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
                                    <PinnedTab
                                        key={tab.id}
                                        tab={tab}
                                        groupId={groupId}
                                        isActive={tab.id === group.activeTabId}
                                    />
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
                            icon={<PanelBottom className="w-4 h-4" />}
                            tooltip="Split Down"
                            onClick={handleSplitDown}
                        />
                        <TabBarAction
                            icon={<Plus className="w-4 h-4" />}
                            tooltip="New Tab"
                            onClick={handleNewTab}
                        />
                    </div>
                </div>
            </TabBarContextMenu>

            {/* Drag overlay */}
            <DragOverlay dropAnimation={null}>
                {activeTab ? <TabDragOverlay tab={activeTab} /> : null}
            </DragOverlay>
        </DndContext>
    );
};

export default TabBarWithDrag;
