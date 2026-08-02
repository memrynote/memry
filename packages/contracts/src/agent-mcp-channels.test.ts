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

// The Projects hub added a project↔item link layer. Agents get the same reads
// and writes the hub itself uses, so "what is linked to project X" and "what
// projects is note Y in" are answerable without a desktop-only detour.
const projectHubReadOperations = [
  'tasks.listProjectLinks',
  'tasks.listProjectContents',
  'tasks.listForItem'
] as const

const projectHubWriteOperations = [
  'tasks.linkProjectItem',
  'tasks.unlinkProjectItem',
  'tasks.setProjectLinkPinned',
  'tasks.setProjectHomeNote',
  'tasks.captureUrlToProject',
  'tasks.importFilesToProject'
] as const

// Deliberately excluded from both allowlists: reporting pipelines the agent has
// no business driving, and shell/UI operations whose effect happens outside the
// vault where the agent cannot observe or undo it. Reaching the network or the
// filesystem is not itself the line — `inbox.captureLink`,
// `notes.importFiles`, and `tasks.captureUrlToProject` are all allowlisted.
const deliberatelyExcludedOperations = [
  'telemetry.track',
  'telemetry.flush',
  'telemetry.getSettings',
  'telemetry.setEnabled',
  'feedback.submit',
  'diagnostics.previewReport',
  'diagnostics.sendReport',
  'notes.openExternal',
  'notes.revealInFinder',
  'notes.showImportDialog',
  'settings.openOsMicrophoneSettings'
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

  it('covers every branch of the inbox conversion engine', () => {
    expect(AgentMcpDesktopWriteOperations).toContain('inbox.convertToNote')
    expect(AgentMcpDesktopWriteOperations).toContain('inbox.convertToTask')
    expect(AgentMcpDesktopWriteOperations).toContain('inbox.convertToEvent')
    expect(AgentMcpDesktopWriteOperations).toContain('inbox.convertToReminder')
  })

  it('lets an agent apply a template it can already read', () => {
    expect(AgentMcpDesktopReadOperations).toContain('templates.get')
    expect(AgentMcpDesktopWriteOperations).toContain('notes.applyTemplate')
  })

  it('exposes features settings so an agent can tell which surfaces are enabled', () => {
    expect(AgentMcpDesktopReadOperations).toContain('settings.getFeaturesSettings')
    expect(AgentMcpDesktopWriteOperations).toContain('settings.setFeaturesSettings')
  })

  it('gives inbox settings the same get/set pair as every other settings group', () => {
    expect(AgentMcpDesktopReadOperations).toContain('settings.getInboxSettings')
    expect(AgentMcpDesktopWriteOperations).toContain('settings.setInboxSettings')
  })

  it('exposes the project hub link layer as reads', () => {
    for (const operation of projectHubReadOperations) {
      expect(AgentMcpDesktopReadOperations).toContain(operation)
      expect(AgentMcpDesktopWriteOperations).not.toContain(operation)
    }
  })

  it('exposes the project hub mutations as writes', () => {
    for (const operation of projectHubWriteOperations) {
      expect(AgentMcpDesktopWriteOperations).toContain(operation)
      expect(AgentMcpDesktopReadOperations).not.toContain(operation)
    }
  })

  it('excludes telemetry, feedback, diagnostics, and shell operations', () => {
    const allOperations = new Set<string>([
      ...AgentMcpDesktopReadOperations,
      ...AgentMcpDesktopWriteOperations
    ])

    for (const operation of deliberatelyExcludedOperations) {
      expect(allOperations.has(operation)).toBe(false)
    }
  })
})
