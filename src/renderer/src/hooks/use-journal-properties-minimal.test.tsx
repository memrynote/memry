import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useJournalProperties } from './use-journal-properties'

vi.mock('@/services/journal-service', () => ({
  journalService: {
    getEntry: vi.fn(),
    updateEntry: vi.fn()
  }
}))

import { journalService } from '@/services/journal-service'

const mockProps = { mood: 'happy', energy: 8 }
const mockEntry = { date: '2024-12-25', properties: mockProps }

describe('useJournalProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(journalService.getEntry).mockResolvedValue(mockEntry)
    vi.mocked(journalService.updateEntry).mockResolvedValue(mockEntry)
  })

  it('should refresh properties', async () => {
    const { result } = renderHook(() => useJournalProperties('2024-12-25', {}))
    await act(async () => {
      await result.current.refresh()
    })
    expect(journalService.getEntry).toHaveBeenCalledWith('2024-12-25')
  })
})
