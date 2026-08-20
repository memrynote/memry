import { beforeEach, describe, expect, it, vi } from 'vitest'

// This suite mocks every handler module rather than the Electron runtime, but
// registerAllHandlers itself now touches ipcMain to label handlers with their
// channel.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const hoisted = vi.hoisted(() => ({
  registerVaultHandlers: vi.fn(),
  unregisterVaultHandlers: vi.fn(),
  registerNotesHandlers: vi.fn(),
  unregisterNotesHandlers: vi.fn(),
  registerTasksHandlers: vi.fn(),
  unregisterTasksHandlers: vi.fn(),
  registerSavedFiltersHandlers: vi.fn(),
  unregisterSavedFiltersHandlers: vi.fn(),
  registerTemplatesHandlers: vi.fn(),
  unregisterTemplatesHandlers: vi.fn(),
  registerJournalHandlers: vi.fn(),
  unregisterJournalHandlers: vi.fn(),
  registerSettingsHandlers: vi.fn(),
  unregisterSettingsHandlers: vi.fn(),
  registerBookmarksHandlers: vi.fn(),
  unregisterBookmarksHandlers: vi.fn(),
  registerTagsHandlers: vi.fn(),
  unregisterTagsHandlers: vi.fn(),
  registerInboxHandlers: vi.fn(),
  unregisterInboxHandlers: vi.fn(),
  registerReminderHandlers: vi.fn(),
  unregisterReminderHandlers: vi.fn(),
  registerCalendarHandlers: vi.fn(),
  unregisterCalendarHandlers: vi.fn(),
  registerCanvasHandlers: vi.fn(),
  unregisterCanvasHandlers: vi.fn(),
  registerCanvasFolderHandlers: vi.fn(),
  unregisterCanvasFolderHandlers: vi.fn(),
  registerFolderViewHandlers: vi.fn(),
  unregisterFolderViewHandlers: vi.fn(),
  registerPropertiesHandlers: vi.fn(),
  unregisterPropertiesHandlers: vi.fn(),
  registerRelationHandlers: vi.fn(),
  unregisterRelationHandlers: vi.fn(),
  registerSyncHandlers: vi.fn(),
  unregisterSyncHandlers: vi.fn(),
  checkSyncIntegrity: vi.fn().mockResolvedValue(undefined),
  registerCryptoHandlers: vi.fn(),
  unregisterCryptoHandlers: vi.fn(),
  registerSearchHandlers: vi.fn(),
  unregisterSearchHandlers: vi.fn(),
  registerGraphHandlers: vi.fn(),
  unregisterGraphHandlers: vi.fn(),
  registerAIInlineHandlers: vi.fn(),
  unregisterAIInlineHandlers: vi.fn(),
  registerAccountHandlers: vi.fn(),
  unregisterAccountHandlers: vi.fn(),
  registerUpdaterHandlers: vi.fn(),
  unregisterUpdaterHandlers: vi.fn(),
  registerCrdtIpcHandlers: vi.fn(),
  registerTelemetryHandlers: vi.fn(),
  unregisterTelemetryHandlers: vi.fn(),
  registerFeedbackHandlers: vi.fn(),
  unregisterFeedbackHandlers: vi.fn(),
  registerDiagnosticsHandlers: vi.fn(),
  unregisterDiagnosticsHandlers: vi.fn(),
  registerAgentMcpHandlers: vi.fn(),
  unregisterAgentMcpHandlers: vi.fn(),
  registerImportHandlers: vi.fn(),
  unregisterImportHandlers: vi.fn(),
  registerHomePageHandlers: vi.fn(),
  unregisterHomePageHandlers: vi.fn(),
  registerCustomIconHandlers: vi.fn(),
  unregisterCustomIconHandlers: vi.fn()
}))

