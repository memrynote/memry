import { useEffect } from 'react'
import { useRegisterEvents, useSigma } from '@react-sigma/core'
import { useTabActions } from '@/contexts/tabs'

interface GraphEventsProps {
  onHoverNode: (nodeId: string | null) => void
  onTooltipMove: (pos: { x: number; y: number } | null) => void
  onFocusNode: (nodeId: string) => void
  onContextMenu?: (menu: { nodeId: string; x: number; y: number } | null) => void
}

export function GraphEvents({
  onHoverNode,
  onTooltipMove,
  onFocusNode,
  onContextMenu
}: GraphEventsProps): null {
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const { openTab } = useTabActions()

  useEffect(() => {
    registerEvents({
      enterNode: ({ node, event }) => {
        onHoverNode(node)
        onTooltipMove({ x: event.x, y: event.y })
        document.body.style.cursor = 'pointer'
      },
      leaveNode: () => {
        onHoverNode(null)
        onTooltipMove(null)
        document.body.style.cursor = 'default'
      },
      clickNode: ({ node }) => {
        onContextMenu?.(null)
        openNodeInTab(sigma, openTab, node)
      },
      rightClickNode: ({ node, event }) => {
        event.preventSigmaDefault()
        onContextMenu?.({ nodeId: node, x: event.x, y: event.y })
      },
      clickStage: () => {
        onContextMenu?.(null)
      }
    })
  }, [sigma, registerEvents, openTab, onHoverNode, onTooltipMove, onFocusNode, onContextMenu])

  return null
}

function openNodeInTab(
  sigma: ReturnType<typeof useSigma>,
  openTab: ReturnType<typeof useTabActions>['openTab'],
  node: string
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
    title: (attrs.label as string) || 'Untitled',
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
    isPreview: true,
    isDeleted: false
  })
}
