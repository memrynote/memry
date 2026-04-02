export interface TagTreeNode {
  name: string
  fullPath: string
  color: string | null
  ownCount: number
  totalCount: number
  children: TagTreeNode[]
  depth: number
  isVirtual: boolean
}

interface FlatTag {
  tag: string
  count: number
  color?: string | null
}

interface BuildNode {
  name: string
  fullPath: string
  color: string | null
  ownCount: number
  childrenMap: Map<string, BuildNode>
  isVirtual: boolean
}

export function buildTagTree(flatTags: FlatTag[]): TagTreeNode[] {
  const rootChildren = new Map<string, BuildNode>()

  for (const { tag, count, color } of flatTags) {
    const segments = tag.split('/')
    let currentMap = rootChildren

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const fullPath = segments.slice(0, i + 1).join('/')
      const isLeaf = i === segments.length - 1

      let node = currentMap.get(segment)
      if (!node) {
        node = {
          name: segment,
          fullPath,
          color: isLeaf ? (color ?? null) : null,
          ownCount: isLeaf ? count : 0,
          childrenMap: new Map(),
          isVirtual: !isLeaf
        }
        currentMap.set(segment, node)
      } else if (isLeaf) {
        node.ownCount = count
        node.color = color ?? node.color
        node.isVirtual = false
      }

      currentMap = node.childrenMap
    }
  }

  return buildTreeFromMap(rootChildren, 0)
}

function buildTreeFromMap(map: Map<string, BuildNode>, depth: number): TagTreeNode[] {
  const nodes: TagTreeNode[] = []

  for (const buildNode of map.values()) {
    const children = buildTreeFromMap(buildNode.childrenMap, depth + 1)
    const childTotal = children.reduce((sum, c) => sum + c.totalCount, 0)

    nodes.push({
      name: buildNode.name,
      fullPath: buildNode.fullPath,
      color: buildNode.color,
      ownCount: buildNode.ownCount,
      totalCount: buildNode.ownCount + childTotal,
      children,
      depth,
      isVirtual: buildNode.isVirtual
    })
  }

  return nodes.sort((a, b) => b.totalCount - a.totalCount)
}

export function flattenTree(nodes: TagTreeNode[]): TagTreeNode[] {
  const result: TagTreeNode[] = []
  for (const node of nodes) {
    result.push(node)
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children))
    }
  }
  return result
}

export function findTreeNode(nodes: TagTreeNode[], fullPath: string): TagTreeNode | null {
  for (const node of nodes) {
    if (node.fullPath === fullPath) return node
    if (fullPath.startsWith(node.fullPath + '/')) {
      const found = findTreeNode(node.children, fullPath)
      if (found) return found
    }
  }
  return null
}
