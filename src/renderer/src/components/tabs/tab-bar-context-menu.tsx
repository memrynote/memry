/**
 * Tab Bar Context Menu
 * Right-click context menu for empty tab bar area
 */

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useTabs } from '@/contexts/tabs';

interface TabBarContextMenuProps {
    /** Group ID for this tab bar */
    groupId: string;
    /** Children to wrap */
    children: React.ReactNode;
}

/**
 * Context menu for tab bar empty area (new tab, reopen closed, etc.)
 */
export const TabBarContextMenu = ({
    groupId,
    children,
}: TabBarContextMenuProps): React.JSX.Element => {
    const { openTab, reopenClosedTab, closeAllTabs, state } = useTabs();

    const hasClosedTabs = state.recentlyClosed.length > 0;

    // Handlers
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

    const handleReopenClosed = (): void => {
        reopenClosedTab();
    };

    const handleCloseAll = (): void => {
        closeAllTabs(groupId);
    };

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">
                <ContextMenuItem onClick={handleNewTab}>
                    New Tab
                    <ContextMenuShortcut>⌘T</ContextMenuShortcut>
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem onClick={handleReopenClosed} disabled={!hasClosedTabs}>
                    Reopen Closed Tab
                    <ContextMenuShortcut>⌘⇧T</ContextMenuShortcut>
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem onClick={handleCloseAll}>
                    Close All Tabs
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
};

export default TabBarContextMenu;
