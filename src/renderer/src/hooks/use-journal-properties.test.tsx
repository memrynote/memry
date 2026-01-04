/**
 * useJournalProperties Hook Tests (T665)
 * Tests for journal property CRUD with optimistic updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useJournalProperties } from './use-journal-properties'

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/services/journal-service', () => ({
  journalService: {
    getEntry: vi.fn(),
    updateEntry: vi.fn()
  }
}))

import { journalService } from '@/services/journal-service'

// ============================================================================
// Test Data
// ============================================================================

const mockProperties = {
  mood: 'happy',
  energy: 8,
  exercise: true,
  date: '2024-12-25',
  tags: ['productive', 'focused'],
  link: 'https://example.com'
}

const mockEntry = {
  date: '2024-12-25',
  content: 'Test journal entry',
  properties: mockProperties
}

// ============================================================================
// Tests
// ============================================================================

describe('useJournalProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(journalService.getEntry).mockResolvedValue(mockEntry)
    vi.mocked(journalService.updateEntry).mockResolvedValue(mockEntry)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ==========================================================================
  // Initial State Tests
  // ==========================================================================

  describe('initial state', () => {
    it('should start with empty properties when no initialProperties provided', () => {
      const { result } = renderHook(() => useJournalProperties('2024-12-25'))

      expect(result.current.properties).toEqual([])
      expect(result.current.propertiesRecord).toEqual({})
      expect(result.current.isLoading).toBe(false)
    })

    it('should use initialProperties when provided', () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      expect(result.current.properties).toHaveLength(6)
      expect(result.current.propertiesRecord).toEqual(mockProperties)
    })

    it('should infer types correctly from initial properties', () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      const propsByName = Object.fromEntries(
        result.current.properties.map((p) => [p.name, p.type])
      )

      expect(propsByName.mood).toBe('text')
      expect(propsByName.energy).toBe('number')
      expect(propsByName.exercise).toBe('checkbox')
      expect(propsByName.date).toBe('date')
      expect(propsByName.tags).toBe('multiselect')
      expect(propsByName.link).toBe('url')
    })

    it('should handle null date', () => {
      const { result } = renderHook(() => useJournalProperties(null))

      expect(result.current.properties).toEqual([])
    })
  })

  // ==========================================================================
  // propertiesRecord Tests
  // ==========================================================================

  describe('propertiesRecord', () => {
    it('should convert properties array to Record', () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      expect(result.current.propertiesRecord).toEqual(mockProperties)
    })
  })

  // ==========================================================================
  // updateProperty Tests
  // ==========================================================================

  describe('updateProperty', () => {
    it('should optimistically update property', async () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      await act(async () => {
        await result.current.updateProperty('mood', 'excited')
      })

      const moodProp = result.current.properties.find((p) => p.name === 'mood')
      expect(moodProp?.value).toBe('excited')
    })

    it('should call updateEntry with updated properties', async () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      await act(async () => {
        await result.current.updateProperty('energy', 10)
      })

      expect(journalService.updateEntry).toHaveBeenCalledWith({
        date: '2024-12-25',
        properties: expect.objectContaining({
          energy: 10
        })
      })
    })

    it('should do nothing with null date', async () => {
      const { result } = renderHook(() => useJournalProperties(null))

      await act(async () => {
        await result.current.updateProperty('mood', 'value')
      })

      expect(journalService.updateEntry).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // addProperty Tests
  // ==========================================================================

  describe('addProperty', () => {
    it('should optimistically add property', async () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      const initialCount = result.current.properties.length

      await act(async () => {
        await result.current.addProperty('newProp', 'newValue')
      })

      expect(result.current.properties.length).toBe(initialCount + 1)
    })

    it('should call updateEntry with new property', async () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      await act(async () => {
        await result.current.addProperty('score', 95)
      })

      expect(journalService.updateEntry).toHaveBeenCalledWith({
        date: '2024-12-25',
        properties: expect.objectContaining({
          score: 95
        })
      })
    })

    it('should do nothing with null date', async () => {
      const { result } = renderHook(() => useJournalProperties(null))

      await act(async () => {
        await result.current.addProperty('prop', 'value')
      })

      expect(journalService.updateEntry).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // removeProperty Tests
  // ==========================================================================

  describe('removeProperty', () => {
    it('should optimistically remove property', async () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      const hadMood = result.current.properties.some((p) => p.name === 'mood')
      expect(hadMood).toBe(true)

      await act(async () => {
        await result.current.removeProperty('mood')
      })

      const hasMood = result.current.properties.some((p) => p.name === 'mood')
      expect(hasMood).toBe(false)
    })

    it('should do nothing with null date', async () => {
      const { result } = renderHook(() => useJournalProperties(null))

      await act(async () => {
        await result.current.removeProperty('mood')
      })

      expect(journalService.updateEntry).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // setAllProperties Tests
  // ==========================================================================

  describe('setAllProperties', () => {
    it('should replace all properties', async () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', mockProperties)
      )

      const newProps = {
        newProp1: 'value1',
        newProp2: 42
      }

      await act(async () => {
        await result.current.setAllProperties(newProps)
      })

      expect(result.current.propertiesRecord).toEqual(newProps)
      expect(result.current.properties).toHaveLength(2)
    })

    it('should do nothing with null date', async () => {
      const { result } = renderHook(() => useJournalProperties(null))

      await act(async () => {
        await result.current.setAllProperties({ prop: 'value' })
      })

      expect(journalService.updateEntry).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // refresh Tests
  // ==========================================================================

  describe('refresh', () => {
    it('should fetch properties from entry', async () => {
      const { result } = renderHook(() =>
        useJournalProperties('2024-12-25', {})
      )

      await act(async () => {
        await result.current.refresh()
      })

      expect(journalService.getEntry).toHaveBeenCalledWith('2024-12-25')
    })

    it('should do nothing with null date', async () => {
      const { result } = renderHook(() => useJournalProperties(null))

      await act(async () => {
        await result.current.refresh()
      })

      expect(journalService.getEntry).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Effect Tests
  // ==========================================================================

  describe('effect on initialProperties change', () => {
    it('should update properties when initialProperties changes', () => {
      const { result, rerender } = renderHook(
        ({ props }) => useJournalProperties('2024-12-25', props),
        { initialProps: { props: mockProperties } }
      )

      expect(result.current.propertiesRecord.mood).toBe('happy')

      rerender({ props: { mood: 'sad', energy: 3 } })

      expect(result.current.propertiesRecord.mood).toBe('sad')
    })
  })
})
