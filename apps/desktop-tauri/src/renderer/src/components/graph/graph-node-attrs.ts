/**
 * Shape of the attributes `lib/graph-builder` writes onto every graphology node.
 * Graphology and sigma hand them back as an untyped bag, so readers go through
 * `readNodeAttrs` instead of casting each field.
 */
export interface GraphNodeAttrs {
  nodeType: string
  label: string
  tags: string[]
  isOrphan: boolean
  isUnresolved: boolean
  emoji: string | null
  connectionCount: number
  memberCount: number
  categoryId: string
  groupLabel: string
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- graphology hands back its attributes as a bare object; the reader is the single typed boundary
export function readNodeAttrs(attrs: object): GraphNodeAttrs {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- graphology node attributes are an untyped bag; graph-builder is the only writer and defines this shape
  return attrs as GraphNodeAttrs
}

export interface GraphEdgeAttrs {
  color: string
  size: number | undefined
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- graphology hands back its attributes as a bare object; the reader is the single typed boundary
export function readEdgeAttrs(attrs: object): GraphEdgeAttrs {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- graphology edge attributes are an untyped bag; callers only read color/size, as graph-builder wrote them
  return attrs as GraphEdgeAttrs
}
