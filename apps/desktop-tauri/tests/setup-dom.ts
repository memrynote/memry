/**
 * DOM-specific test setup.
 * Only runs for renderer workspace tests.
 */

import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

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

  // Native context menu bridge (main-process IPC in production)
  showContextMenu: vi.fn().mockResolvedValue(null),

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
    reindex: vi.fn().mockResolvedValue({ success: true })
  },

  // Notes API
  notes: {
    create: vi.fn().mockResolvedValue({ success: true, note: null }),
    get: vi.fn().mockResolvedValue(null),
    getByPath: vi.fn().mockResolvedValue(null),
    getFile: vi.fn().mockResolvedValue(null),
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
    previewByTitle: vi.fn().mockResolvedValue(null),
    exists: vi.fn().mockResolvedValue(false),
    openExternal: vi.fn().mockResolvedValue({ success: true }),
    revealInFinder: vi.fn().mockResolvedValue({ success: true }),
    getPropertyDefinitions: vi.fn().mockResolvedValue([]),
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
    getLinkedTasks: vi.fn().mockResolvedValue([]),
    seedPerformanceTest: vi.fn().mockResolvedValue({ success: true }),
    seedDemo: vi.fn().mockResolvedValue({ success: true })
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

  // Event subscriptions (return unsubscribe function)
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
  onTagsChanged: vi.fn().mockReturnValue(() => {}),
  onTaskCreated: vi.fn().mockReturnValue(() => {}),
  onTaskUpdated: vi.fn().mockReturnValue(() => {}),
  onTaskDeleted: vi.fn().mockReturnValue(() => {}),
  onTaskCompleted: vi.fn().mockReturnValue(() => {}),
  onTaskMoved: vi.fn().mockReturnValue(() => {}),
  onProjectCreated: vi.fn().mockReturnValue(() => {}),
  onProjectUpdated: vi.fn().mockReturnValue(() => {}),
  onProjectDeleted: vi.fn().mockReturnValue(() => {}),
  onSettingsChanged: vi.fn().mockReturnValue(() => {}),
  onReminderDue: vi.fn().mockReturnValue(() => {})
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

// ============================================================================
// IPC adapter: route invoke() / listen() / subscribeEvent() to window.api
//
// Service, hook, context, and component code under test calls the Tauri
// wrapper `invoke('<domain>_<method>', args)` instead of `window.api.X.Y(args)`.
// To let existing tests keep mocking through `window.api.X.Y = vi.fn()`, we
// install a dispatcher that decodes the command name back into a method call
// on the mock API.
//
// `createMockApi()` is still the single source of mocked behavior for tests.
// ============================================================================

function snakeToCamel(input: string): string {
  return input.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function kebabToEventKey(event: string): string {
  // 'note-created' → 'onNoteCreated'
  const parts = event.split('-')
  return 'on' + parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

type AnyFn = (...args: unknown[]) => unknown

function resolveApiMethod(cmd: string): AnyFn {
  const api = (windowTarget.api ?? {}) as Record<
    string,
    Record<string, AnyFn> | AnyFn | undefined
  >

  // Command names look like `<domain>_<method>` where the domain itself may
  // contain underscores (e.g. `sync_auth_request_otp` routes to
  // `api.syncAuth.requestOtp`). The mapping from a flat snake-case command to
  // a nested `(domain, method)` pair is ambiguous — try every split point and
  // accept the first that resolves to a function.
  const parts = cmd.split('_')
  for (let cut = parts.length - 1; cut >= 1; cut -= 1) {
    const domain = snakeToCamel(parts.slice(0, cut).join('_'))
    const method = snakeToCamel(parts.slice(cut).join('_'))
    const domainApi = api[domain]
    if (domainApi && typeof domainApi === 'object') {
      const fn = (domainApi as Record<string, AnyFn>)[method]
      if (typeof fn === 'function') return fn
    }
  }

  // Top-level method on the api (e.g. `window_minimize` → `windowMinimize`).
  const topLevel = api[snakeToCamel(cmd)]
  if (typeof topLevel === 'function') return topLevel as AnyFn

  // Zero-underscore command (e.g. `notes_list` was handled above because
  // parts.length >= 2; this branch only fires for single-word commands).
  if (parts.length === 1) {
    const method = api[cmd]
    if (typeof method === 'function') return method as AnyFn
  }

  throw new Error(`Mock IPC: command "${cmd}" not implemented on window.api`)
}

function unpackArgs(payload: unknown): unknown[] {
  if (payload === undefined) return []
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { args?: unknown[] }).args)
  ) {
    return (payload as { args: unknown[] }).args
  }
  return [payload]
}

vi.mock('@/lib/ipc/invoke', () => ({
  // Synchronous pass-through: the mock api method (usually a vi.fn returning
  // a promise) is invoked and its result is returned directly. Avoiding an
  // extra async wrapper keeps microtask timing close to the pre-Phase-H
  // path where callers invoked window.api.X.Y directly — tests that rely
  // on a small number of `await Promise.resolve()` ticks continue to work.
  invoke: vi.fn((cmd: string, args?: unknown) => {
    const fn = resolveApiMethod(cmd)
    return fn(...unpackArgs(args))
  })
}))

vi.mock('@/lib/ipc/events', () => ({
  listen: vi.fn(async () => () => {}),
  listenOnce: vi.fn(async () => {})
}))

vi.mock('@/lib/ipc/forwarder', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/ipc/forwarder')>(
    '../src/lib/ipc/forwarder'
  )
  return {
    ...actual,
    subscribeEvent: vi.fn((event: string, callback: (payload: unknown) => void) => {
      const eventKey = kebabToEventKey(event)
      const api = windowTarget.api as Record<string, AnyFn> | undefined
      const sub = api?.[eventKey]
      if (typeof sub === 'function') {
        const result = sub(callback)
        if (typeof result === 'function') return result
      }
      return () => {}
    })
  }
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
