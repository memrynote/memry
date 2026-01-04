/**
 * usePropertyDefinitions Hook Tests (T677)
 * Tests for vault-wide property definition management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { createMockApi } from '@tests/setup-dom'
import {
  usePropertyDefinitions,
  parsePropertyOptions,
  parsePropertyDefaultValue
} from './use-property-definitions'

// ============================================================================
// Test Data
// ============================================================================

const mockDefinitions = [
  {
    name: 'status',
    type: 'select',
    options: '["draft","review","published"]',
    defaultValue: '"draft"',
    color: '#3B82F6'
  },
  {
    name: 'priority',
    type: 'number',
    options: null,
    defaultValue: '1',
    color: '#EF4444'
  },
  {
    name: 'tags',
    type: 'multiselect',
    options: '["work","personal","urgent"]',
    defaultValue: '[]',
    color: '#10B981'
  }
]

// ============================================================================
// Tests
// ============================================================================

describe('usePropertyDefinitions', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    api.notes.getPropertyDefinitions = vi.fn().mockResolvedValue(mockDefinitions)
    api.notes.createPropertyDefinition = vi.fn().mockResolvedValue({
      success: true,
      definition: { name: 'newProp', type: 'text', options: null, defaultValue: null, color: null }
    })
    api.notes.updatePropertyDefinition = vi.fn().mockResolvedValue({
      success: true,
      definition: { ...mockDefinitions[0], color: '#FF0000' }
    })
    ;(window as Window & { api: unknown }).api = api
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ==========================================================================
  // Initial Loading Tests
  // ==========================================================================

  describe('initial loading', () => {
    it('should fetch definitions on mount', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(api.notes.getPropertyDefinitions).toHaveBeenCalled()
      expect(result.current.definitions).toEqual(mockDefinitions)
    })

    it('should start with loading state', () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      // Initially should be loading
      expect(result.current.isLoading).toBe(true)
      expect(result.current.definitions).toEqual([])
    })

    it('should handle fetch errors', async () => {
      api.notes.getPropertyDefinitions = vi.fn().mockRejectedValue(new Error('Fetch failed'))

      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBe('Fetch failed')
      expect(result.current.definitions).toEqual([])
    })
  })

  // ==========================================================================
  // getDefinition Tests
  // ==========================================================================

  describe('getDefinition', () => {
    it('should return definition by name', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const statusDef = result.current.getDefinition('status')
      expect(statusDef).toEqual(mockDefinitions[0])
    })

    it('should return undefined for non-existent definition', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const nonExistent = result.current.getDefinition('nonexistent')
      expect(nonExistent).toBeUndefined()
    })
  })

  // ==========================================================================
  // createDefinition Tests
  // ==========================================================================

  describe('createDefinition', () => {
    it('should create a new definition', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let createdDef
      await act(async () => {
        createdDef = await result.current.createDefinition({
          name: 'newProp',
          type: 'text'
        })
      })

      expect(api.notes.createPropertyDefinition).toHaveBeenCalledWith({
        name: 'newProp',
        type: 'text'
      })
      expect(createdDef).toEqual({
        name: 'newProp',
        type: 'text',
        options: null,
        defaultValue: null,
        color: null
      })
    })

    it('should add new definition to local state', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const initialCount = result.current.definitions.length

      await act(async () => {
        await result.current.createDefinition({
          name: 'newProp',
          type: 'text'
        })
      })

      expect(result.current.definitions.length).toBe(initialCount + 1)
    })

    it('should throw on creation failure', async () => {
      api.notes.createPropertyDefinition = vi.fn().mockResolvedValue({
        success: false,
        error: 'Creation failed'
      })

      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await expect(
        act(async () => {
          await result.current.createDefinition({
            name: 'failProp',
            type: 'text'
          })
        })
      ).rejects.toThrow('Creation failed')
    })
  })

  // ==========================================================================
  // updateDefinition Tests
  // ==========================================================================

  describe('updateDefinition', () => {
    it('should update an existing definition', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let updatedDef
      await act(async () => {
        updatedDef = await result.current.updateDefinition('status', { color: '#FF0000' })
      })

      expect(api.notes.updatePropertyDefinition).toHaveBeenCalledWith({
        name: 'status',
        color: '#FF0000'
      })
      expect(updatedDef?.color).toBe('#FF0000')
    })

    it('should update definition in local state', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.updateDefinition('status', { color: '#FF0000' })
      })

      const statusDef = result.current.getDefinition('status')
      expect(statusDef?.color).toBe('#FF0000')
    })

    it('should throw on update failure', async () => {
      api.notes.updatePropertyDefinition = vi.fn().mockResolvedValue({
        success: false,
        error: 'Update failed'
      })

      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await expect(
        act(async () => {
          await result.current.updateDefinition('status', { color: '#FF0000' })
        })
      ).rejects.toThrow('Update failed')
    })
  })

  // ==========================================================================
  // refresh Tests
  // ==========================================================================

  describe('refresh', () => {
    it('should refetch definitions', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(api.notes.getPropertyDefinitions).toHaveBeenCalledTimes(1)

      await act(async () => {
        await result.current.refresh()
      })

      expect(api.notes.getPropertyDefinitions).toHaveBeenCalledTimes(2)
    })
  })

  // ==========================================================================
  // Return Value Tests
  // ==========================================================================

  describe('return value', () => {
    it('should expose all expected properties and methods', async () => {
      const { result } = renderHook(() => usePropertyDefinitions())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current).toHaveProperty('definitions')
      expect(result.current).toHaveProperty('isLoading')
      expect(result.current).toHaveProperty('error')
      expect(result.current).toHaveProperty('createDefinition')
      expect(result.current).toHaveProperty('updateDefinition')
      expect(result.current).toHaveProperty('refresh')
      expect(result.current).toHaveProperty('getDefinition')
    })
  })
})

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('parsePropertyOptions', () => {
  it('should parse valid JSON options', () => {
    const definition = {
      name: 'status',
      type: 'select',
      options: '["draft","review","published"]'
    }

    const result = parsePropertyOptions(definition as any)
    expect(result).toEqual(['draft', 'review', 'published'])
  })

  it('should return empty array for null options', () => {
    const definition = {
      name: 'priority',
      type: 'number',
      options: null
    }

    const result = parsePropertyOptions(definition as any)
    expect(result).toEqual([])
  })

  it('should return empty array for invalid JSON', () => {
    const definition = {
      name: 'broken',
      type: 'select',
      options: 'not valid json'
    }

    const result = parsePropertyOptions(definition as any)
    expect(result).toEqual([])
  })
})

describe('parsePropertyDefaultValue', () => {
  it('should parse valid JSON default value', () => {
    const definition = {
      name: 'status',
      type: 'select',
      defaultValue: '"draft"'
    }

    const result = parsePropertyDefaultValue(definition as any)
    expect(result).toBe('draft')
  })

  it('should parse array default value', () => {
    const definition = {
      name: 'tags',
      type: 'multiselect',
      defaultValue: '["work","personal"]'
    }

    const result = parsePropertyDefaultValue(definition as any)
    expect(result).toEqual(['work', 'personal'])
  })

  it('should parse number default value', () => {
    const definition = {
      name: 'priority',
      type: 'number',
      defaultValue: '5'
    }

    const result = parsePropertyDefaultValue(definition as any)
    expect(result).toBe(5)
  })

  it('should return null for null default value', () => {
    const definition = {
      name: 'text',
      type: 'text',
      defaultValue: null
    }

    const result = parsePropertyDefaultValue(definition as any)
    expect(result).toBeNull()
  })

  it('should return raw value for invalid JSON', () => {
    const definition = {
      name: 'broken',
      type: 'text',
      defaultValue: 'plain text'
    }

    const result = parsePropertyDefaultValue(definition as any)
    expect(result).toBe('plain text')
  })
})