vi.mock('./vault-handlers', () => ({
  registerVaultHandlers: hoisted.registerVaultHandlers,
  unregisterVaultHandlers: hoisted.unregisterVaultHandlers
}))
vi.mock('./notes-handlers', () => ({
  registerNotesHandlers: hoisted.registerNotesHandlers,
  unregisterNotesHandlers: hoisted.unregisterNotesHandlers
}))
vi.mock('./tasks-handlers', () => ({
  registerTasksHandlers: hoisted.registerTasksHandlers,
  unregisterTasksHandlers: hoisted.unregisterTasksHandlers
}))
vi.mock('./saved-filters-handlers', () => ({
  registerSavedFiltersHandlers: hoisted.registerSavedFiltersHandlers,
  unregisterSavedFiltersHandlers: hoisted.unregisterSavedFiltersHandlers
}))
vi.mock('./templates-handlers', () => ({
  registerTemplatesHandlers: hoisted.registerTemplatesHandlers,
  unregisterTemplatesHandlers: hoisted.unregisterTemplatesHandlers
}))
vi.mock('./journal-handlers', () => ({
  registerJournalHandlers: hoisted.registerJournalHandlers,
  unregisterJournalHandlers: hoisted.unregisterJournalHandlers
}))
vi.mock('./settings-handlers', () => ({
  registerSettingsHandlers: hoisted.registerSettingsHandlers,
  unregisterSettingsHandlers: hoisted.unregisterSettingsHandlers
}))
vi.mock('./bookmarks-handlers', () => ({
  registerBookmarksHandlers: hoisted.registerBookmarksHandlers,
  unregisterBookmarksHandlers: hoisted.unregisterBookmarksHandlers
}))
vi.mock('./tags-handlers', () => ({
  registerTagsHandlers: hoisted.registerTagsHandlers,
  unregisterTagsHandlers: hoisted.unregisterTagsHandlers
}))
vi.mock('./inbox-handlers', () => ({
  registerInboxHandlers: hoisted.registerInboxHandlers,
  unregisterInboxHandlers: hoisted.unregisterInboxHandlers
}))
vi.mock('./reminder-handlers', () => ({
  registerReminderHandlers: hoisted.registerReminderHandlers,
  unregisterReminderHandlers: hoisted.unregisterReminderHandlers
}))
vi.mock('./calendar-handlers', () => ({
  registerCalendarHandlers: hoisted.registerCalendarHandlers,
  unregisterCalendarHandlers: hoisted.unregisterCalendarHandlers
}))
vi.mock('./canvas-handlers', () => ({
  registerCanvasHandlers: hoisted.registerCanvasHandlers,
  unregisterCanvasHandlers: hoisted.unregisterCanvasHandlers
}))
vi.mock('./canvas-folder-handlers', () => ({
  registerCanvasFolderHandlers: hoisted.registerCanvasFolderHandlers,
  unregisterCanvasFolderHandlers: hoisted.unregisterCanvasFolderHandlers
}))
vi.mock('./folder-view-handlers', () => ({
  registerFolderViewHandlers: hoisted.registerFolderViewHandlers,
  unregisterFolderViewHandlers: hoisted.unregisterFolderViewHandlers
}))
vi.mock('./properties-handlers', () => ({
  registerPropertiesHandlers: hoisted.registerPropertiesHandlers,
  unregisterPropertiesHandlers: hoisted.unregisterPropertiesHandlers
}))
vi.mock('./relation-handlers', () => ({
  registerRelationHandlers: hoisted.registerRelationHandlers,
  unregisterRelationHandlers: hoisted.unregisterRelationHandlers
}))
vi.mock('./sync-core-handlers', () => ({
  registerSyncHandlers: hoisted.registerSyncHandlers,
  unregisterSyncHandlers: hoisted.unregisterSyncHandlers,
  checkSyncIntegrity: hoisted.checkSyncIntegrity
}))
vi.mock('./crypto-handlers', () => ({
  registerCryptoHandlers: hoisted.registerCryptoHandlers,
  unregisterCryptoHandlers: hoisted.unregisterCryptoHandlers
}))
vi.mock('./search-handlers', () => ({
  registerSearchHandlers: hoisted.registerSearchHandlers,
  unregisterSearchHandlers: hoisted.unregisterSearchHandlers
}))
vi.mock('./graph-handlers', () => ({
  registerGraphHandlers: hoisted.registerGraphHandlers,
  unregisterGraphHandlers: hoisted.unregisterGraphHandlers
}))
vi.mock('./ai-inline-handlers', () => ({
  registerAIInlineHandlers: hoisted.registerAIInlineHandlers,
  unregisterAIInlineHandlers: hoisted.unregisterAIInlineHandlers
}))
vi.mock('./account-handlers', () => ({
  registerAccountHandlers: hoisted.registerAccountHandlers,
  unregisterAccountHandlers: hoisted.unregisterAccountHandlers
}))
vi.mock('./updater-handlers', () => ({
  registerUpdaterHandlers: hoisted.registerUpdaterHandlers,
  unregisterUpdaterHandlers: hoisted.unregisterUpdaterHandlers
}))
vi.mock('./crdt-handlers', () => ({
  registerCrdtIpcHandlers: hoisted.registerCrdtIpcHandlers
}))
vi.mock('./telemetry-handlers', () => ({
  registerTelemetryHandlers: hoisted.registerTelemetryHandlers,
  unregisterTelemetryHandlers: hoisted.unregisterTelemetryHandlers
}))
vi.mock('./feedback-handlers', () => ({
  registerFeedbackHandlers: hoisted.registerFeedbackHandlers,
  unregisterFeedbackHandlers: hoisted.unregisterFeedbackHandlers
}))
vi.mock('./diagnostics-handlers', () => ({
  registerDiagnosticsHandlers: hoisted.registerDiagnosticsHandlers,
  unregisterDiagnosticsHandlers: hoisted.unregisterDiagnosticsHandlers
}))
vi.mock('./agent-mcp-handlers', () => ({
  registerAgentMcpHandlers: hoisted.registerAgentMcpHandlers,
  unregisterAgentMcpHandlers: hoisted.unregisterAgentMcpHandlers
}))
vi.mock('./import-handlers', () => ({
  registerImportHandlers: hoisted.registerImportHandlers,
  unregisterImportHandlers: hoisted.unregisterImportHandlers
}))
vi.mock('./home-page-handlers', () => ({
  registerHomePageHandlers: hoisted.registerHomePageHandlers,
  unregisterHomePageHandlers: hoisted.unregisterHomePageHandlers
}))
vi.mock('./custom-icon-handlers', () => ({
  registerCustomIconHandlers: hoisted.registerCustomIconHandlers,
  unregisterCustomIconHandlers: hoisted.unregisterCustomIconHandlers
}))

