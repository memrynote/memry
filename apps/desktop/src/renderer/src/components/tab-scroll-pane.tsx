/**
 * A plain scroll container wired to the tab's scroll-restore.
 *
 * Pages that own several scrollers (the project hub's tabs, folder view's
 * per-type panes) can only call `useTabScrollRestore` once per component, and
 * each pane needs its own `scrollKey`. Wrapping the div in a component gives
 * each pane its own hook instance without splitting the page apart.
 */

import { useCallback, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'

interface TabScrollPaneProps {
  /** Which scroller this is, within the tab. Must be unique per page. */
  scrollKey: string
  className?: string
  children: ReactNode
}

export function TabScrollPane({
  scrollKey,
  className,
  children
}: TabScrollPaneProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => ref.current, [])
  useTabScrollRestore({ getScrollElement, key: scrollKey })

  return (
    <div ref={ref} className={cn('min-h-0 flex-1 overflow-y-auto', className)}>
      {children}
    </div>
  )
}
