import { describe, expect, it } from 'vitest'
import { highlight } from './fixtures.ts'
import { newestCreatedAt } from './highlights.ts'

const at = (created_at: string, id = 1) => highlight(id, { created_at })

describe('newestCreatedAt', () => {
  it('sits one millisecond past the newest highlight handled', () => {
    expect(newestCreatedAt([at('2026-10-12T00:00:00Z')], [], '')).toBe('2026-10-12T00:00:00.001Z')
  })

  it('never moves back below the floor', () => {
    expect(newestCreatedAt([at('2026-10-01T00:00:00Z')], [], '2026-10-05T00:00:00.000Z')).toBe(
      '2026-10-05T00:00:00.000Z'
    )
  })

  it('stays before the oldest missing image, and at it when a handled highlight shares its time', () => {
    const missing = [at('2026-10-10T00:00:00Z', 9)]
    expect(newestCreatedAt([at('2026-10-09T00:00:00Z')], missing, '')).toBe(
      '2026-10-09T00:00:00.001Z'
    )
    expect(newestCreatedAt([at('2026-10-10T00:00:00Z')], missing, '')).toBe(
      '2026-10-10T00:00:00.000Z'
    )
    expect(newestCreatedAt([at('2026-10-11T00:00:00Z')], missing, '')).toBe(
      '1970-01-01T00:00:00.000Z'
    )
  })
})