import { areHandlersRegistered, registerAllHandlers, unregisterAllHandlers } from './index'

describe('ipc index registration lifecycle', () => {
  beforeEach(() => {
    unregisterAllHandlers()
    vi.clearAllMocks()
  })

  it('registers all handler groups once', () => {
    registerAllHandlers()

    expect(areHandlersRegistered()).toBe(true)
    expect(hoisted.registerVaultHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerSyncHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerCryptoHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerTagsHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerUpdaterHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerCrdtIpcHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerTelemetryHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerFeedbackHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerDiagnosticsHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerAgentMcpHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerImportHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerCanvasHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerCanvasFolderHandlers).toHaveBeenCalledTimes(1)
  })

  it('prevents duplicate registration', () => {
    registerAllHandlers()
    registerAllHandlers()

    expect(hoisted.registerVaultHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerSyncHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerCryptoHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerUpdaterHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.registerAgentMcpHandlers).toHaveBeenCalledTimes(1)
  })

  it('unregisters all handlers and resets state', () => {
    registerAllHandlers()

    unregisterAllHandlers()

    expect(areHandlersRegistered()).toBe(false)
    expect(hoisted.unregisterVaultHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.unregisterSyncHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.unregisterCryptoHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.unregisterUpdaterHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.unregisterAgentMcpHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.unregisterImportHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.unregisterCanvasHandlers).toHaveBeenCalledTimes(1)
    expect(hoisted.unregisterCanvasFolderHandlers).toHaveBeenCalledTimes(1)
  })

  it('is a no-op to unregister when handlers are not registered', () => {
    unregisterAllHandlers()

    expect(hoisted.unregisterVaultHandlers).not.toHaveBeenCalled()
    expect(hoisted.unregisterSyncHandlers).not.toHaveBeenCalled()
    expect(hoisted.unregisterCryptoHandlers).not.toHaveBeenCalled()
    expect(hoisted.unregisterUpdaterHandlers).not.toHaveBeenCalled()
    expect(hoisted.unregisterAgentMcpHandlers).not.toHaveBeenCalled()
    expect(areHandlersRegistered()).toBe(false)
  })
})
