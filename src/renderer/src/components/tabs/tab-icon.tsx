/**
 * Tab Icon Component
 * Maps tab types to Lucide React icons
 */

import {
    Inbox,
    Home,
    ListChecks,
    Star,
    Calendar,
    CheckCircle,
    Folder,
    FileText,
    BookOpen,
    Search,
    Settings,
    Bookmark,
    File,
} from 'lucide-react';
import type { TabType } from '@/contexts/tabs/types';
import { cn } from '@/lib/utils';

interface TabIconProps {
    /** Tab type for default icon lookup */
    type: TabType;
    /** Optional override icon name */
    icon?: string;
    /** CSS classes */
    className?: string;
}

/**
 * Icon component mapping for tab icons
 */
const ICON_COMPONENTS: Record<string, React.ComponentType<{ className?: string }>> = {
    // Core icons
    inbox: Inbox,
    home: Home,
    'list-checks': ListChecks,
    star: Star,
    calendar: Calendar,
    'check-circle': CheckCircle,
    folder: Folder,
    'file-text': FileText,
    'book-open': BookOpen,
    search: Search,
    settings: Settings,
    bookmark: Bookmark,
    file: File,
};

/**
 * Default icon mapping for tab types
 */
const TYPE_TO_ICON: Record<TabType, string> = {
    inbox: 'inbox',
    inbox2: 'inbox',
    home: 'home',
    tasks: 'list-checks',     // New unified tasks tab
    'all-tasks': 'list-checks',
    today: 'star',
    upcoming: 'calendar',
    completed: 'check-circle',
    project: 'folder',
    note: 'file-text',
    journal: 'book-open',
    search: 'search',
    settings: 'settings',
    collection: 'bookmark',
};

/**
 * Renders the appropriate icon for a tab
 */
export const TabIcon = ({ type, icon, className }: TabIconProps): React.JSX.Element => {
    // Use provided icon name or fall back to type-based default
    const iconName = icon || TYPE_TO_ICON[type] || 'file';
    const IconComponent = ICON_COMPONENTS[iconName] || File;

    return <IconComponent className={cn('shrink-0', className)} />;
};

export default TabIcon;
