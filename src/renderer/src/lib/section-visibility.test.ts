import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getSectionVisibility,
  shouldShowOverdueCelebration,
  getEmptyStateMessage,
  type SectionType,
  type SectionVisibilityContext
} from './section-visibility'

describe('section-visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getSectionVisibility', () => {
    describe('overdue section', () => {
      it('should hide when task count is 0', () => {
        const result = getSectionVisibility('overdue', 0)
        expect(result.shouldShow).toBe(false)
        expect(result.showEmptyState).toBe(false)
        expect(result.emptyStateType).toBe('none')
      })

      it('should show when there are overdue tasks', () => {
        const result = getSectionVisibility('overdue', 5)
        expect(result.shouldShow).toBe(true)
        expect(result.showEmptyState).toBe(false)
        expect(result.emptyStateType).toBe('none')
      })

      it('should show when there is exactly 1 overdue task', () => {
        const result = getSectionVisibility('overdue', 1)
        expect(result.shouldShow).toBe(true)
      })
    })

    describe('today section', () => {
      it('should always show even when empty', () => {
        const result = getSectionVisibility('today', 0)
        expect(result.shouldShow).toBe(true)
      })

      it('should show celebration empty state when empty', () => {
        const result = getSectionVisibility('today', 0)
        expect(result.showEmptyState).toBe(true)
        expect(result.emptyStateType).toBe('celebration')
      })

      it('should not show empty state when has tasks', () => {
        const result = getSectionVisibility('today', 3)
        expect(result.shouldShow).toBe(true)
        expect(result.showEmptyState).toBe(false)
        expect(result.emptyStateType).toBe('celebration')
      })

      it('should always show regardless of context', () => {
        const context: SectionVisibilityContext = { hasTasksThisWeek: false }
        const result = getSectionVisibility('today', 0, context)
        expect(result.shouldShow).toBe(true)
      })
    })

    describe('tomorrow section', () => {
      it('should show when has tasks', () => {
        const result = getSectionVisibility('tomorrow', 2)
        expect(result.shouldShow).toBe(true)
        expect(result.showEmptyState).toBe(false)
      })

      it('should hide when empty and no tasks this week', () => {
        const context: SectionVisibilityContext = { hasTasksThisWeek: false }
        const result = getSectionVisibility('tomorrow', 0, context)
        expect(result.shouldShow).toBe(false)
      })

      it('should show when empty but has tasks this week (for planning context)', () => {
        const context: SectionVisibilityContext = { hasTasksThisWeek: true }
        const result = getSectionVisibility('tomorrow', 0, context)
        expect(result.shouldShow).toBe(true)
        expect(result.showEmptyState).toBe(true)
        expect(result.emptyStateType).toBe('simple')
      })

      it('should use simple empty state type', () => {
        const context: SectionVisibilityContext = { hasTasksThisWeek: true }
        const result = getSectionVisibility('tomorrow', 0, context)
        expect(result.emptyStateType).toBe('simple')
      })
    })

    describe('upcoming section', () => {
      it('should always show even when empty', () => {
        const result = getSectionVisibility('upcoming', 0)
        expect(result.shouldShow).toBe(true)
      })

      it('should show planning empty state when empty', () => {
        const result = getSectionVisibility('upcoming', 0)
        expect(result.showEmptyState).toBe(true)
        expect(result.emptyStateType).toBe('planning')
      })

      it('should not show empty state when has tasks', () => {
        const result = getSectionVisibility('upcoming', 10)
        expect(result.shouldShow).toBe(true)
        expect(result.showEmptyState).toBe(false)
        expect(result.emptyStateType).toBe('planning')
      })
    })

    describe('no-date section', () => {
      it('should hide when empty', () => {
        const result = getSectionVisibility('no-date', 0)
        expect(result.shouldShow).toBe(false)
        expect(result.showEmptyState).toBe(false)
        expect(result.emptyStateType).toBe('none')
      })

      it('should show when has tasks', () => {
        const result = getSectionVisibility('no-date', 3)
        expect(result.shouldShow).toBe(true)
        expect(result.showEmptyState).toBe(false)
      })

      it('should never show empty state', () => {
        const result = getSectionVisibility('no-date', 0)
        expect(result.showEmptyState).toBe(false)
        expect(result.emptyStateType).toBe('none')
      })
    })

    describe('default behavior (unknown section type)', () => {
      it('should hide when empty', () => {
        // Cast to test default case
        const result = getSectionVisibility('unknown' as SectionType, 0)
        expect(result.shouldShow).toBe(false)
        expect(result.showEmptyState).toBe(false)
        expect(result.emptyStateType).toBe('none')
      })

      it('should show when has tasks', () => {
        const result = getSectionVisibility('unknown' as SectionType, 5)
        expect(result.shouldShow).toBe(true)
      })
    })

    describe('context defaults', () => {
      it('should use default context when not provided', () => {
        const result = getSectionVisibility('tomorrow', 0)
        // Default hasTasksThisWeek is false, so should hide
        expect(result.shouldShow).toBe(false)
      })
    })
  })

  describe('shouldShowOverdueCelebration', () => {
    it('should return true when going from >0 to 0', () => {
      expect(shouldShowOverdueCelebration(5, 0)).toBe(true)
    })

    it('should return true when going from 1 to 0', () => {
      expect(shouldShowOverdueCelebration(1, 0)).toBe(true)
    })

    it('should return false when staying at 0', () => {
      expect(shouldShowOverdueCelebration(0, 0)).toBe(false)
    })

    it('should return false when going from >0 to >0', () => {
      expect(shouldShowOverdueCelebration(5, 3)).toBe(false)
    })

    it('should return false when increasing from 0', () => {
      expect(shouldShowOverdueCelebration(0, 5)).toBe(false)
    })

    it('should return false when count increases', () => {
      expect(shouldShowOverdueCelebration(2, 5)).toBe(false)
    })

    it('should handle large numbers correctly', () => {
      expect(shouldShowOverdueCelebration(1000, 0)).toBe(true)
    })
  })

  describe('getEmptyStateMessage', () => {
    describe('today section', () => {
      it('should return celebration message', () => {
        const message = getEmptyStateMessage('today')
        expect(message.title).toBe('All clear for today!')
        expect(message.description).toBe('Enjoy your free time or plan ahead.')
      })
    })

    describe('tomorrow section', () => {
      it('should return planning prompt', () => {
        const message = getEmptyStateMessage('tomorrow')
        expect(message.title).toBe('No tasks scheduled')
        expect(message.description).toBe('Plan ahead by adding tasks for tomorrow.')
      })
    })

    describe('upcoming section', () => {
      it('should return scheduling prompt', () => {
        const message = getEmptyStateMessage('upcoming')
        expect(message.title).toBe('Nothing scheduled')
        expect(message.description).toBe('Add tasks with due dates to plan your week.')
      })
    })

    describe('default sections', () => {
      it('should return generic message for overdue', () => {
        const message = getEmptyStateMessage('overdue')
        expect(message.title).toBe('No tasks')
        expect(message.description).toBe('Add a task to get started.')
      })

      it('should return generic message for no-date', () => {
        const message = getEmptyStateMessage('no-date')
        expect(message.title).toBe('No tasks')
        expect(message.description).toBe('Add a task to get started.')
      })

      it('should return generic message for unknown section type', () => {
        const message = getEmptyStateMessage('unknown' as SectionType)
        expect(message.title).toBe('No tasks')
        expect(message.description).toBe('Add a task to get started.')
      })
    })

    it('should return object with title and description', () => {
      const message = getEmptyStateMessage('today')
      expect(message).toHaveProperty('title')
      expect(message).toHaveProperty('description')
      expect(typeof message.title).toBe('string')
      expect(typeof message.description).toBe('string')
    })
  })

  describe('integration scenarios', () => {
    it('should correctly handle empty inbox with no tasks anywhere', () => {
      const context: SectionVisibilityContext = { hasTasksThisWeek: false }

      const overdue = getSectionVisibility('overdue', 0, context)
      const today = getSectionVisibility('today', 0, context)
      const tomorrow = getSectionVisibility('tomorrow', 0, context)
      const upcoming = getSectionVisibility('upcoming', 0, context)
      const noDate = getSectionVisibility('no-date', 0, context)

      // Overdue: hidden (good - no overdue is positive)
      expect(overdue.shouldShow).toBe(false)

      // Today: shown with celebration
      expect(today.shouldShow).toBe(true)
      expect(today.showEmptyState).toBe(true)

      // Tomorrow: hidden (no planning context)
      expect(tomorrow.shouldShow).toBe(false)

      // Upcoming: shown with planning prompt
      expect(upcoming.shouldShow).toBe(true)
      expect(upcoming.showEmptyState).toBe(true)

      // No date: hidden
      expect(noDate.shouldShow).toBe(false)
    })

    it('should correctly handle active week with tasks in various sections', () => {
      const context: SectionVisibilityContext = { hasTasksThisWeek: true }

      const overdue = getSectionVisibility('overdue', 2, context)
      const today = getSectionVisibility('today', 3, context)
      const tomorrow = getSectionVisibility('tomorrow', 0, context)
      const upcoming = getSectionVisibility('upcoming', 5, context)
      const noDate = getSectionVisibility('no-date', 1, context)

      // All sections with tasks should show
      expect(overdue.shouldShow).toBe(true)
      expect(today.shouldShow).toBe(true)
      expect(upcoming.shouldShow).toBe(true)
      expect(noDate.shouldShow).toBe(true)

      // Tomorrow shows because hasTasksThisWeek is true
      expect(tomorrow.shouldShow).toBe(true)
      expect(tomorrow.showEmptyState).toBe(true)
    })
  })
})
