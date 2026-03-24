import type Graph from 'graphology'
import { NoteIconDisplay } from '@/lib/render-note-icon'

const TYPE_COLORS: Record<string, string> = {
  note: 'bg-accent-cyan/15 text-accent-cyan',
  journal: 'bg-accent-purple/15 text-accent-purple',
  task: 'bg-accent-orange/15 text-accent-orange',
  project: 'bg-accent-green/15 text-accent-green',
  tag: 'bg-[var(--graph-node-tag)]/15 text-[var(--graph-node-tag)]'
}

interface GraphTooltipProps {
  nodeId: string
  graph: Graph
  x: number
  y: number
}

export function GraphTooltip({ nodeId, graph, x, y }: GraphTooltipProps): React.JSX.Element | null {
  if (!graph.hasNode(nodeId)) return null

  const attrs = graph.getNodeAttributes(nodeId)
  const label = attrs.label as string
  const nodeType = attrs.nodeType as string
  const tags = (attrs.tags as string[]) ?? []
  const connectionCount = (attrs.connectionCount as number) ?? 0
  const emoji = attrs.emoji as string | null
  const isUnresolved = attrs.isUnresolved as boolean

  return (
    <div
      className="pointer-events-none absolute z-50 max-w-[240px] rounded-md border border-border bg-popover p-2.5 shadow-card"
      style={{
        left: x + 12,
        top: y + 12
      }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {emoji && <NoteIconDisplay value={emoji} className="text-sm" />}
        <span className="text-sm font-medium text-foreground truncate">{label}</span>
      </div>

      <div className="flex items-center gap-1.5 mb-1">
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TYPE_COLORS[nodeType] ?? 'bg-muted text-muted-foreground'}`}
        >
          {isUnresolved ? 'unresolved' : nodeType}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {connectionCount} connection{connectionCount !== 1 ? 's' : ''}
        </span>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {tags.slice(0, 5).map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground"
            >
              #{tag}
            </span>
          ))}
          {tags.length > 5 && (
            <span className="text-[10px] text-muted-foreground">+{tags.length - 5}</span>
          )}
        </div>
      )}
    </div>
  )
}
