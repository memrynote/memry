/**
 * Sortable Tab Component
 * Wrapper that enables drag-to-reorder functionality for tabs
 */

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Tab } from '@/contexts/tabs/types';
import { RegularTab } from './regular-tab';
import { TabContextMenu } from './tab-context-menu';
import { cn } from '@/lib/utils';

interface SortableTabProps {
    /** Tab data */
    tab: Tab;
    /** Group ID this tab belongs to */
    groupId: string;
    /** Whether this is the active tab */
    isActive: boolean;
}

/**
 * Sortable wrapper for RegularTab with dnd-kit integration and context menu
 */
export const SortableTab = ({
    tab,
    groupId,
    isActive,
}: SortableTabProps): React.JSX.Element => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
        isOver,
    } = useSortable({
        id: tab.id,
        data: {
            type: 'tab',
            tab,
            groupId,
        },
    });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 1000 : 'auto',
    };

    return (
        <TabContextMenu tab={tab} groupId={groupId}>
            <div
                ref={setNodeRef}
                style={style}
                className={cn(
                    'relative',
                    // Drop indicator
                    isOver &&
                    'before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:bg-blue-500 before:rounded-full'
                )}
                {...attributes}
                {...listeners}
            >
                <RegularTab
                    tab={tab}
                    groupId={groupId}
                    isActive={isActive}
                    className={cn(isDragging && 'opacity-50')}
                />
            </div>
        </TabContextMenu>
    );
};

export default SortableTab;

