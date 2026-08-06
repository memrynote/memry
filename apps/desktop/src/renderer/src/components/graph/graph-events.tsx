import { useEffect, useRef } from 'react'
import { useRegisterEvents, useSigma } from '@react-sigma/core'
import { useTabActions } from '@/contexts/tabs'
import { useT } from '@memry/i18n/renderer'

/** Pointer travel (viewport px) past which a press counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3

interface DragState {
  nodeId: string
  startX: number
  startY: number
  moved: boolean
}

interface GraphEventsProps {
  onHoverNode: (nodeId: string | null) => void
  onTooltipMove: (pos: { x: number; y: number } | null) => void
  onFocusNode: (nodeId: string) => void
  onContextMenu?: (menu: { nodeId: string; x: number; y: number } | null) => void
  onNodeGrab?: (nodeId: string) => void
  onNodeDrag?: (nodeId: string, x: number, y: number) => void
  onNodeRelease?: (nodeId: string) => void
}

export function GraphEvents({
  onHoverNode,
  onTooltipMove,
  onFocusNode,
  onContextMenu,
  onNodeGrab,
  onNodeDrag,
  onNodeRelease
}: GraphEventsProps): null {
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const { openTab } = useTabActions()
  const { t } = useT('graph')
  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)

  useEffect(() => {
    registerEvents({
      enterNode: ({ node, event }) => {
        onHoverNode(node)
        onTooltipMove({ x: event.x, y: event.y })
        if (!dragRef.current) document.body.style.cursor = 'pointer'
      },
      leaveNode: () => {
        onHoverNode(null)
        onTooltipMove(null)
        if (!dragRef.current) document.body.style.cursor = 'default'
      },
      downNode: ({ node, event }) => {
        dragRef.current = { nodeId: node, startX: event.x, startY: event.y, moved: false }
        document.body.style.cursor = 'grabbing'
        onNodeGrab?.(node)
      },
      mousemovebody: (event) => {
        const drag = dragRef.current
        if (!drag) return

        if (!drag.moved) {
          const travel = Math.hypot(event.x - drag.startX, event.y - drag.startY)
          if (travel > DRAG_THRESHOLD_PX) drag.moved = true
        }

        const { x, y } = sigma.viewportToGraph({ x: event.x, y: event.y })
        onNodeDrag?.(drag.nodeId, x, y)

        // Without this sigma pans the camera while we are moving a node.
        event.preventSigmaDefault()
      },
      mouseup: () => {
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        suppressClickRef.current = drag.moved
        document.body.style.cursor = 'pointer'
        onNodeRelease?.(drag.nodeId)
      },
      clickNode: ({ node }) => {
        onContextMenu?.(null)
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        openNodeInTab(sigma, openTab, node, t('context-menu.untitled'))
      },
      rightClickNode: ({ node, event }) => {
        event.preventSigmaDefault()
        onContextMenu?.({ nodeId: node, x: event.x, y: event.y })
      },
      clickStage: () => {
        onContextMenu?.(null)
      }
    })
  }, [
    sigma,
    registerEvents,
    openTab,
    onHoverNode,
    onTooltipMove,
    onFocusNode,
    onContextMenu,
    onNodeGrab,
    onNodeDrag,
    onNodeRelease,
    t
  ])

  return null
}

function openNodeInTab(
  sigma: ReturnType<typeof useSigma>,
  openTab: ReturnType<typeof useTabActions>['openTab'],
  node: string,
  untitledLabel: string
): void {
  const graph = sigma.getGraph()
  if (!graph.hasNode(node)) return

  const attrs = graph.getNodeAttributes(node)
  const nodeType = attrs.nodeType as string
  const isUnresolved = attrs.isUnresolved as boolean

  if (isUnresolved) return

  const tabTypeMap: Record<string, string> = {
    note: 'note',
    journal: 'journal',
    task: 'tasks',
    project: 'project'
  }

  const tabType = tabTypeMap[nodeType]
  if (!tabType) return

  openTab({
    type: tabType as 'note' | 'journal' | 'tasks' | 'project',
    title: (attrs.label as string) || untitledLabel,
    icon:
      tabType === 'note'
        ? 'file-text'
        : tabType === 'journal'
          ? 'book-open'
          : tabType === 'project'
            ? 'folder'
            : 'list-checks',
    path: `/${nodeType}/${node}`,
    entityId: node,
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false
  })
}
