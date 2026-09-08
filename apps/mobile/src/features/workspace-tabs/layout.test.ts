import { describe, expect, it } from 'vitest'

import { workspaceTabCardWidth } from './layout'

describe('workspace tab grid geometry', () => {
  it('keeps every card at half-row width even when the final row has one tab', () => {
    expect(workspaceTabCardWidth(402)).toBe(185)
    expect(workspaceTabCardWidth(390)).toBe(179)
  })
})
