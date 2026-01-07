/**
 * Accessible Tab Panel Component
 * Content area with proper ARIA attributes
 */

import type { Tab } from '@/contexts/tabs/types'
import { cn } from '@/lib/utils'

interface AccessibleTabPanelProps {
  /** Tab data */
  tab: Tab
  /** Children content */
  children: React.ReactNode
  /** Additional CSS classes */
  className?: string
}

/**
 * Accessible tab panel with ARIA labelledby
 */
export const AccessibleTabPanel = ({
  tab,
  children,
  className
}: AccessibleTabPanelProps): React.JSX.Element => {
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${tab.id}`}
      aria-labelledby={`tab-${tab.id}`}
      tabIndex={0}
      className={cn(
        'h-full outline-none',
        'focus:ring-2 focus:ring-blue-500 focus:ring-inset',
        className
      )}
    >
      {children}
    </div>
  )
}

export default AccessibleTabPanel
