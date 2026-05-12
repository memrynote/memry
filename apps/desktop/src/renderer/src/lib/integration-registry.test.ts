import { describe, it, expect } from 'vitest'
import { getAvailableIntegrations, getIntegration } from './integration-registry'

describe('integration registry', () => {
  it('returns known integrations by id', () => {
    expect(getIntegration('google-calendar')?.name).toBe('Google Calendar')
    expect(getAvailableIntegrations().map((integration) => integration.id)).toContain('todoist')
  })
})
