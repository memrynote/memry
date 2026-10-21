import { Search, SlidersHorizontal } from '@/lib/icons'
import type { Translate } from './types'

type Node = { x: number; y: number; r: number; color: string }

const NODES: Node[] = [
  { x: 250, y: 100, r: 9, color: 'project' },
  { x: 150, y: 70, r: 7, color: 'note' },
  { x: 335, y: 158, r: 5.5, color: 'task' },
  { x: 180, y: 172, r: 6.5, color: 'note' },
  { x: 78, y: 128, r: 5.5, color: 'journal' },
  { x: 372, y: 72, r: 6, color: 'note' },
  { x: 440, y: 128, r: 7.5, color: 'note' },
  { x: 470, y: 200, r: 4, color: 'note' },
  { x: 95, y: 232, r: 6, color: 'project' },
  { x: 205, y: 255, r: 4, color: 'task' },
  { x: 300, y: 238, r: 4.5, color: 'tag' },
  { x: 392, y: 222, r: 5, color: 'task' }
]

/** [from, to] node indexes; the task-to-note links are drawn in their own colour. */
const EDGES: [number, number][] = [
  [0, 1],
  [1, 3],
  [3, 4],
  [4, 1],
  [0, 5],
  [5, 6],
  [6, 7],
  [6, 0],
  [8, 4],
  [3, 8],
  [3, 10],
  [10, 11],
  [11, 6]
]
const TASK_EDGES: [number, number][] = [
  [0, 2],
  [8, 9],
  [10, 11]
]
const GHOSTS = [
  { x: 36, y: 52 },
  { x: 470, y: 262 }
]

/** Where each label sits; the nodes it names are the ones drawn at the same spot. */
const LABELS: { key: string; x: number; y: number }[] = [
  { key: 'launch', x: 190, y: 112 },
  { key: 'launchPlan', x: 90, y: 80 },
  { key: 'task2', x: 275, y: 166.5 },
  { key: 'q4Plan', x: 120, y: 181.5 },
  { key: 'date', x: 18, y: 136.5 },
  { key: 'readingList', x: 312, y: 81 },
  { key: 'ideas', x: 380, y: 138.5 },
  { key: 'fitness', x: 35, y: 241 },
  { key: 'task3', x: 332, y: 230 }
]

const NODE_COLOR: Record<string, string> = {
  project: 'var(--graph-node-project)',
  note: 'var(--graph-node-note)',
  task: 'var(--graph-node-task)',
  journal: 'var(--graph-node-journal)',
  tag: 'var(--graph-node-tag)'
}

/** A static force-graph snapshot: linked notes, a project, tasks and a journal day. */
export function GraphPane({ p }: { p: Translate }): React.JSX.Element {
  return (
    <div className="relative min-h-0 grow overflow-hidden bg-[var(--graph-bg)]">
      <div dir="ltr" className="absolute start-0 top-0 h-[290px] w-[498px]">
        <svg width="498" height="290" viewBox="0 0 498 290" className="absolute start-0 top-0">
          {EDGES.map(([from, to]) => (
            <line
              key={`${from}-${to}`}
              x1={NODES[from].x}
              y1={NODES[from].y}
              x2={NODES[to].x}
              y2={NODES[to].y}
              stroke="var(--graph-edge-default)"
              strokeOpacity={0.35}
              strokeWidth={1.4}
            />
          ))}
          {TASK_EDGES.map(([from, to]) => (
            <line
              key={`task-${from}-${to}`}
              x1={NODES[from].x}
              y1={NODES[from].y}
              x2={NODES[to].x}
              y2={NODES[to].y}
              stroke="var(--graph-edge-task-note)"
              strokeOpacity={0.5}
              strokeWidth={1.2}
            />
          ))}
          {NODES.map((node) => (
            <circle
              key={`${node.x}-${node.y}`}
              cx={node.x}
              cy={node.y}
              r={node.r}
              fill={NODE_COLOR[node.color]}
            />
          ))}
          {GHOSTS.map((ghost) => (
            <circle
              key={`${ghost.x}-${ghost.y}`}
              cx={ghost.x}
              cy={ghost.y}
              r={2.5}
              fill="var(--graph-ghost-node)"
            />
          ))}
        </svg>
        {LABELS.map((label) => (
          <span
            key={label.key}
            className="absolute w-[120px] text-center text-[10px] leading-3 text-text-secondary"
            style={{ insetInlineStart: label.x, top: label.y }}
          >
            {p(label.key)}
          </span>
        ))}
      </div>
      <div className="absolute end-3 top-3 flex items-center gap-1.5 text-text-tertiary">
        <span className="flex h-[26px] w-[150px] items-center gap-1.5 rounded-[7px] border border-border bg-surface px-2 text-[10.5px]">
          <Search className="size-[11px]" />
          {p('graphSearch')}
        </span>
        <span className="flex size-[26px] items-center justify-center rounded-[7px] border border-border bg-surface">
          <SlidersHorizontal className="size-[13px]" />
        </span>
      </div>
    </div>
  )
}
