/**
 * DOM-specific test setup.
 * Only runs for renderer workspace tests.
 */

import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { IcuFormatter } from '@memry/i18n/shared'
import { RESOURCES } from '@memry/i18n/locales'

// ============================================================================
// i18n singleton: initialize English so components using useT without an
// explicit <I18nextProvider> get real translations (not raw keys). Tests that
// need a specific locale wrap the render in their own <I18nextProvider>.
// initImmediate: false makes init synchronous.
// ============================================================================

void i18next
  .use(IcuFormatter)
  .use(initReactI18next)
  .init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['common', 'inbox', 'notes', 'journal', 'calendar', 'settings', 'errors', 'menu'],
    defaultNS: 'common',
    resources: RESOURCES,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    initImmediate: false
  })

vi.mock('electron-log/renderer', () => {
  const createScopedLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })

  return {
    default: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      scope: vi.fn(() => createScopedLogger())
    }
  }
})

// ============================================================================
// Cleanup after each test
// ============================================================================

afterEach(() => {
  cleanup()
})

// ============================================================================
// Mock window.api (Electron preload bridge)
// ============================================================================

const createMockApi = () => ({
  // Window controls
  windowMinimize: vi.fn(),
  windowMaximize: vi.fn(),
  windowClose: vi.fn(),
  onAppNavigationCommand: vi.fn(() => () => {}),

  // Native context menu bridge (main-process IPC in production)
  showContextMenu: vi.fn().mockResolvedValue(null),

  // Auto-updater API (used by useAppUpdater on mount)
  updater: {
    getState: vi.fn().mockResolvedValue({
      currentVersion: '0.0.0',
      status: 'unavailable',
      updateSupported: false,
      availableVersion: null,
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      downloadProgressPercent: null,
      lastCheckedAt: null,
      error: null
    }),
    checkForUpdates: vi.fn().mockResolvedValue({ status: 'up-to-date' }),
    downloadUpdate: vi.fn().mockResolvedValue({ status: 'downloaded' }),
    quitAndInstall: vi.fn().mockResolvedValue(undefined)
  },

  // Vault API
  vault: {
    select: vi.fn().mockResolvedValue({ success: true, path: '/mock/vault' }),
    create: vi.fn().mockResolvedValue({ success: true }),
    getAll: vi.fn().mockResolvedValue({ vaults: [] }),
    getStatus: vi.fn().mockResolvedValue({ isOpen: false }),
    getConfig: vi.fn().mockResolvedValue({}),
    updateConfig: vi.fn().mockResolvedValue({ success: true }),
    close: vi.fn().mockResolvedValue({ success: true }),
    switch: vi.fn().mockResolvedValue({ success: true }),
    remove: vi.fn().mockResolvedValue({ success: true }),
    reindex: vi.fn().mockResolvedValue({ success: true }),
    deleteFromAccount: vi.fn().mockResolvedValue(undefined)
  },

  // Home boards API (mounted app-wide by HomeTabTitleSync, not only by the Home page)
  homePages: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'home-board', name: 'Home', position: 0, widgets: [] }),
    update: vi.fn().mockResolvedValue({ id: 'home-board', name: 'Home', position: 0, widgets: [] }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true })
  },

  // Notes API
  notes: {
    create: vi.fn().mockResolvedValue({ success: true, note: null }),
    get: vi.fn().mockResolvedValue(null),
    getByPath: vi.fn().mockResolvedValue(null),
    getFile: vi.fn().mockResolvedValue(null),
    largeFileOpen: vi.fn().mockResolvedValue({ status: 'missing' }),
    largeFileReadLines: vi.fn().mockResolvedValue(null),
    largeFileSearch: vi.fn().mockResolvedValue(null),
    largeFileClose: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({ success: true }),
    rename: vi.fn().mockResolvedValue({ success: true }),
    move: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    list: vi.fn().mockResolvedValue({ notes: [], total: 0, hasMore: false }),
    getTags: vi.fn().mockResolvedValue([]),
    getLinks: vi.fn().mockResolvedValue({ outgoing: [], incoming: [] }),
    getFolders: vi.fn().mockResolvedValue([]),
    createFolder: vi.fn().mockResolvedValue({ success: true }),
    renameFolder: vi.fn().mockResolvedValue({ success: true }),
    deleteFolder: vi.fn().mockResolvedValue({ success: true }),
    resolveByTitle: vi.fn().mockResolvedValue(null),
    resolveTitles: vi.fn().mockResolvedValue({}),
    resolveWikiTarget: vi.fn().mockResolvedValue(null),
    previewByTitle: vi.fn().mockResolvedValue(null),
    exists: vi.fn().mockResolvedValue(false),
    openExternal: vi.fn().mockResolvedValue({ success: true }),
    revealInFinder: vi.fn().mockResolvedValue({ success: true }),
    getPropertyDefinitions: vi.fn().mockResolvedValue([]),
    getCalendarPropertyNames: vi.fn().mockResolvedValue([]),
    createPropertyDefinition: vi.fn().mockResolvedValue({ success: true }),
    updatePropertyDefinition: vi.fn().mockResolvedValue({ success: true }),
    uploadAttachment: vi.fn().mockResolvedValue({ success: true }),
    listAttachments: vi.fn().mockResolvedValue([]),
    deleteAttachment: vi.fn().mockResolvedValue({ success: true }),
    getFolderConfig: vi.fn().mockResolvedValue({}),
    setFolderConfig: vi.fn().mockResolvedValue({ success: true }),
    getFolderTemplate: vi.fn().mockResolvedValue(null),
    exportPdf: vi.fn().mockResolvedValue({ success: true }),
    exportHtml: vi.fn().mockResolvedValue({ success: true }),
    getVersions: vi.fn().mockResolvedValue([]),
    getVersion: vi.fn().mockResolvedValue(null),
    restoreVersion: vi.fn().mockResolvedValue({ success: true }),
    deleteVersion: vi.fn().mockResolvedValue({ success: true }),
    getPositions: vi.fn().mockResolvedValue({ success: true, positions: {} }),
    getAllPositions: vi.fn().mockResolvedValue({ success: true, positions: {} }),
    reorder: vi.fn().mockResolvedValue({ success: true }),
    importFiles: vi.fn().mockResolvedValue({
      success: true,
      imported: 0,
      failed: 0,
      errors: [],
      importedFiles: []
    }),
    showImportDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    setLocalOnly: vi.fn().mockResolvedValue({ success: true, note: null }),
    getLocalOnlyCount: vi.fn().mockResolvedValue({ count: 0 }),
    ensurePropertyDefinition: vi.fn().mockResolvedValue({ success: true }),
    addPropertyOption: vi.fn().mockResolvedValue({ success: true }),
    addStatusOption: vi.fn().mockResolvedValue({ success: true }),
    removePropertyOption: vi.fn().mockResolvedValue({ success: true }),
    renamePropertyOption: vi.fn().mockResolvedValue({ success: true }),
    updateOptionColor: vi.fn().mockResolvedValue({ success: true }),
    deletePropertyDefinition: vi.fn().mockResolvedValue({ success: true })
  },

  // Properties API (unified for notes and journal)
  properties: {
    get: vi.fn().mockResolvedValue([]),
    set: vi.fn().mockResolvedValue({ success: true })
  },

  // Tasks API
  tasks: {
    create: vi.fn().mockResolvedValue({ success: true, task: null }),
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    list: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false }),
    complete: vi.fn().mockResolvedValue({ success: true }),
    uncomplete: vi.fn().mockResolvedValue({ success: true }),
    archive: vi.fn().mockResolvedValue({ success: true }),
    unarchive: vi.fn().mockResolvedValue({ success: true }),
    move: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true }),
    duplicate: vi.fn().mockResolvedValue({ success: true }),
    getSubtasks: vi.fn().mockResolvedValue([]),
    convertToSubtask: vi.fn().mockResolvedValue({ success: true }),
    convertToTask: vi.fn().mockResolvedValue({ success: true }),
    createProject: vi.fn().mockResolvedValue({ success: true, project: null }),
    getProject: vi.fn().mockResolvedValue(null),
    updateProject: vi.fn().mockResolvedValue({ success: true }),
    deleteProject: vi.fn().mockResolvedValue({ success: true }),
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    archiveProject: vi.fn().mockResolvedValue({ success: true }),
    reorderProjects: vi.fn().mockResolvedValue({ success: true }),
    linkProjectItem: vi.fn().mockResolvedValue({ success: true }),
    unlinkProjectItem: vi.fn().mockResolvedValue({ success: true }),
    listProjectLinks: vi.fn().mockResolvedValue([]),
    listForItem: vi.fn().mockResolvedValue([]),
    createStatus: vi.fn().mockResolvedValue({ success: true }),
    updateStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteStatus: vi.fn().mockResolvedValue({ success: true }),
    reorderStatuses: vi.fn().mockResolvedValue({ success: true }),
    listStatuses: vi.fn().mockResolvedValue([]),
    getTags: vi.fn().mockResolvedValue([]),
    bulkComplete: vi.fn().mockResolvedValue({ success: true }),
    bulkDelete: vi.fn().mockResolvedValue({ success: true }),
    bulkMove: vi.fn().mockResolvedValue({ success: true }),
    bulkArchive: vi.fn().mockResolvedValue({ success: true }),
    getStats: vi.fn().mockResolvedValue({}),
    getToday: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false }),
    getUpcoming: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false }),
    getOverdue: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false }),
    getLinkedTasks: vi.fn().mockResolvedValue([])
  },

  // Search API
  search: {
    query: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    quick: vi.fn().mockResolvedValue([]),
    suggestions: vi.fn().mockResolvedValue([]),
    getReasons: vi.fn().mockResolvedValue([]),
    clearReasons: vi.fn().mockResolvedValue({ success: true }),
    addReason: vi.fn().mockResolvedValue({ success: true }),
    getStats: vi.fn().mockResolvedValue({}),
    rebuildIndex: vi.fn().mockResolvedValue({ success: true }),
    searchNotes: vi.fn().mockResolvedValue([]),
    findByTag: vi.fn().mockResolvedValue([]),
    findBacklinks: vi.fn().mockResolvedValue([])
  },

  // Settings API
  settings: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue({ success: true }),
    getVoiceRecordingReadiness: vi.fn().mockResolvedValue({ ready: true }),
    openOsMicrophoneSettings: vi.fn().mockResolvedValue({ success: true }),
    getJournalSettings: vi.fn().mockResolvedValue({}),
    setJournalSettings: vi.fn().mockResolvedValue({ success: true }),
    getAISettings: vi.fn().mockResolvedValue({ enabled: false }),
    setAISettings: vi.fn().mockResolvedValue({ success: true }),
    getAIModelStatus: vi.fn().mockResolvedValue({ loaded: false }),
    loadAIModel: vi.fn().mockResolvedValue({ success: true }),
    reindexEmbeddings: vi.fn().mockResolvedValue({ success: true }),
    getTabSettings: vi.fn().mockResolvedValue({}),
    setTabSettings: vi.fn().mockResolvedValue({ success: true }),
    getStartupThemeSync: vi.fn().mockReturnValue('system'),
    getCalendarGoogleSettings: vi.fn().mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    }),
    setCalendarGoogleSettings: vi.fn().mockResolvedValue({ success: true }),
    getCalendarSettings: vi.fn().mockResolvedValue({
      dayCellClickBehavior: 'journal',
      calendarPageClickOverride: 'calendar'
    }),
    setCalendarSettings: vi.fn().mockResolvedValue({ success: true })
  },

  // Inbox API
  inbox: {
    captureText: vi.fn().mockResolvedValue({ success: true }),
    captureLink: vi.fn().mockResolvedValue({ success: true }),
    previewLink: vi.fn().mockResolvedValue({ title: 'Example', domain: 'example.com' }),
    captureImage: vi.fn().mockResolvedValue({ success: true }),
    captureVoice: vi.fn().mockResolvedValue({ success: true }),
    captureClip: vi.fn().mockResolvedValue({ success: true }),
    capturePdf: vi.fn().mockResolvedValue({ success: true }),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ success: true }),
    file: vi.fn().mockResolvedValue({ success: true }),
    getSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
    trackSuggestion: vi.fn().mockResolvedValue({ success: true }),
    convertToNote: vi.fn().mockResolvedValue({ success: true }),
    convertToTask: vi.fn().mockResolvedValue({ success: true, taskId: null }),
    linkToNote: vi.fn().mockResolvedValue({ success: true }),
    addTag: vi.fn().mockResolvedValue({ success: true }),
    removeTag: vi.fn().mockResolvedValue({ success: true }),
    getTags: vi.fn().mockResolvedValue([]),
    archive: vi.fn().mockResolvedValue({ success: true }),
    snooze: vi.fn().mockResolvedValue({ success: true }),
    unsnooze: vi.fn().mockResolvedValue({ success: true }),
    getSnoozed: vi.fn().mockResolvedValue([]),
    markViewed: vi.fn().mockResolvedValue({ success: true }),
    bulkFile: vi.fn().mockResolvedValue({ success: true, processedCount: 0, errors: [] }),
    bulkArchive: vi.fn().mockResolvedValue({ success: true, processedCount: 0, errors: [] }),
    bulkTag: vi.fn().mockResolvedValue({ success: true, processedCount: 0, errors: [] }),
    bulkSnooze: vi.fn().mockResolvedValue({ success: true, processedCount: 0, errors: [] }),
    fileAllStale: vi.fn().mockResolvedValue({ success: true, processedCount: 0, errors: [] }),
    retryTranscription: vi.fn().mockResolvedValue({ success: true }),
    transcribeAudio: vi.fn().mockResolvedValue({ success: true, text: '' }),
    retryMetadata: vi.fn().mockResolvedValue({ success: true }),
    getStats: vi.fn().mockResolvedValue({ totalItems: 0 }),
    getJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    getPatterns: vi.fn().mockResolvedValue({}),
    getStaleThreshold: vi.fn().mockResolvedValue(7),
    setStaleThreshold: vi.fn().mockResolvedValue({ success: true }),
    listArchived: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
    unarchive: vi.fn().mockResolvedValue({ success: true }),
    deletePermanent: vi.fn().mockResolvedValue({ success: true }),
    getFilingHistory: vi.fn().mockResolvedValue({ entries: [] }),
    undoFile: vi.fn().mockResolvedValue({ success: true }),
    undoArchive: vi.fn().mockResolvedValue({ success: true })
  },

  // Journal API
  journal: (() => {
    const getEntry = vi.fn().mockResolvedValue(null)
    const createEntry = vi.fn().mockResolvedValue({ success: true })
    const updateEntry = vi.fn().mockResolvedValue({ success: true })
    const deleteEntry = vi.fn().mockResolvedValue({ success: true })
    const getMonthEntries = vi.fn().mockResolvedValue([])

    return {
      get: getEntry,
      getEntry,
      create: createEntry,
      createEntry,
      update: updateEntry,
      updateEntry,
      delete: deleteEntry,
      deleteEntry,
      list: vi.fn().mockResolvedValue({ entries: [] }),
      getHeatmap: vi.fn().mockResolvedValue([]),
      getMonth: getMonthEntries,
      getMonthEntries
    }
  })(),

  // Reminders API
  reminders: {
    create: vi.fn().mockResolvedValue({ success: true }),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    list: vi.fn().mockResolvedValue([]),
    snooze: vi.fn().mockResolvedValue({ success: true }),
    dismiss: vi.fn().mockResolvedValue({ success: true })
  },

  // Bookmarks API
  bookmarks: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    toggle: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true })
  },

  // Templates API
  templates: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ success: true }),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    duplicate: vi.fn().mockResolvedValue({ success: true }),
    apply: vi.fn().mockResolvedValue({ success: true })
  },

  // Tags API
  tags: {
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    rename: vi.fn().mockResolvedValue({ success: true })
  },

  // Sync Auth API
  syncAuth: {
    requestOtp: vi.fn().mockResolvedValue({ success: true }),
    verifyOtp: vi.fn().mockResolvedValue({ success: true }),
    resendOtp: vi.fn().mockResolvedValue({ success: true })
  },

  // Sync Setup API
  syncSetup: {
    setupFirstDevice: vi.fn().mockResolvedValue({ success: true }),
    confirmRecoveryPhrase: vi.fn().mockResolvedValue({ success: true })
  },

  // Sync Devices API
  syncDevices: {
    getDevices: vi.fn().mockResolvedValue({ devices: [] }),
    removeDevice: vi.fn().mockResolvedValue({ success: true }),
    renameDevice: vi.fn().mockResolvedValue({ success: true })
  },

  // Saved Filters API
  savedFilters: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ success: true }),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true })
  },

  // Agent Chat API
  agent: {
    listConversations: vi.fn().mockResolvedValue([]),
    createConversation: vi.fn().mockResolvedValue(null),
    loadConversation: vi.fn().mockResolvedValue({ conversation: null, messages: [] }),
    sendTurn: vi.fn().mockResolvedValue({ ok: true }),
    cancelTurn: vi.fn().mockResolvedValue({ ok: true }),
    approveTool: vi.fn().mockResolvedValue({ ok: true }),
    previewDiff: vi.fn().mockResolvedValue({ title: '', current: '', candidate: '' }),
    editTrustList: vi.fn().mockResolvedValue(null),
    getBackendStatuses: vi.fn().mockResolvedValue({
      claude_cli: {
        backend: 'claude_cli',
        available: false,
        reason: 'missing_binary',
        detail: null,
        version: null,
        minimumRequired: '2.1.0'
      },
      codex_cli: {
        backend: 'codex_cli',
        available: false,
        reason: 'missing_binary',
        detail: null,
        version: null,
        minimumRequired: '0.130.0'
      },
      local_openai_compatible: {
        backend: 'local_openai_compatible',
        available: true,
        reason: null,
        detail: null
      }
    }),
    listBackendModels: vi.fn().mockImplementation(async ({ backend }) => ({
      backend,
      supportsCustomModel: true,
      models:
        backend === 'claude_cli'
          ? [
              { id: 'sonnet', label: 'Sonnet' },
              { id: 'opus', label: 'Opus' }
            ]
          : [
              { id: 'gpt-5.5', label: 'GPT-5.5' },
              { id: 'gpt-5.4', label: 'GPT-5.4' },
              { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
            ]
    })),
    getLocalProviderSettings: vi.fn().mockResolvedValue({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: '',
      apiKeyConfigured: false,
      allowNonLoopback: false
    }),
    setLocalProviderSettings: vi.fn().mockResolvedValue({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: '',
      apiKeyConfigured: false,
      allowNonLoopback: false
    }),
    getPreferences: vi.fn().mockResolvedValue({
      accessMode: 'vault_only',
      toolApprovalMode: 'always_accept'
    }),
    setPreferences: vi.fn().mockImplementation(async (input) => ({
      accessMode: input?.accessMode ?? 'vault_only',
      toolApprovalMode: input?.toolApprovalMode ?? 'always_accept'
    })),
    listLocalModels: vi.fn().mockResolvedValue({ models: [] }),
    testLocalProvider: vi.fn().mockResolvedValue({
      connected: false,
      modelAvailable: false,
      streamingSupported: false,
      toolCallingSupported: false,
      toolContinuationSupported: false,
      toolsEnabled: false,
      detail: null
    }),
    probeLocalProvider: vi.fn().mockResolvedValue({
      connected: false,
      modelAvailable: false,
      streamingSupported: false,
      toolCallingSupported: false,
      toolContinuationSupported: false,
      toolsEnabled: false,
      detail: null
    }),
    acceptDisclosure: vi.fn().mockResolvedValue({ accepted: true }),
    getDisclosureState: vi.fn().mockResolvedValue({ accepted: false }),
    getWindowId: vi.fn().mockResolvedValue({ windowId: '1' }),
    onEvent: vi.fn().mockReturnValue(() => {})
  },

  // Telemetry API
  telemetry: {
    track: vi.fn().mockResolvedValue({ success: true }),
    flush: vi.fn().mockResolvedValue({ success: true }),
    getSettings: vi.fn().mockResolvedValue({ enabled: false }),
    setEnabled: vi.fn().mockResolvedValue({ success: true })
  },

  // Event subscriptions (return unsubscribe function)
  onMainInvoke: vi.fn().mockReturnValue(() => {}),
  respondToMainInvoke: vi.fn(),
  onVaultStatusChanged: vi.fn().mockReturnValue(() => {}),
  onVaultIndexProgress: vi.fn().mockReturnValue(() => {}),
  onVaultError: vi.fn().mockReturnValue(() => {}),
  onVaultIndexRecovered: vi.fn().mockReturnValue(() => {}),
  onNoteCreated: vi.fn().mockReturnValue(() => {}),
  onNoteUpdated: vi.fn().mockReturnValue(() => {}),
  onNoteDeleted: vi.fn().mockReturnValue(() => {}),
  onNoteRenamed: vi.fn().mockReturnValue(() => {}),
  onNoteMoved: vi.fn().mockReturnValue(() => {}),
  onNoteExternalChange: vi.fn().mockReturnValue(() => {}),
  onCanvasUpdated: vi.fn().mockReturnValue(() => {}),
  onHomePageCreated: vi.fn().mockReturnValue(() => {}),
  onHomePageUpdated: vi.fn().mockReturnValue(() => {}),
  onHomePageDeleted: vi.fn().mockReturnValue(() => {}),
  onCanvasDeleted: vi.fn().mockReturnValue(() => {}),
  onLargeFileIndex: vi.fn().mockReturnValue(() => {}),
  onLargeFileSearchProgress: vi.fn().mockReturnValue(() => {}),
  onTagsChanged: vi.fn().mockReturnValue(() => {}),
  onTaskCreated: vi.fn().mockReturnValue(() => {}),
  onTaskUpdated: vi.fn().mockReturnValue(() => {}),
  onTaskDeleted: vi.fn().mockReturnValue(() => {}),
  onTaskCompleted: vi.fn().mockReturnValue(() => {}),
  onTaskMoved: vi.fn().mockReturnValue(() => {}),
  onTaskActivityCreated: vi.fn().mockReturnValue(() => {}),
  onProjectCreated: vi.fn().mockReturnValue(() => {}),
  onProjectUpdated: vi.fn().mockReturnValue(() => {}),
  onProjectDeleted: vi.fn().mockReturnValue(() => {}),
  onSettingsChanged: vi.fn().mockReturnValue(() => {}),
  onMenuCommand: vi.fn().mockReturnValue(() => {}),
  onReminderDue: vi.fn().mockReturnValue(() => {}),
  onReminderCreated: vi.fn().mockReturnValue(() => {}),
  onReminderUpdated: vi.fn().mockReturnValue(() => {}),
  onReminderDeleted: vi.fn().mockReturnValue(() => {}),
  onReminderDismissed: vi.fn().mockReturnValue(() => {}),
  onReminderSnoozed: vi.fn().mockReturnValue(() => {}),
  onReminderClicked: vi.fn().mockReturnValue(() => {}),
  onInboxOpenItem: vi.fn().mockReturnValue(() => {}),
  onUpdaterStateChanged: vi.fn().mockReturnValue(() => {}),

  // CRDT bridge. Only the health query is mocked here: it is the one call the
  // app makes on mount without an editor, and a healthy answer keeps the
  // degraded-persistence notice silent for every other suite.
  syncCrdt: {
    getHealth: vi.fn().mockResolvedValue({ persistent: true, inMemorySessions: 0 })
  }
})

