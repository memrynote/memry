/**
 * Tab Bar Action Button
 * Action buttons for tab bar (split, layout, new tab)
 */

import { cn } from '@/lib/utils';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';

interface TabBarActionProps {
    /** Icon element to display */
    icon: React.ReactNode;
    /** Tooltip text */
    tooltip: string;
    /** Click handler */
    onClick: () => void;
    /** Disabled state */
    disabled?: boolean;
    /** Additional CSS classes */
    className?: string;
}

/**
 * Action button for tab bar
 */
export const TabBarAction = ({
    icon,
    tooltip,
    onClick,
    disabled = false,
    className,
}: TabBarActionProps): React.JSX.Element => {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={onClick}
                    disabled={disabled}
                    className={cn(
                        // Base styles
                        'flex h-7 w-7 items-center justify-center rounded',
                        // Colors
                        'text-gray-500 hover:text-gray-700 hover:bg-gray-200/70',
                        // Dark mode
                        'dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700',
                        // Transitions
                        'transition-colors duration-100',
                        // Disabled state
                        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                        className
                    )}
                    aria-label={tooltip}
                >
                    {icon}
                </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
                {tooltip}
            </TooltipContent>
        </Tooltip>
    );
};

export default TabBarAction;
