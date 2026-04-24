import { describe, it, expect } from 'vitest'

import { journalRoutes } from './journal'

describe('journalRoutes', () => {
  it('journal_list returns at least 7 entries spanning a week', async () => {
    const list = (await journalRoutes.journal_list!(undefined)) as Array<{ date: string }>
    expect(list.length).toBeGreaterThanOrEqual(7)
  })

  it('journal_get_by_date returns the entry for the given date', async () => {
    const list = (await journalRoutes.journal_list!(undefined)) as Array<{ date: string }>
    const date = list[0]!.date
    const entry = (await journalRoutes.journal_get_by_date!({ date })) as { date: string }
    expect(entry.date).toBe(date)
  })

  it('journal_get_by_date rejects for unknown date', async () => {
    await expect(
      journalRoutes.journal_get_by_date!({ date: '1970-01-01' })
    ).rejects.toThrow(/not found/i)
  })

  it('journal_upsert creates a new entry for a new date', async () => {
    const entry = (await journalRoutes.journal_upsert!({
      date: '2099-12-31',
      body: 'Future journal entry'
    })) as { id: string; date: string; body: string }
    expect(entry.id).toMatch(/^journal-/)
    expect(entry.date).toBe('2099-12-31')
    expect(entry.body).toBe('Future journal entry')
  })

  it('journal_upsert updates an existing entry for the same date', async () => {
    const list = (await journalRoutes.journal_list!(undefined)) as Array<{ date: string }>
    const existingDate = list[0]!.date
    const updated = (await journalRoutes.journal_upsert!({
      date: existingDate,
      body: 'Changed body'
    })) as { body: string; updatedAt: number }
    expect(updated.body).toBe('Changed body')
    expect(updated.updatedAt).toBeGreaterThan(0)
  })

  it('includes an entry with Turkish characters', async () => {
    const list = (await journalRoutes.journal_list!(undefined)) as Array<{ body: string }>
    expect(list.some((e) => /[ğüşıöçĞÜŞİÖÇ]/.test(e.body))).toBe(true)
  })
})
