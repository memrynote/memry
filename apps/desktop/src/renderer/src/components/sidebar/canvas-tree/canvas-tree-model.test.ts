import { describe, it, expect } from 'vitest'
import type { CanvasSummary } from '@/services/canvas-service'
import type { CanvasFolder } from '@/services/canvas-folder-service'
import {
  buildCanvasTree,
  collectFolderPaths,
  filterCanvasTree,
  flattenVisible,
  canDrop,
  folderSubtreeDepth,
  rewriteExpandedFolderPaths,
  splitFolderPath,
  MAX_CANVAS_FOLDER_DEPTH,
  type CanvasTreeNode
} from './canvas-tree-model'

function canvas(id: string, title: string | null, folder: string | null = null): CanvasSummary {
  return { id, title, folder, icon: null, createdAt: 0, updatedAt: 0 }
}

function folder(path: string, icon: string | null = null): CanvasFolder {
  return { id: `folder-${path}`, path, icon, createdAt: 0, updatedAt: 0 }
}

function label(node: CanvasTreeNode): string {
  return node.kind === 'folder' ? node.name : (node.canvas.title ?? '')
}

/** Narrows a node to a folder so `children` is reachable without `any`. */
function asFolder(node: CanvasTreeNode | undefined): Extract<CanvasTreeNode, { kind: 'folder' }> {
  if (!node || node.kind !== 'folder') {
    throw new Error(`expected a folder node, got ${node ? node.kind : 'nothing'}`)
  }
  return node
}

describe('buildCanvasTree', () => {
  it('puts folders before canvases and sorts each alphabetically', () => {
    const tree = buildCanvasTree(
      [canvas('b', 'Beta'), canvas('a', 'Alpha')],
      [folder('Zoo'), folder('Ark')]
    )
    expect(tree.map(label)).toEqual(['Ark', 'Zoo', 'Alpha', 'Beta'])
  })

  it('nests canvases under their folder', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work')], [folder('Work')])
    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe('folder')
    expect(label(asFolder(tree[0]).children[0])).toBe('Plan')
  })

  it('materializes a missing intermediate folder', () => {
    // A canvas can arrive from sync before its folder row does; dropping it
    // would make the user's canvas invisible.
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work/Q3')], [])
    expect(label(tree[0])).toBe('Work')
    const q3 = asFolder(asFolder(tree[0]).children[0])
    expect(label(q3)).toBe('Q3')
    expect(label(q3.children[0])).toBe('Plan')
  })

  it('sorts case-insensitively', () => {
    const tree = buildCanvasTree([canvas('a', 'zebra'), canvas('b', 'Apple')], [])
    expect(tree.map(label)).toEqual(['Apple', 'zebra'])
  })

  it('treats names differing only in case as equal, keeping the input order', () => {
    // `sensitivity: 'base'` — without it `Alpha` sorts AFTER `alpha`, which
    // reads as an arbitrary shuffle of two names the user sees as the same.
    const tree = buildCanvasTree([canvas('a', 'Alpha'), canvas('b', 'alpha')], [])
    expect(tree.map((node) => (node.kind === 'canvas' ? node.canvas.id : node.path))).toEqual([
      'a',
      'b'
    ])
  })

  it('sorts locale-aware rather than by code unit', () => {
    // 'É' (U+00C9) sorts after 'Z' by code unit, before it by locale.
    const tree = buildCanvasTree([canvas('a', 'Zebra'), canvas('b', 'Éclair')], [])
    expect(tree.map(label)).toEqual(['Éclair', 'Zebra'])
  })

  it('carries the folder row icon and leaves a materialized ancestor without one', () => {
    const tree = buildCanvasTree([], [folder('Work/Q3', '📌')])
    const work = asFolder(tree[0])
    expect(work.icon).toBeNull()
    expect(asFolder(work.children[0]).icon).toBe('📌')
  })

  it('merges a canvas folder that differs only in case with its folder row', () => {
    // macOS and Windows are case-insensitive: `work` and `Work` are one folder.
    const tree = buildCanvasTree([canvas('a', 'Plan', 'work/q3')], [folder('Work')])
    expect(tree).toHaveLength(1)
    const work = asFolder(tree[0])
    expect(work.name).toBe('Work')
    // The stored parent path wins, so the child path stays on-disk canonical.
    expect(asFolder(work.children[0]).path).toBe('Work/q3')
  })

  it('assigns depth by nesting level', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work/Q3')], [])
    const work = asFolder(tree[0])
    const q3 = asFolder(work.children[0])
    expect(work.depth).toBe(0)
    expect(q3.depth).toBe(1)
    expect(q3.children[0].depth).toBe(2)
  })

  it('marks a folder with no row of its own as materialized', () => {
    // Only `Work/Q3` has a row; `Work` exists purely because its child's path
    // named it, so nothing in `canvas_folders` can be renamed or re-iconed.
    const tree = buildCanvasTree([], [folder('Work/Q3')])
    const work = asFolder(tree[0])
    expect(work.materialized).toBe(true)
    expect(asFolder(work.children[0]).materialized).toBe(false)
  })

  it('marks a folder invented from a canvas path as materialized', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work')], [])
    expect(asFolder(tree[0]).materialized).toBe(true)
  })

  it('leaves a folder that has a row unmaterialized even when canvases fill it', () => {
    // The canvas is processed after the row, and merging into the row must not
    // flip the flag back.
    const tree = buildCanvasTree([canvas('a', 'Plan', 'work')], [folder('Work')])
    expect(asFolder(tree[0]).materialized).toBe(false)
  })
})

