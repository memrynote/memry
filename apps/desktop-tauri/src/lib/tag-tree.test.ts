import { describe, it, expect } from 'vitest'
import { buildTagTree, flattenTree, findTreeNode } from './tag-tree'

describe('tag-tree', () => {
  describe('buildTagTree', () => {
    it('should handle flat tags with no hierarchy', () => {
      const result = buildTagTree([
        { tag: 'react', count: 5 },
        { tag: 'typescript', count: 3 }
      ])

      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('react')
      expect(result[0].fullPath).toBe('react')
      expect(result[0].ownCount).toBe(5)
      expect(result[0].totalCount).toBe(5)
      expect(result[0].children).toEqual([])
      expect(result[0].isVirtual).toBe(false)
    })

    it('should build tree from hierarchical tags', () => {
      const result = buildTagTree([
        { tag: 'movies/oscar', count: 5, color: 'blue' },
        { tag: 'movies/grammy', count: 3, color: 'green' }
      ])

      expect(result).toHaveLength(1)

      const movies = result[0]
      expect(movies.name).toBe('movies')
      expect(movies.fullPath).toBe('movies')
      expect(movies.ownCount).toBe(0)
      expect(movies.totalCount).toBe(8)
      expect(movies.isVirtual).toBe(true)
      expect(movies.children).toHaveLength(2)

      const oscar = movies.children[0]
      expect(oscar.name).toBe('oscar')
      expect(oscar.fullPath).toBe('movies/oscar')
      expect(oscar.ownCount).toBe(5)
      expect(oscar.color).toBe('blue')
    })

    it('should handle parent with own count and children', () => {
      const result = buildTagTree([
        { tag: 'movies', count: 2, color: 'red' },
        { tag: 'movies/oscar', count: 5, color: 'blue' },
        { tag: 'movies/grammy', count: 3, color: 'green' }
      ])

      const movies = result[0]
      expect(movies.ownCount).toBe(2)
      expect(movies.totalCount).toBe(10)
      expect(movies.isVirtual).toBe(false)
      expect(movies.color).toBe('red')
    })

    it('should handle deeply nested tags', () => {
      const result = buildTagTree([{ tag: 'movies/oscar/2025/best-picture', count: 1 }])

      expect(result).toHaveLength(1)
      const movies = result[0]
      expect(movies.isVirtual).toBe(true)
      expect(movies.totalCount).toBe(1)

      const oscar = movies.children[0]
      expect(oscar.fullPath).toBe('movies/oscar')
      expect(oscar.isVirtual).toBe(true)

      const y2025 = oscar.children[0]
      expect(y2025.fullPath).toBe('movies/oscar/2025')
      expect(y2025.isVirtual).toBe(true)

      const bestPicture = y2025.children[0]
      expect(bestPicture.fullPath).toBe('movies/oscar/2025/best-picture')
      expect(bestPicture.ownCount).toBe(1)
      expect(bestPicture.isVirtual).toBe(false)
    })

    it('should sort children by totalCount descending', () => {
      const result = buildTagTree([
        { tag: 'movies/oscar', count: 2 },
        { tag: 'movies/grammy', count: 8 },
        { tag: 'movies/cannes', count: 5 }
      ])

      const children = result[0].children
      expect(children[0].name).toBe('grammy')
      expect(children[1].name).toBe('cannes')
      expect(children[2].name).toBe('oscar')
    })

    it('should handle empty input', () => {
      expect(buildTagTree([])).toEqual([])
    })

    it('should set correct depth values', () => {
      const result = buildTagTree([{ tag: 'a/b/c', count: 1 }])

      expect(result[0].depth).toBe(0)
      expect(result[0].children[0].depth).toBe(1)
      expect(result[0].children[0].children[0].depth).toBe(2)
    })

    it('should preserve color on explicit parent when children exist', () => {
      const result = buildTagTree([
        { tag: 'movies/oscar', count: 3, color: 'blue' },
        { tag: 'movies', count: 1, color: 'red' }
      ])

      const movies = result[0]
      expect(movies.color).toBe('red')
      expect(movies.isVirtual).toBe(false)
    })
  })

  describe('flattenTree', () => {
    it('should flatten tree to depth-first list', () => {
      const tree = buildTagTree([
        { tag: 'movies/oscar', count: 5 },
        { tag: 'movies/grammy', count: 3 },
        { tag: 'books', count: 10 }
      ])

      const flat = flattenTree(tree)
      const paths = flat.map((n) => n.fullPath)

      expect(paths).toContain('books')
      expect(paths).toContain('movies')
      expect(paths).toContain('movies/oscar')
      expect(paths).toContain('movies/grammy')
    })
  })

  describe('findTreeNode', () => {
    it('should find a node by full path', () => {
      const tree = buildTagTree([
        { tag: 'movies/oscar', count: 5 },
        { tag: 'movies/grammy', count: 3 }
      ])

      const oscar = findTreeNode(tree, 'movies/oscar')
      expect(oscar).not.toBeNull()
      expect(oscar!.name).toBe('oscar')
      expect(oscar!.ownCount).toBe(5)
    })

    it('should find virtual parent nodes', () => {
      const tree = buildTagTree([{ tag: 'movies/oscar', count: 5 }])

      const movies = findTreeNode(tree, 'movies')
      expect(movies).not.toBeNull()
      expect(movies!.isVirtual).toBe(true)
    })

    it('should return null for non-existent path', () => {
      const tree = buildTagTree([{ tag: 'movies/oscar', count: 5 }])

      expect(findTreeNode(tree, 'books')).toBeNull()
      expect(findTreeNode(tree, 'movies/grammy')).toBeNull()
    })
  })
})
