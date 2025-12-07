/**
 * Tab Context Menu
 * Right-click context menu for individual tabs
 */

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { Tab } from '@/contexts/tabs/types';
import { useTabs } from '@/contexts/tabs';

interface TabContextMenuProps {
    /** Tab data */
    tab: Tab;
    /** Group ID this tab belongs to */
    groupId: string;
    /** Children to wrap */
    children: React.ReactNode;
}

/**
 * Context menu for tab actions (close, pin, split, etc.)
 */
export const TabContextMenu = ({
    tab,
    groupId,
    children,
}: TabContextMenuProps): React.JSX.Element => {
    const { closeTab, closeOtherTabs, closeTabsToRight, closeAllTabs, dispatch, state } = useTabs();

    const group = state.tabGroups[groupId];
    const tabIndex = group?.tabs.findIndex((t) => t.id === tab.id) ?? -1;
    const hasTabsToRight = tabIndex < (group?.tabs.length ?? 0) - 1;
    const hasOtherTabs = (group?.tabs.length ?? 0) > 1;

    // Handlers
    const handleClose = (): void => {
        closeTab(tab.id, groupId);
    };

    const handleCloseOthers = (): void => {
        closeOtherTabs(tab.id, groupId);
    };

    const handleCloseToRight = (): void => {
        closeTabsToRight(tab.id, groupId);
    };

    const handleCloseAll = (): void => {
        closeAllTabs(groupId);
    };

    const handlePin = (): void => {
        dispatch({
            type: tab.isPinned ? 'UNPIN_TAB' : 'PIN_TAB',
            payload: { tabId: tab.id, groupId },
        });
    };

    const handleDuplicate = (): void => {
        dispatch({
            type: 'OPEN_TAB',
            payload: {
                tab: {
                    ...tab,
                    isPinned: false,
                    isPreview: false,
                    isModified: false,
                },
                groupId,
            },
        });
    };

    const handleSplitRight = (): void => {
        dispatch({
            type: 'MOVE_TAB_TO_NEW_SPLIT',
            payload: {
                tabId: tab.id,
                fromGroupId: groupId,
                direction: 'right',
            },
        });
    };

    const handleSplitDown = (): void => {
        dispatch({
            type: 'MOVE_TAB_TO_NEW_SPLIT',
            payload: {
                tabId: tab.id,
                fromGroupId: groupId,
                direction: 'down',
            },
        });
    };

    const handleCopyPath = (): void => {
        navigator.clipboard.writeText(tab.path);
    };

    const handleRevealInSidebar = (): void => {
        // Emit custom event for sidebar to handle
        window.dispatchEvent(
            new CustomEvent('reveal-in-sidebar', {
                detail: { path: tab.path, entityId: tab.entityId },
            })
        );
    };

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
                {/* Close actions */}
                <ContextMenuItem onClick={handleClose}>
                    Close
                    <ContextMenuShortcut>⌘W</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCloseOthers} disabled={!hasOtherTabs}>
                    Close Others
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCloseToRight} disabled={!hasTabsToRight}>
                    Close to the Right
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCloseAll}>
                    Close All
                </ContextMenuItem>

                <ContextMenuSeparator />

                {/* Tab actions */}
                <ContextMenuItem onClick={handlePin}>
                    {tab.isPinned ? 'Unpin Tab' : 'Pin Tab'}
                </ContextMenuItem>
                <ContextMenuItem onClick={handleDuplicate}>
                    Duplicate Tab
                </ContextMenuItem>

                <ContextMenuSeparator />

                {/* Split actions */}
                <ContextMenuItem onClick={handleSplitRight}>
                    Split Right
                    <ContextMenuShortcut>⌘\</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onClick={handleSplitDown}>
                    Split Down
                </ContextMenuItem>
                <ContextMenuItem disabled>
                    Move to New Window
                </ContextMenuItem>

                <ContextMenuSeparator />

                {/* Utility actions */}
                <ContextMenuItem onClick={handleCopyPath}>
                    Copy Path
                </ContextMenuItem>
                <ContextMenuItem onClick={handleRevealInSidebar}>
                    Reveal in Sidebar
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
};

export default TabContextMenu;