describe('folderSubtreeDepth', () => {
  it('counts the folder levels below a node', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work/Q3/Week1')], [])
    expect(folderSubtreeDepth(asFolder(tree[0]))).toBe(2)
  })

  it('is zero for a folder holding only canvases', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work')], [folder('Work')])
    expect(folderSubtreeDepth(asFolder(tree[0]))).toBe(0)
  })

  it('takes the deepest branch, not the last one', () => {
    const tree = buildCanvasTree(
      [canvas('a', 'Deep', 'Work/Q3/Week1'), canvas('b', 'Shallow', 'Work/Zoo')],
      []
    )
    expect(folderSubtreeDepth(asFolder(tree[0]))).toBe(2)
  })
})

describe('splitFolderPath', () => {
  it('splits a nested path into its parent and its leaf', () => {
    expect(splitFolderPath('Work/Q3')).toEqual({ parent: 'Work', name: 'Q3' })
  })

  it('reports a root-level folder with a null parent', () => {
    expect(splitFolderPath('Work')).toEqual({ parent: null, name: 'Work' })
  })
})

describe('flattenVisible', () => {
  it('hides the children of a collapsed folder', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work')], [folder('Work')])
    expect(flattenVisible(tree, new Set()).map(label)).toEqual(['Work'])
  })

  it('reveals the children of an expanded folder', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work/Q3')], [])
    expect(flattenVisible(tree, new Set(['Work'])).map(label)).toEqual(['Work', 'Q3'])
    expect(flattenVisible(tree, new Set(['Work', 'Work/Q3'])).map(label)).toEqual([
      'Work',
      'Q3',
      'Plan'
    ])
  })
})

