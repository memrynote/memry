import { useEffect, useRef } from 'react'
import { Focus, ExternalLink, Copy, FilePlus } from '@/lib/icons'
import type Graph from 'graphology'

export interface ContextMenuState {
  nodeId: string
  x: number
  y: number
}

interface GraphContextMenuProps {
  menu: ContextMenuState
  graph: Graph
  onFocusNode: (nodeId: string) => void
  onOpenInTab: (nodeId: string) => void
  onCreateNote?: (title: string) => void
  onClose: () => void
}

export function GraphContextMenu({
  menu,
  graph,
  onFocusNode,
  onOpenInTab,
  onCreateNote,
  onClose
}: GraphContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleEscape(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  if (!graph.hasNode(menu.nodeId)) return <></>

  const attrs = graph.getNodeAttributes(menu.nodeId)
  const label = (attrs.label as string) || 'Untitled'
  const isUnresolved = attrs.isUnresolved as boolean

  return (
    <div
      ref={menuRef}
      className="absolute z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-card animate-in fade-in-0 zoom-in-95"
      style={{ left: menu.x, top: menu.y }}
    >
      <div className="px-2 py-1.5 mb-0.5">
        <span className="text-xs font-medium text-foreground truncate block max-w-[180px]">
          {label}
        </span>
      </div>

      <button
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
        onClick={() => {
          onFocusNode(menu.nodeId)
          onClose()
        }}
      >
        <Focus className="size-3.5 text-muted-foreground" />
        Focus on this node
      </button>

      {!isUnresolved && (
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
          onClick={() => {
            onOpenInTab(menu.nodeId)
            onClose()
          }}
        >
          <ExternalLink className="size-3.5 text-muted-foreground" />
          Open in new tab
        </button>
      )}

      {isUnresolved && onCreateNote && (
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
          onClick={() => {
            onCreateNote(label)
            onClose()
          }}
        >
          <FilePlus className="size-3.5 text-muted-foreground" />
          Create note
        </button>
      )}

      <button
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
        onClick={() => {
          navigator.clipboard.writeText(label)
          onClose()
        }}
      >
        <Copy className="size-3.5 text-muted-foreground" />
        Copy title
      </button>
    </div>
  )
}