if (typeof window === 'undefined') {
  throw new Error('setup-dom requires a DOM-like environment.')
}

const windowTarget = window as Window & {
  api?: unknown
  electron?: unknown
}

Object.defineProperty(windowTarget, 'api', {
  value: createMockApi(),
  writable: true
})

Object.defineProperty(windowTarget, 'electron', {
  value: {
    ipcRenderer: {
      send: vi.fn(),
      invoke: vi.fn(),
      on: vi.fn().mockReturnValue(() => {}),
      removeListener: vi.fn()
    }
  },
  writable: true
})

// Export for test customization
export { createMockApi }

// ============================================================================
// Mock ResizeObserver
// ============================================================================

class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

// ============================================================================
// Mock editor geometry APIs
// ============================================================================

const emptyClientRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({})
}

const emptyClientRects = {
  length: 0,
  item: () => null,
  [Symbol.iterator]: function* () {
    return
  }
} as DOMRectList

if (!document.elementFromPoint) {
  document.elementFromPoint = () => document.body
}

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => emptyClientRect as DOMRect
}

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => emptyClientRects
}

if (!HTMLElement.prototype.getBoundingClientRect) {
  HTMLElement.prototype.getBoundingClientRect = () => emptyClientRect as DOMRect
}

if (!HTMLElement.prototype.getClientRects) {
  HTMLElement.prototype.getClientRects = () => emptyClientRects
}

if (typeof Text !== 'undefined') {
  const textPrototype = Text.prototype as Text & {
    getBoundingClientRect?: () => DOMRect
    getClientRects?: () => DOMRectList
  }
  if (!textPrototype.getBoundingClientRect) {
    textPrototype.getBoundingClientRect = () => emptyClientRect as DOMRect
  }
  if (!textPrototype.getClientRects) {
    textPrototype.getClientRects = () => emptyClientRects
  }
}

// ============================================================================
// Mock IntersectionObserver
// ============================================================================

class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  root = null
  rootMargin = ''
  thresholds = []
}

globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver

// ============================================================================
// Mock matchMedia
// ============================================================================

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
})