describe('canDrop', () => {
  const canvasDrag = { tree: 'canvas', kind: 'canvas', id: 'c1' } as const
  const folderDrag = { tree: 'canvas', kind: 'folder', path: 'Work' } as const

  it('accepts a canvas onto a folder or the root', () => {
    expect(canDrop(canvasDrag, 'Work')).toBe(true)
    expect(canDrop(canvasDrag, null)).toBe(true)
  })

  it('rejects a folder dropped into its own descendant', () => {
    expect(canDrop(folderDrag, 'Work/Q3')).toBe(false)
    expect(canDrop(folderDrag, 'Work')).toBe(false)
  })

  it('accepts a folder moved elsewhere', () => {
    expect(canDrop(folderDrag, 'Personal')).toBe(true)
    expect(canDrop(folderDrag, null)).toBe(true)
  })

  it('rejects payloads from another tree', () => {
    expect(canDrop({ tree: 'notes', kind: 'note', id: 'n1' }, 'Work')).toBe(false)
    expect(canDrop(undefined, 'Work')).toBe(false)
    expect(canDrop('garbage', 'Work')).toBe(false)
  })

  it('rejects a foreign folder drag even though the kind matches', () => {
    // The note tree also drags things called folders. Only the `tree` guard
    // stops one from being offered a drop into a canvas folder.
    expect(canDrop({ tree: 'notes', kind: 'folder', path: 'Personal' }, 'Work')).toBe(false)
  })

  it('rejects a canvas-tree payload with an unknown kind', () => {
    expect(canDrop({ tree: 'canvas', kind: 'mystery', id: 'x' }, 'Work')).toBe(false)
  })

  it('treats a sibling that merely shares a prefix as unrelated', () => {
    // Segment-wise, not `startsWith`: 'Workshop' is not a child of 'Work'.
    expect(canDrop(folderDrag, 'Workshop')).toBe(true)
  })

  it('rejects a descendant that differs only in case', () => {
    expect(canDrop(folderDrag, 'work/q3')).toBe(false)
  })

  /** A folder path `levels` deep — `d1/d2/...`. */
  function deep(levels: number): string {
    return Array.from({ length: levels }, (_, index) => `d${index + 1}`).join('/')
  }

  /** A folder drag carrying `subtreeDepth` folder levels beneath it. */
  function folderDragWithSubtree(subtreeDepth: number) {
    return { tree: 'canvas', kind: 'folder', path: 'Work', subtreeDepth } as const
  }

  it('accepts a move that lands exactly on the depth cap', () => {
    // 7 segments of target + the folder itself = MAX_CANVAS_FOLDER_DEPTH.
    const target = deep(MAX_CANVAS_FOLDER_DEPTH - 1)
    expect(canDrop(folderDragWithSubtree(0), target)).toBe(true)
  })

  it('rejects a move that would land one level past the cap', () => {
    // The store refuses this, so offering it shows a drop target that then does
    // nothing: the user drags, the indicator says yes, and the folder stays put.
    const target = deep(MAX_CANVAS_FOLDER_DEPTH)
    expect(canDrop(folderDragWithSubtree(0), target)).toBe(false)
  })

  it('judges a folder by its deepest descendant, not by itself', () => {
    // Two levels of children ride along, so the folder itself landing legally is
    // not enough — `relocateFolder` rewrites every descendant and caps each one.
    expect(canDrop(folderDragWithSubtree(2), deep(MAX_CANVAS_FOLDER_DEPTH - 3))).toBe(true)
    expect(canDrop(folderDragWithSubtree(2), deep(MAX_CANVAS_FOLDER_DEPTH - 2))).toBe(false)
  })

  it('applies the cap to a drop on the root as well', () => {
    expect(canDrop(folderDragWithSubtree(MAX_CANVAS_FOLDER_DEPTH - 1), null)).toBe(true)
    expect(canDrop(folderDragWithSubtree(MAX_CANVAS_FOLDER_DEPTH), null)).toBe(false)
  })

  it('accepts a canvas onto a folder sitting exactly on the depth cap', () => {
    // A canvas is a file inside a folder, so it adds no level of its own: a
    // target that is itself legal takes the canvas.
    expect(canDrop(canvasDrag, deep(MAX_CANVAS_FOLDER_DEPTH))).toBe(true)
  })

  it('rejects a canvas onto a folder stored past the depth cap', () => {
    // The target's OWN depth is what the store caps for a canvas:
    // `updateCanvas` resolves the requested folder through `storedFolderPath` →
    // `portableCanvasFolder` → `normalizeFolder`, which throws past the cap. A
    // row deeper than that reaches this device from a peer running a build with
    // a higher cap, and the tree renders it (stored paths are never capped on
    // read) — so the drop has to be refused here or it is offered and then
    // throws in the store.
    expect(canDrop(canvasDrag, deep(MAX_CANVAS_FOLDER_DEPTH + 1))).toBe(false)
  })

  it('rejects a descendant that differs only in Unicode normalization', () => {
    // macOS hands back decomposed (NFD) filenames for names the app wrote NFC.
    const nfc = 'Yağmur'.normalize('NFC')
    const nfd = 'Yağmur/Q3'.normalize('NFD')
    expect(nfd.startsWith(nfc)).toBe(false) // the bytes really do differ
    expect(canDrop({ tree: 'canvas', kind: 'folder', path: nfc }, nfd)).toBe(false)
  })
})

