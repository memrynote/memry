/**
 * DOM-specific test setup.
 * Only runs for renderer workspace tests.
 */

import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

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
    exists: vi.fn().mockResolvedValue(false),
    openExternal: vi.fn().mockResolvedValue({ success: true }),
    revealInFinder: vi.fn().mockResolvedValue({ success: true }),
    getProperties: vi.fn().mockResolvedValue({}),
    setProperties: vi.fn().mockResolvedValue({ success: true }),
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
    deleteVersion: vi.fn().mockResolvedValue({ success: true })
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
    getToday: vi.fn().mockResolvedValue([]),
    getUpcoming: vi.fn().mockResolvedValue([]),
    getOverdue: vi.fn().mockResolvedValue([]),
    getLinkedTasks: vi.fn().mockResolvedValue([]),
    seedPerformanceTest: vi.fn().mockResolvedValue({ success: true }),
    seedDemo: vi.fn().mockResolvedValue({ success: true })
  },

  // Search API
  search: {
    query: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    quick: vi.fn().mockResolvedValue([]),
    suggestions: vi.fn().mockResolvedValue([]),
    getRecent: vi.fn().mockResolvedValue([]),
    clearRecent: vi.fn().mockResolvedValue({ success: true }),
    addRecent: vi.fn().mockResolvedValue({ success: true }),
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
    setTabSettings: vi.fn().mockResolvedValue({ success: true })
  },

  // Inbox API
  inbox: {
    capture: vi.fn().mockResolvedValue({ success: true }),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    file: vi.fn().mockResolvedValue({ success: true }),
    archive: vi.fn().mockResolvedValue({ success: true }),
    snooze: vi.fn().mockResolvedValue({ success: true }),
    unsnooze: vi.fn().mockResolvedValue({ success: true })
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

globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver

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
