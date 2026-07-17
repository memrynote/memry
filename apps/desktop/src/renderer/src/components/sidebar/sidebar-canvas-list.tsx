/**
 * SidebarCanvasList Component
 * Displays the vault's canvases in the sidebar.
 * Clicking a canvas opens it in a tab (one tab per canvas, deduped by entityId).
 */

import * as React from 'react'
import { PenTool } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { SidebarMenuItem, SidebarMenuButton } from '@/components/ui/sidebar'
import {
  canvasService,
  onCanvasCreated,
  onCanvasUpdated,
  onCanvasDeleted,
  type CanvasSummary
} from '@/services/canvas-service'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import type { SidebarItem } from '@/contexts/tabs/types'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('SpatialCanvas')

interface SidebarCanvasListProps {
  /** Callback when a canvas is clicked */
  onCanvasClick?: (canvas: CanvasSummary) => void
  /** Custom class name */
  className?: string
}

export function SidebarCanvasList({
  onCanvasClick,
  className
}: SidebarCanvasListProps): React.JSX.Element {
  const { t } = useT('common')
  const { isActiveItem } = useSidebarNavigation()
  const [canvases, setCanvases] = React.useState<CanvasSummary[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [hasError, setHasError] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const result = await canvasService.list()
      setCanvases(result.canvases)
      setHasError(false)
    } catch (err) {
      log.error('Failed to load canvases', err)
      setHasError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    const unsubscribes = [
      onCanvasCreated(() => void refresh()),
      onCanvasUpdated(() => void refresh()),
      onCanvasDeleted(() => void refresh())
    ]
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [refresh])

  if (isLoading) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">{t('canvas.loading')}</span>
      </div>
    )
  }

  if (hasError) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-destructive">{t('canvas.loadFailed')}</span>
      </div>
    )
  }

  if (canvases.length === 0) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">{t('canvas.empty')}</span>
      </div>
    )
  }

  return (
    <div className={className}>
      {canvases.map((canvas) => {
        const title = canvas.title || t('canvas.untitled')
        const sidebarItem: SidebarItem = {
          type: 'canvas',
          title,
          path: `/canvas/${canvas.id}`,
          entityId: canvas.id
        }

        return (
          <SidebarMenuItem key={canvas.id}>
            <SidebarMenuButton
              tooltip={title}
              onClick={() => onCanvasClick?.(canvas)}
              isActive={isActiveItem(sidebarItem)}
            >
              <PenTool className="size-4 shrink-0 text-sidebar-foreground" aria-hidden="true" />
              <span className="sidebar-label-fade flex-1 text-[13px] text-sidebar-text-folder font-medium">
                {title}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </div>
  )
}

export default SidebarCanvasList
