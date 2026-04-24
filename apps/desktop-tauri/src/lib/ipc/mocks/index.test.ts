import { describe, it, expect, vi } from 'vitest'

import { mockRouter } from './index'
import { mockId, mockTimestamp } from './types'

describe('mockRouter', () => {
  it('throws descriptive error for unknown commands', async () => {
    await expect(mockRouter('does_not_exist')).rejects.toThrow(
      /Mock IPC: command "does_not_exist" not implemented/
    )
  })

  it('logs a warning when an unknown command is requested', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(mockRouter('still_missing', { x: 1 })).rejects.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      '[mock-ipc] unimplemented command: still_missing',
      { x: 1 }
    )
    warnSpy.mockRestore()
  })
})

describe('mockId', () => {
  it('returns zero-padded sequential ids with the given prefix', () => {
    const a = mockId('note')
    const b = mockId('note')
    expect(a).toMatch(/^note-\d{6}$/)
    expect(b).toMatch(/^note-\d{6}$/)
    expect(a).not.toBe(b)
  })

  it('shares one global counter across prefixes', () => {
    const a = mockId('task')
    const b = mockId('note')
    const aNum = Number(a.split('-')[1])
    const bNum = Number(b.split('-')[1])
    expect(bNum).toBe(aNum + 1)
  })
})

describe('mockTimestamp', () => {
  it('returns current time when daysAgo omitted', () => {
    const now = Date.now()
    const ts = mockTimestamp()
    expect(Math.abs(ts - now)).toBeLessThan(1000)
  })

  it('returns a past timestamp for positive daysAgo', () => {
    const ts = mockTimestamp(3)
    expect(ts).toBeLessThan(Date.now())
    const expectedDiff = 3 * 86_400_000
    expect(Math.abs(Date.now() - ts - expectedDiff)).toBeLessThan(1000)
  })

  it('returns a future timestamp for negative daysAgo', () => {
    const ts = mockTimestamp(-2)
    expect(ts).toBeGreaterThan(Date.now())
  })
})
