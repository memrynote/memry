import { useState, useCallback, useEffect } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:TaskSettings')

// ============================================================================
// TYPES
// ============================================================================

export interface SubtaskSettings {
  /** Automatically complete parent task when all subtasks are done */
  autoCompleteParent: boolean
  /** New subtasks inherit due date from parent */
  inheritDueDate: boolean
  /** New subtasks inherit priority from parent */
  inheritPriority: boolean
  /** Show progress bar on parent tasks */
  showProgressBar: boolean
  /** Auto-expand subtasks in list view */
  autoExpandInList: boolean
}

export interface TaskSettings {
  subtasks: SubtaskSettings
}

// ============================================================================
// DEFAULTS
// ============================================================================

const defaultSubtaskSettings: SubtaskSettings = {
  autoCompleteParent: true,
  inheritDueDate: false,
  inheritPriority: false,
  showProgressBar: true,
  autoExpandInList: false
}

const defaultTaskSettings: TaskSettings = {
  subtasks: defaultSubtaskSettings
}

const STORAGE_KEY = 'memry-task-settings'

// ============================================================================
// HOOK
// ============================================================================

interface UseTaskSettingsReturn {
  settings: TaskSettings
  subtaskSettings: SubtaskSettings
  updateSubtaskSettings: (updates: Partial<SubtaskSettings>) => void
  resetToDefaults: () => void
}

export const useTaskSettings = (): UseTaskSettingsReturn => {
  const [settings, setSettings] = useState<TaskSettings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        // Merge with defaults to handle new settings added over time
        return {
          subtasks: {
            ...defaultSubtaskSettings,
            ...parsed.subtasks
          }
        }
      }
    } catch (error) {
      log.error('Failed to load task settings:', error)
    }
    return defaultTaskSettings
  })

  // Persist settings to localStorage when they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch (error) {
      log.error('Failed to save task settings:', error)
    }
  }, [settings])

  const updateSubtaskSettings = useCallback((updates: Partial<SubtaskSettings>): void => {
    setSettings((prev) => ({
      ...prev,
      subtasks: {
        ...prev.subtasks,
        ...updates
      }
    }))
  }, [])

  const resetToDefaults = useCallback((): void => {
    setSettings(defaultTaskSettings)
  }, [])

  return {
    settings,
    subtaskSettings: settings.subtasks,
    updateSubtaskSettings,
    resetToDefaults
  }
}

export default useTaskSettings
