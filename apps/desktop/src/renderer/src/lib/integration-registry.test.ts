import { describe, it, expect } from 'vitest'
import { getAvailableIntegrations, getIntegration } from './integration-registry'

describe('integration registry', () => {
  it('returns known integrations by id', () => {
    expect(getIntegration('todoist')?.name).toBe('Todoist')
    expect(getAvailableIntegrations().map((integration) => integration.id)).toContain('todoist')
  })

  it('lists no calendar provider — main reports those (#1395)', () => {
    // A duplicate entry here would render a second, capability-blind row next
    // to the live one from `calendar:list-providers`.
    expect(getAvailableIntegrations().map((integration) => integration.id)).not.toContain(
      'google-calendar'
    )
  })
})
