// ============================================================================
// SECTION VISIBILITY LOGIC
// ============================================================================
// Centralized logic for determining when sections should be shown
// and what type of empty state to display

// ============================================================================
// TYPES
// ============================================================================

export type SectionType = 'overdue' | 'today' | 'tomorrow' | 'upcoming' | 'no-date'

export type EmptyStateType = 'celebration' | 'simple' | 'planning' | 'none'

export interface SectionVisibility {
  /** Whether the section should be rendered at all */
  shouldShow: boolean
  /** Whether to show an empty state (only relevant when taskCount === 0) */
  showEmptyState: boolean
  /** The type of empty state to display */
  emptyStateType: EmptyStateType
}

export interface SectionVisibilityContext {
  /** Whether there are any tasks scheduled in the coming week */
  hasTasksThisWeek: boolean
  /** Whether the overdue section was previously shown (for celebration tracking) */
  wasOverduePreviouslyShown?: boolean
}

// ============================================================================
// VISIBILITY LOGIC
// ============================================================================

/**
 * Determines visibility and empty state behavior for a given section type.
 *
 * Section visibility rules:
 * - OVERDUE: Hide when empty (no need to show - absence of overdue is good!)
 * - TODAY: Always show (primary planning area, celebrate when empty)
 * - TOMORROW: Show if any tasks exist in the week (planning context)
 * - UPCOMING: Always show (main planning area)
 * - NO DUE DATE: Hide when empty (only show if tasks exist)
 */
export const getSectionVisibility = (
  sectionType: SectionType,
  taskCount: number,
  context: SectionVisibilityContext = { hasTasksThisWeek: false }
): SectionVisibility => {
  switch (sectionType) {
    case 'overdue':
      // Hide completely when empty - absence of overdue is good!
      // The celebration banner handles the transition moment
      return {
        shouldShow: taskCount > 0,
        showEmptyState: false,
        emptyStateType: 'none'
      }

    case 'today':
      // Always show TODAY section - it's the primary focus area
      // When empty, show a celebration/encouragement state
      return {
        shouldShow: true,
        showEmptyState: taskCount === 0,
        emptyStateType: 'celebration'
      }

    case 'tomorrow':
      // Show if there are tasks for tomorrow OR if there are tasks this week
      // This provides planning context without cluttering empty views
      return {
        shouldShow: taskCount > 0 || context.hasTasksThisWeek,
        showEmptyState: taskCount === 0,
        emptyStateType: 'simple'
      }

    case 'upcoming':
      // Always show UPCOMING section - main planning area
      // When empty, show a planning-oriented prompt
      return {
        shouldShow: true,
        showEmptyState: taskCount === 0,
        emptyStateType: 'planning'
      }

    case 'no-date':
      // Only show if there are actually undated tasks
      return {
        shouldShow: taskCount > 0,
        showEmptyState: false,
        emptyStateType: 'none'
      }

    default:
      // Default: hide when empty
      return {
        shouldShow: taskCount > 0,
        showEmptyState: false,
        emptyStateType: 'none'
      }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if we should show the "overdue cleared" celebration.
 * This is triggered when the overdue count goes from >0 to 0.
 */
export const shouldShowOverdueCelebration = (
  previousCount: number,
  currentCount: number
): boolean => {
  return previousCount > 0 && currentCount === 0
}

/**
 * Get the appropriate empty state message for a section type.
 */
export const getEmptyStateMessage = (
  sectionType: SectionType
): { title: string; description: string } => {
  switch (sectionType) {
    case 'today':
      return {
        title: 'All clear for today!',
        description: 'Enjoy your free time or plan ahead.'
      }
    case 'tomorrow':
      return {
        title: 'No tasks scheduled',
        description: 'Plan ahead by adding tasks for tomorrow.'
      }
    case 'upcoming':
      return {
        title: 'Nothing scheduled',
        description: 'Add tasks with due dates to plan your week.'
      }
    default:
      return {
        title: 'No tasks',
        description: 'Add a task to get started.'
      }
  }
}
