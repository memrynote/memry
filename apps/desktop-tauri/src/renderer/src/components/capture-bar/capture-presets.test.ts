import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PRESETS,
  hasNonDefaultPresets,
  isPresetDefault,
  mergePresets,
  resolvePresetDueDate,
  stripTokens,
  type TaskPresets
} from './capture-presets'
import type { RepeatConfig } from '@/data/task-model'

const NOW = new Date(2026, 8, 26, 14, 30)
const TODAY = new Date(2026, 8, 26)

const emptyParse = {
  dueDate: null,
  dueTime: null,
  priority: 'none' as const,
  projectId: null,
  repeat: null,
  tags: [] as string[]
}

const presets = (overrides: Partial<TaskPresets> = {}): TaskPresets => ({
  ...DEFAULT_PRESETS,
  ...overrides
})

describe('mergePresets', () => {
  it('defaults the due date to today', () => {
    expect(mergePresets(emptyParse, presets(), NOW).dueDate).toEqual(TODAY)
  })

  it('keeps an explicit "no date"', () => {
    expect(mergePresets(emptyParse, presets({ dueDate: null }), NOW).dueDate).toBeNull()
  })

  it('lets a typed date override the preset date and its time', () => {
    const friday = new Date(2026, 9, 2)
    const merged = mergePresets(
      { ...emptyParse, dueDate: friday, dueTime: null },
      presets({ dueDate: TODAY, dueTime: '09:00' }),
      NOW
    )
    expect(merged.dueDate).toEqual(friday)
    expect(merged.dueTime).toBeNull()
  })

  it('lets typed priority, project and repeat win over presets', () => {
    const repeat: RepeatConfig = {
      frequency: 'daily',
      interval: 1,
      endType: 'never',
      completedCount: 0,
      createdAt: NOW
    }
    const merged = mergePresets(
      { ...emptyParse, priority: 'low', projectId: 'work', repeat },
      presets({ priority: 'high', projectId: 'home', repeat: null }),
      NOW
    )
    expect(merged.priority).toBe('low')
    expect(merged.projectId).toBe('work')
    expect(merged.repeat).toBe(repeat)
  })

  it('falls back to presets when nothing is typed', () => {
    const merged = mergePresets(
      emptyParse,
      presets({ priority: 'high', projectId: 'home', statusId: 's1' }),
      NOW
    )
    expect(merged.priority).toBe('high')
    expect(merged.projectId).toBe('home')
    expect(merged.statusId).toBe('s1')
  })

  it('drops the preset status when a token moves the task to another project', () => {
    const merged = mergePresets(
      { ...emptyParse, projectId: 'work' },
      presets({ projectId: 'home', statusId: 's1' }),
      NOW
    )
    expect(merged.statusId).toBeNull()
  })

  it('unions tags case-insensitively', () => {
    const merged = mergePresets(
      { ...emptyParse, tags: ['launch', 'Design'] },
      presets({ tags: ['design', 'q3'] }),
      NOW
    )
    expect(merged.tags).toEqual(['launch', 'Design', 'q3'])
  })
})

describe('stripTokens', () => {
  it('removes the conflicting token and tidies the spaces', () => {
    expect(stripTokens('Ship it !low now', ['priority'], NOW)).toBe('Ship it now')
  })

  it('leaves other kinds alone', () => {
    expect(stripTokens('Ship it !low #launch', ['project'], NOW)).toBe('Ship it !low #launch')
  })

  it('removes a date phrase', () => {
    expect(stripTokens('Call mom @friday', ['datePhrase'], NOW)).toBe('Call mom')
  })
})

describe('preset defaults', () => {
  it('reports defaults', () => {
    expect(hasNonDefaultPresets(presets())).toBe(false)
    expect(isPresetDefault(presets({ tags: ['x'] }), 'tags')).toBe(false)
    expect(hasNonDefaultPresets(presets({ dueDate: null }))).toBe(true)
  })

  it('resolves the default due date at read time', () => {
    expect(resolvePresetDueDate(presets(), NOW)).toEqual(TODAY)
  })
})
