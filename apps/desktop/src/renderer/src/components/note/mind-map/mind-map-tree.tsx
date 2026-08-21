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
 */

import type { MindMapPositionedNode } from './mind-map-types'

interface MindMapTreeProps {
  nodes: readonly MindMapPositionedNode[]
  /** Translated; names the note the tree belongs to. */
  label: string
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
  level
}: {
  branches: Branch[]
  level: number
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
          data-mind-map-node={branch.node.id}
          data-mind-map-block={branch.node.blockId ?? undefined}
        >
          <span>{branch.node.label}</span>
          {branch.children.length > 0 && (
            <ul role="group">
              <BranchItems branches={branch.children} level={level + 1} />
            </ul>
          )}
        </li>
      ))}
    </>
  )
}

export function MindMapTree({ nodes, label }: MindMapTreeProps): React.JSX.Element {
  return (
    <ul role="tree" aria-label={label} className="sr-only" data-testid="mind-map-tree">
      <BranchItems branches={toBranches(nodes)} level={1} />
    </ul>
  )
}
