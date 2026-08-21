/**
 * The map's accessible twin.
 *
 * Excalidraw draws to a bitmap: a screen reader sees nothing there, and neither
 * does a browser automation harness. This renders the *same positioned nodes*
 * as a real tree in the DOM — not a second source of truth, a second projection
 * of one layout result. It is what makes the feature usable without a mouse or
 * without sight, and it is the only way an end-to-end test can see inside the
 * drawing surface at all.
 *
 * Visually hidden rather than absent: the picture is the visual presentation,
 * this is the same content for everyone else.
 *
 * It is also the map's keyboard surface. Focus moves with the arrow keys and
 * only one item is ever in the tab order, which is the tree pattern and is also
 * what keeps a note with fifty headings from becoming fifty invisible tab
 * stops. Enter and Space activate, and land in the same place a click does.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { MindMapNodeActivation } from './mind-map-navigation'
import type { MindMapNodeKind, MindMapPositionedNode } from './mind-map-types'

/** Kinds that carry a tick, and so have a checked state worth announcing. */
function isTickable(kind: MindMapNodeKind): boolean {
  return kind === 'check' || kind === 'task'
}

interface MindMapTreeProps {
  nodes: readonly MindMapPositionedNode[]
  /** Translated; names the note the tree belongs to. */
  label: string
  /** Called with the node the user clicked or pressed Enter/Space on. */
  onActivateNode: MindMapNodeActivation
}

interface Branch {
  node: MindMapPositionedNode
  children: Branch[]
}

/**
 * Rebuilds the nesting from the positioned nodes themselves, so the tree can
 * never describe a shape the layout did not place.
 */
function toBranches(nodes: readonly MindMapPositionedNode[]): Branch[] {
  const branches = new Map<string, Branch>()
  for (const node of nodes) branches.set(node.id, { node, children: [] })

  const roots: Branch[] = []
  for (const node of nodes) {
    const branch = branches.get(node.id)
    if (!branch) continue
    const parent = node.parentId === null ? undefined : branches.get(node.parentId)
    if (parent) parent.children.push(branch)
    else roots.push(branch)
  }
  return roots
}

function BranchItems({
  branches,
  level,
  activeId,
  onActivate,
  onFocusNode,
  onNavigate
}: {
  branches: Branch[]
  level: number
  activeId: string | null
  onActivate: MindMapNodeActivation
  onFocusNode: (nodeId: string) => void
  onNavigate: (key: string, nodeId: string) => void
}): React.JSX.Element {
  return (
    <>
      {branches.map((branch, index) => (
        <li
          key={branch.node.id}
          role="treeitem"
          aria-level={level}
          aria-posinset={index + 1}
          aria-setsize={branches.length}
          aria-expanded={branch.children.length > 0 ? true : undefined}
          // A tickable item announces its tick. This is what "dimmed and struck
          // through" means to a reader who cannot see the drawing, so it is a
          // real ARIA state rather than the `data-` attribute next to it.
          aria-checked={isTickable(branch.node.kind) ? branch.node.isDone : undefined}
          data-mind-map-node={branch.node.id}
          data-mind-map-block={branch.node.blockId ?? undefined}
          data-mind-map-kind={branch.node.kind}
          data-mind-map-done={branch.node.isDone ? 'true' : undefined}
          // Roving: exactly one item is reachable with Tab, the arrows do the
          // rest. Items nest, so every handler stops here — otherwise a click
          // on a child would also activate every ancestor it sits inside.
          tabIndex={branch.node.id === activeId ? 0 : -1}
          onFocus={(event) => {
            event.stopPropagation()
            onFocusNode(branch.node.id)
          }}
          onClick={(event) => {
            event.stopPropagation()
            onActivate(branch.node)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              onActivate(branch.node)
              return
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              event.stopPropagation()
              onNavigate(event.key, branch.node.id)
            }
          }}
        >
          <span>{branch.node.label}</span>
          {/* The same composed badge line the picture draws — one string, two
              projections, so they cannot say different things. */}
          {branch.node.detail !== '' && <span> {branch.node.detail}</span>}
          {branch.children.length > 0 && (
            <ul role="group">
              <BranchItems
                branches={branch.children}
                level={level + 1}
                activeId={activeId}
                onActivate={onActivate}
                onFocusNode={onFocusNode}
                onNavigate={onNavigate}
              />
            </ul>
          )}
        </li>
      ))}
    </>
  )
}

export function MindMapTree({ nodes, label, onActivateNode }: MindMapTreeProps): React.JSX.Element {
  const treeRef = useRef<HTMLUListElement>(null)
  // Which item holds the single tab stop. It follows focus, so tabbing away and
  // back returns to where the user was rather than to the top. Seeded with the
  // first node, which the layout always emits as the root.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const activeId = focusedId ?? nodes[0]?.id ?? null

  const branches = useMemo(() => toBranches(nodes), [nodes])

  const onFocusNode = useCallback((nodeId: string) => {
    setFocusedId(nodeId)
  }, [])

  // Flat document order is what the arrows walk: it is what the reader hears,
  // and it is the order the nodes were laid out in.
  const onNavigate = useCallback((key: string, nodeId: string) => {
    const items = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []
    )
    if (items.length === 0) return
    const index = items.findIndex((item) => item.dataset.mindMapNode === nodeId)
    const next =
      key === 'Home'
        ? items[0]
        : key === 'End'
          ? items[items.length - 1]
          : key === 'ArrowDown'
            ? items[Math.min(index + 1, items.length - 1)]
            : items[Math.max(index - 1, 0)]
    next?.focus()
  }, [])

  return (
    <ul
      ref={treeRef}
      role="tree"
      aria-label={label}
      className="sr-only"
      data-testid="mind-map-tree"
    >
      <BranchItems
        branches={branches}
        level={1}
        activeId={activeId}
        onActivate={onActivateNode}
        onFocusNode={onFocusNode}
        onNavigate={onNavigate}
      />
    </ul>
  )
}
