import { describe, expect, it } from 'vitest'

import { AgentMcpDesktopReadOperations, AgentMcpDesktopWriteOperations } from './agent-mcp-channels'

// Google Workspace Limited Use compliance: data obtained through the Google
// Calendar integration must never be readable by AI backends, so no
// Google-integration operation may appear in the agent allowlists.
//
// The provider-neutral twins (#1392) are listed alongside the Google-named
// originals: they reach the same connected accounts, so allowlisting one would
// re-open exactly the hole the Google-named exclusion closes.
const googleIntegrationOperations = [
  'calendar.listSources',
  'calendar.getProviderStatus',
  'calendar.listProviders',
  'calendar.listProviderCalendars',
  'calendar.listGoogleCalendars',
  'calendar.promoteExternalEvent',
  'calendar.updateSourceSelection',
  'calendar.setDefaultProviderCalendar',
  'calendar.setDefaultGoogleCalendar',
  'calendar.retryCalendarSourceSync',
  'settings.getCalendarProviderSettings',
  'settings.setCalendarProviderSettings',
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

  it('exposes tag category reads', () => {
    expect(AgentMcpDesktopReadOperations).toContain('tags.listCategories')
  })

  it('keeps tag category writes in the write allowlist only', () => {
    const writes = [
      'tags.createCategory',
      'tags.renameCategory',
      'tags.deleteCategory',
      'tags.reorder'
    ]
    const readOperations = new Set<string>(AgentMcpDesktopReadOperations)

    for (const operation of writes) {
      expect(AgentMcpDesktopWriteOperations).toContain(operation)
      expect(readOperations.has(operation)).toBe(false)
    }
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
