import { describe, it, expect } from 'vitest'
import {
  insertSplitAtGroup,
  removeGroupFromLayout,
  countPanes,
  findGroupPath,
  getGroupIdsFromLayout,
  hasGroupInLayout,
  getSiblingGroupId,
  updateRatioAtPath
} from '../layout-helpers'
import type { SplitLayout } from '../../../contexts/tabs/types'

describe('layout-helpers', () => {
  describe('insertSplitAtGroup', () => {
    it('creates horizontal split from leaf', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }

      const result = insertSplitAtGroup(layout, 'g1', 'g2', 'horizontal')

      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.direction).toBe('horizontal')
        expect(result.ratio).toBe(0.5)
        expect(result.first).toEqual({ type: 'leaf', tabGroupId: 'g1' })
        expect(result.second).toEqual({ type: 'leaf', tabGroupId: 'g2' })
      }
    })

    it('creates vertical split from leaf', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }

      const result = insertSplitAtGroup(layout, 'g1', 'g2', 'vertical')

      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.direction).toBe('vertical')
      }
    })

    it('inserts at nested position', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      }

      const result = insertSplitAtGroup(layout, 'g2', 'g3', 'vertical')

      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.first).toEqual({ type: 'leaf', tabGroupId: 'g1' })
        expect(result.second.type).toBe('split')
        if (result.second.type === 'split') {
          expect(result.second.direction).toBe('vertical')
          expect(result.second.first).toEqual({ type: 'leaf', tabGroupId: 'g2' })
          expect(result.second.second).toEqual({ type: 'leaf', tabGroupId: 'g3' })
        }
      }
    })

    it('respects position=first', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }

      const result = insertSplitAtGroup(layout, 'g1', 'g2', 'horizontal', 'first')

      if (result.type === 'split') {
        expect(result.first).toEqual({ type: 'leaf', tabGroupId: 'g2' })
        expect(result.second).toEqual({ type: 'leaf', tabGroupId: 'g1' })
      }
    })

    it('returns layout unchanged for non-matching group', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }

      const result = insertSplitAtGroup(layout, 'g999', 'g2', 'horizontal')

      expect(result).toEqual(layout)
    })
  })

  describe('removeGroupFromLayout', () => {
    it('returns sibling for 2-leaf tree', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      }

      const result = removeGroupFromLayout(layout, 'g1')

      expect(result).toEqual({ type: 'leaf', tabGroupId: 'g2' })
    })

    it('handles deep nesting', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', tabGroupId: 'g2' },
          second: { type: 'leaf', tabGroupId: 'g3' }
        }
      }

      const result = removeGroupFromLayout(layout, 'g2')

      expect(result).not.toBeNull()
      if (result && result.type === 'split') {
        expect(result.first).toEqual({ type: 'leaf', tabGroupId: 'g1' })
        expect(result.second).toEqual({ type: 'leaf', tabGroupId: 'g3' })
      }
    })

    it('returns null when removing the only leaf', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }

      const result = removeGroupFromLayout(layout, 'g1')

      expect(result).toBeNull()
    })
  })

  describe('countPanes', () => {
    it('counts single leaf', () => {
      expect(countPanes({ type: 'leaf', tabGroupId: 'g1' })).toBe(1)
    })

    it('counts deep trees', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', tabGroupId: 'g2' },
          second: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', tabGroupId: 'g3' },
            second: { type: 'leaf', tabGroupId: 'g4' }
          }
        }
      }

      expect(countPanes(layout)).toBe(4)
    })
  })

  describe('findGroupPath', () => {
    it('returns empty path for root leaf', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }
      expect(findGroupPath(layout, 'g1')).toEqual([])
    })

    it('finds path in nested tree', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', tabGroupId: 'g2' },
          second: { type: 'leaf', tabGroupId: 'g3' }
        }
      }

      expect(findGroupPath(layout, 'g1')).toEqual([0])
      expect(findGroupPath(layout, 'g2')).toEqual([1, 0])
      expect(findGroupPath(layout, 'g3')).toEqual([1, 1])
    })

    it('returns null for non-existent group', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }
      expect(findGroupPath(layout, 'g999')).toBeNull()
    })
  })

  describe('getGroupIdsFromLayout', () => {
    it('returns all group IDs in order', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      }

      expect(getGroupIdsFromLayout(layout)).toEqual(['g1', 'g2'])
    })
  })

  describe('updateRatioAtPath', () => {
    it('updates ratio at root', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      }

      const result = updateRatioAtPath(layout, [], 0.7)

      if (result.type === 'split') {
        expect(result.ratio).toBe(0.7)
      }
    })

    it('updates ratio at nested path', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', tabGroupId: 'g2' },
          second: { type: 'leaf', tabGroupId: 'g3' }
        }
      }

      const result = updateRatioAtPath(layout, [1], 0.3)

      if (result.type === 'split' && result.second.type === 'split') {
        expect(result.second.ratio).toBe(0.3)
        expect(result.ratio).toBe(0.5) // parent unchanged
      }
    })
  })

  describe('hasGroupInLayout', () => {
    it('finds existing group', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }
      expect(hasGroupInLayout(layout, 'g1')).toBe(true)
    })

    it('returns false for missing group', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }
      expect(hasGroupInLayout(layout, 'g999')).toBe(false)
    })
  })

  describe('getSiblingGroupId', () => {
    it('returns sibling in simple split', () => {
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      }

      expect(getSiblingGroupId(layout, 'g1')).toBe('g2')
      expect(getSiblingGroupId(layout, 'g2')).toBe('g1')
    })

    it('returns null for single leaf', () => {
      const layout: SplitLayout = { type: 'leaf', tabGroupId: 'g1' }
      expect(getSiblingGroupId(layout, 'g1')).toBeNull()
    })
  })
})
