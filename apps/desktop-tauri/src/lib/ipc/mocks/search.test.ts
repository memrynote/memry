import { describe, it, expect } from 'vitest'

import { searchRoutes } from './search'

describe('searchRoutes', () => {
  it('search_query returns matches across note/task/journal kinds', async () => {
    const results = (await searchRoutes.search_query!({ q: 'mock' })) as Array<{
      kind: string
      id: string
      title: string
    }>
    expect(results.length).toBeGreaterThan(0)
    const kinds = new Set(results.map((r) => r.kind))
    expect(kinds.size).toBeGreaterThanOrEqual(2)
  })

  it('search_query returns an empty list for an impossible query', async () => {
    const results = (await searchRoutes.search_query!({ q: 'zzzzzzzzzzzzzzzzz-no-hits' })) as unknown[]
    expect(results).toEqual([])
  })

  it('search_recent returns the stored recent queries', async () => {
    await searchRoutes.search_query!({ q: 'alpha' })
    await searchRoutes.search_query!({ q: 'beta' })
    const recent = (await searchRoutes.search_recent!(undefined)) as string[]
    expect(recent).toContain('alpha')
    expect(recent).toContain('beta')
  })

  it('search_clear_recent empties the list', async () => {
    await searchRoutes.search_query!({ q: 'temp' })
    await searchRoutes.search_clear_recent!(undefined)
    const recent = (await searchRoutes.search_recent!(undefined)) as string[]
    expect(recent).toEqual([])
  })

  it('search_suggestions returns a list of strings', async () => {
    const suggestions = (await searchRoutes.search_suggestions!({ prefix: 'm' })) as string[]
    expect(Array.isArray(suggestions)).toBe(true)
    expect(suggestions.every((s) => typeof s === 'string')).toBe(true)
  })
})
