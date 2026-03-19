import { useTabs } from '@/contexts/tabs'
import { SplitLayoutRenderer } from './split-layout-renderer'
import { cn } from '@/lib/utils'

interface SplitViewContainerProps {
  className?: string
}

export const SplitViewContainer = ({ className }: SplitViewContainerProps): React.JSX.Element => {
  const { state } = useTabs()

  return (
    <div
      className={cn('flex-1 flex overflow-hidden', className)}
      data-testid="split-view-container"
    >
      <SplitLayoutRenderer layout={state.layout} path={[]} />
    </div>
  )
}

export default SplitViewContainer