describe('folder canvas counts', () => {
  it('counts descendants recursively, not just direct children', () => {
    const tree = buildCanvasTree(
      [
        canvas('a', 'Alpha', 'Work'),
        canvas('b', 'Beta', 'Work/Q3'),
        canvas('c', 'Gamma', 'Work/Q3/Deep'),
        canvas('d', 'Delta')
      ],
      [folder('Work')]
    )
    const work = asFolder(tree[0])
    expect(work.canvasCount).toBe(3)
    expect(asFolder(work.children[0]).canvasCount).toBe(2)
  })

  it('reports zero for a folder holding nothing', () => {
    const tree = buildCanvasTree([], [folder('Work')])
    expect(asFolder(tree[0]).canvasCount).toBe(0)
  })
})

describe('filterCanvasTree', () => {
  const tree = (): CanvasTreeNode[] =>
    buildCanvasTree(
      [canvas('a', 'Roadmap', 'Work'), canvas('b', 'Groceries', 'Personal'), canvas('c', 'Sketch')],
      [folder('Work'), folder('Personal'), folder('Archive')]
    )

  it('returns the tree untouched for an empty query', () => {
    const built = tree()
    expect(filterCanvasTree(built, '   ')).toBe(built)
  })

  it('keeps a canvas whose title matches, and the folder holding it', () => {
    const filtered = filterCanvasTree(tree(), 'roadmap')
    expect(filtered.map(label)).toEqual(['Work'])
    expect(asFolder(filtered[0]).children.map(label)).toEqual(['Roadmap'])
  })

  it('keeps every canvas under a folder whose path matches', () => {
    const filtered = filterCanvasTree(tree(), 'personal')
    expect(filtered.map(label)).toEqual(['Personal'])
    expect(asFolder(filtered[0]).children.map(label)).toEqual(['Groceries'])
  })

  it('matches a nested folder on its full path', () => {
    const nested = buildCanvasTree([canvas('a', 'Plan', 'Work/Q3')], [folder('Work')])
    const filtered = filterCanvasTree(nested, 'work/q3')
    expect(asFolder(asFolder(filtered[0]).children[0]).children.map(label)).toEqual(['Plan'])
  })

  it('keeps a matching folder that holds nothing', () => {
    expect(filterCanvasTree(tree(), 'archive').map(label)).toEqual(['Archive'])
  })

  it('drops folders and canvases that match nothing', () => {
    expect(filterCanvasTree(tree(), 'zzz')).toEqual([])
  })

  it('recounts a filtered folder so a collapsed count cannot overstate it', () => {
    const built = buildCanvasTree(
      [canvas('a', 'Roadmap', 'Work'), canvas('b', 'Budget', 'Work')],
      [folder('Work')]
    )
    expect(asFolder(filterCanvasTree(built, 'roadmap')[0]).canvasCount).toBe(1)
  })

  it('ignores case and Unicode form', () => {
    const built = buildCanvasTree([canvas('a', 'Yağmur'.normalize('NFC'))], [])
    expect(filterCanvasTree(built, 'YAĞMUR'.normalize('NFD')).map(label)).toEqual([
      'Yağmur'.normalize('NFC')
    ])
  })
})

describe('collectFolderPaths', () => {
  it('returns every folder path in the tree, at any depth', () => {
    const built = buildCanvasTree([canvas('a', 'Plan', 'Work/Q3')], [folder('Personal')])
    expect([...collectFolderPaths(built)].sort()).toEqual(['Personal', 'Work', 'Work/Q3'])
  })
})

describe('rewriteExpandedFolderPaths', () => {
  it('re-keys the renamed folder and its descendants', () => {
    const next = rewriteExpandedFolderPaths(new Set(['Work', 'Work/Q3']), 'Work', 'Studio')
    expect([...next].sort()).toEqual(['Studio', 'Studio/Q3'])
  })

  it('leaves prefix lookalikes and unrelated folders alone', () => {
    const next = rewriteExpandedFolderPaths(new Set(['Workshop', 'Personal']), 'Work', 'Studio')
    expect([...next].sort()).toEqual(['Personal', 'Workshop'])
  })

  it('re-keys a move onto a new parent', () => {
    const next = rewriteExpandedFolderPaths(new Set(['Work/Q3']), 'Work/Q3', 'Personal/Q3')
    expect([...next]).toEqual(['Personal/Q3'])
  })
})
