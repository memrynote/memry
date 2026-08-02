import { describe, expect, it } from 'vitest'

import { AgentMcpDesktopReadOperations, AgentMcpDesktopWriteOperations } from './agent-mcp-channels'

// Google Workspace Limited Use compliance: data obtained through the Google
// Calendar integration must never be readable by AI backends, so no
// Google-integration operation may appear in the agent allowlists.
const googleIntegrationOperations = [
  'calendar.listSources',
  'calendar.getProviderStatus',
  'calendar.listGoogleCalendars',
  'calendar.promoteExternalEvent',
  'calendar.updateSourceSelection',
  'calendar.setDefaultGoogleCalendar',
  'settings.getCalendarGoogleSettings',
  'settings.setCalendarGoogleSettings'
] as const

describe('agent MCP desktop operation allowlists', () => {
  it('excludes Google Calendar integration operations', () => {
    const allOperations = new Set<string>([
      ...AgentMcpDesktopReadOperations,
      ...AgentMcpDesktopWriteOperations
    ])

    for (const operation of googleIntegrationOperations) {
      expect(allOperations.has(operation)).toBe(false)
    }
  })

  it('keeps native calendar operations available', () => {
    expect(AgentMcpDesktopReadOperations).toContain('calendar.getEvent')
    expect(AgentMcpDesktopReadOperations).toContain('calendar.listEvents')
    expect(AgentMcpDesktopReadOperations).toContain('calendar.getRange')
    expect(AgentMcpDesktopWriteOperations).toContain('calendar.createEvent')
  })
})

// Canvas coverage (#916). The excluded operations are excluded on purpose —
// see docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §3.2.
describe('canvas operations', () => {
  it('allowlists the safe canvas reads', () => {
    for (const operation of [
      'canvas.list',
      'canvas.getAsset',
      'canvas.listAssets',
      'canvas.libraryList'
    ]) {
      expect(AgentMcpDesktopReadOperations).toContain(operation)
    }
  })

  it('allowlists whole-canvas create and delete', () => {
    expect(AgentMcpDesktopWriteOperations).toContain('canvas.create')
    expect(AgentMcpDesktopWriteOperations).toContain('canvas.delete')
  })

  it('never exposes canvas.get — it dumps raw scene geometry; use vault_read_canvas', () => {
    expect(AgentMcpDesktopReadOperations).not.toContain('canvas.get')
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.get')
  })

  it('never exposes canvas.update — blind whole-scene replacement clobbers an open editor', () => {
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.update')
  })

  it('never exposes canvas.librarySave — a partial list deletes the shape library', () => {
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.librarySave')
  })

  it('never exposes canvas.uploadAsset — binary payload, no agent path in v1', () => {
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.uploadAsset')
  })
})
