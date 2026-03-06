/**
 * Split View Container Component
 * Root component for the split view layout
 */

import { useTabs } from '@/contexts/tabs'
import { SplitLayoutRenderer } from './split-layout-renderer'
import { cn } from '@/lib/utils'

interface SplitViewContainerProps {
  /** Additional CSS classes */
  className?: string
  /** Hide tab bars in panes (when shown in main header instead) */
  hideTabBars?: boolean
}

/**
 * Root container for split view layout
 */
export const SplitViewContainer = ({
  className,
  hideTabBars = false
}: SplitViewContainerProps): React.JSX.Element => {
  const { state } = useTabs()

  return (
    <div className={cn('flex-1 flex overflow-hidden', className)}>
      <SplitLayoutRenderer layout={state.layout} path={[]} hideTabBars={hideTabBars} />
    </div>
  )
}

export default SplitViewContainer
