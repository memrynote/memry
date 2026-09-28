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

interface LinkState {
  sourceId: string
  fromX: number
  fromY: number
}

/** A link gesture in progress, in viewport pixels relative to the sigma container. */
export interface LinkDragState extends LinkState {
  x: number
  y: number
}

interface GraphEventsProps {
  onHoverNode: (nodeId: string | null) => void
  onTooltipMove: (pos: { x: number; y: number } | null) => void
  onFocusNode: (nodeId: string) => void
  onContextMenu?: (menu: { nodeId: string; x: number; y: number } | null) => void
  onNodeGrab?: (nodeId: string) => void
  onNodeDrag?: (nodeId: string, x: number, y: number) => void
  onNodeRelease?: (nodeId: string) => void
  /** Whether an Alt-press on this node may start a link gesture. */
  canStartLink?: (nodeId: string) => boolean
  onLinkDrag?: (drag: LinkDragState | null) => void
  /** Fired when an Alt-drag is released over a different node. */
  onLinkDrop?: (sourceId: string, targetId: string) => void
}

/** Alt on Windows/Linux, Option on macOS. `original` is absent on synthetic events. */
function isAltPress(original: MouseEvent | TouchEvent | undefined): boolean {
  return original?.altKey === true
}

export function GraphEvents({
  onHoverNode,
  onTooltipMove,
  onFocusNode,
  onContextMenu,
  onNodeGrab,
  onNodeDrag,
  onNodeRelease,
  canStartLink,
  onLinkDrag,
  onLinkDrop
}: GraphEventsProps): null {
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const { openTab } = useTabActions()
  const { t } = useT('graph')
  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)
  const linkRef = useRef<LinkState | null>(null)
  const hoveredRef = useRef<string | null>(null)

  useEffect(() => {
    /**
     * `commit` is false when the gesture was interrupted (focus lost, pointer
     * cancelled): a link is only written for a real release over a node.
     */
    const endGesture = (commit: boolean): void => {
      const link = linkRef.current
      if (link) {
        linkRef.current = null
        // A release on the canvas is followed by a DOM click, which sigma turns
        // into a click on whatever is under the pointer; that must not open the
        // node. An interrupted gesture gets no click, so nothing to suppress.
        suppressClickRef.current = commit
        document.body.style.cursor = hoveredRef.current ? 'pointer' : 'default'
        onLinkDrag?.(null)
        const targetId = hoveredRef.current
        if (commit && targetId && targetId !== link.sourceId) onLinkDrop?.(link.sourceId, targetId)
        return
      }

      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      suppressClickRef.current = drag.moved
      document.body.style.cursor = 'pointer'
      onNodeRelease?.(drag.nodeId)
    }
    const endDrag = (): void => endGesture(true)
    const cancelDrag = (): void => endGesture(false)

    registerEvents({
      enterNode: ({ node, event }) => {
        hoveredRef.current = node
        onHoverNode(node)
        onTooltipMove({ x: event.x, y: event.y })
        if (!dragRef.current && !linkRef.current) document.body.style.cursor = 'pointer'
      },
      leaveNode: () => {
        hoveredRef.current = null
        onHoverNode(null)
        onTooltipMove(null)
        if (!dragRef.current && !linkRef.current) document.body.style.cursor = 'default'
      },
      downNode: ({ node, event }) => {
        if (onLinkDrop && isAltPress(event.original) && (canStartLink?.(node) ?? true)) {
          linkRef.current = { sourceId: node, fromX: event.x, fromY: event.y }
          document.body.style.cursor = 'crosshair'
          onLinkDrag?.({ ...linkRef.current, x: event.x, y: event.y })
          return
        }
        dragRef.current = { nodeId: node, startX: event.x, startY: event.y, moved: false }
        document.body.style.cursor = 'grabbing'
        onNodeGrab?.(node)
      },
      mousemovebody: (event) => {
        const link = linkRef.current
        if (link) {
          onLinkDrag?.({ ...link, x: event.x, y: event.y })
          event.preventSigmaDefault()
          return
        }

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
      mouseup: endDrag,
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
        // A drag released over empty canvas never reaches clickNode, so the
        // suppression it armed has to be dropped here or it eats the next click.
        suppressClickRef.current = false
        onContextMenu?.(null)
      }
    })

    // Sigma only learns a drag is over from its own mouseup. A pointer released
    // past the window edge, focus lost mid-drag, or a pointer the browser hands
    // elsewhere never delivers one — the node would stay pinned and the physics
    // simulation held at its drag alpha, so the frame loop would never park.
    // Capture phase, so nothing in between can swallow the release.
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', cancelDrag, true)
    // Bubble phase: `blur` does not bubble, but capturing it here would end the
    // drag every time any field in the app loses focus.
    window.addEventListener('blur', cancelDrag, false)

    return () => {
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', cancelDrag, true)
      window.removeEventListener('blur', cancelDrag, false)
    }
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
    canStartLink,
    onLinkDrag,
    onLinkDrop,
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
