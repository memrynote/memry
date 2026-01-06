/**
 * Hook Test Wrapper (T485)
 * Provides providers and utilities for testing React hooks.
 * Includes Mock IPC context, React Query, and Theme providers.
 */

import React, { ReactNode, ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, RenderHookOptions, RenderHookResult } from '@testing-library/react'
import { vi, beforeEach, afterEach, Mock } from 'vitest'

// Re-export testing-library utilities
export * from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'

// ============================================================================
// Query Client Factory
// ============================================================================

/**
 * Create a QueryClient configured for testing.
 * Disables retries and refetch behaviors for predictable tests.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 0,
        gcTime: Infinity
      },
      mutations: {
        retry: false
      }
    }
  })
}

// ============================================================================
// Mock API Types
// ============================================================================

export interface MockAPIConfig {
  notes?: Partial<MockNotesAPI>
  tasks?: Partial<MockTasksAPI>
  search?: Partial<MockSearchAPI>
  journal?: Partial<MockJournalAPI>
  inbox?: Partial<MockInboxAPI>
  bookmarks?: Partial<MockBookmarksAPI>
  reminders?: Partial<MockRemindersAPI>
  vault?: Partial<MockVaultAPI>
}

interface MockNotesAPI {
  create: Mock
  get: Mock
  getByPath: Mock
  update: Mock
  rename: Mock
  move: Mock
  delete: Mock
  list: Mock
  getTags: Mock
  getLinks: Mock
  getFolders: Mock
  createFolder: Mock
  renameFolder: Mock
  deleteFolder: Mock
  exists: Mock
  openExternal: Mock
  revealInFinder: Mock
  getProperties: Mock
  setProperties: Mock
  getPropertyDefinitions: Mock
  createPropertyDefinition: Mock
  updatePropertyDefinition: Mock
  uploadAttachment: Mock
  listAttachments: Mock
  deleteAttachment: Mock
  getFolderConfig: Mock
  setFolderConfig: Mock
  getFolderTemplate: Mock
  exportPdf: Mock
  exportHtml: Mock
  getVersions: Mock
  getVersion: Mock
  restoreVersion: Mock
  deleteVersion: Mock
}

interface MockTasksAPI {
  create: Mock
  get: Mock
  update: Mock
  delete: Mock
  list: Mock
  complete: Mock
  uncomplete: Mock
  archive: Mock
  unarchive: Mock
  move: Mock
  reorder: Mock
  duplicate: Mock
  getSubtasks: Mock
  listProjects: Mock
  getStats: Mock
  getLinkedTasks: Mock
}

interface MockSearchAPI {
  query: Mock
  quick: Mock
  suggestions: Mock
  getRecent: Mock
  addRecent: Mock
  clearRecent: Mock
  getStats: Mock
  rebuildIndex: Mock
}

interface MockJournalAPI {
  get: Mock
  create: Mock
  update: Mock
  delete: Mock
  list: Mock
  getHeatmap: Mock
  getMonth: Mock
  getYearStats: Mock
  getDayContext: Mock
}

interface MockInboxAPI {
  capture: Mock
  captureText: Mock
  captureLink: Mock
  captureVoice: Mock
  list: Mock
  get: Mock
  update: Mock
  delete: Mock
  file: Mock
  archive: Mock
  snooze: Mock
  unsnooze: Mock
  getStats: Mock
  getSnoozed: Mock
  getTags: Mock
  getSuggestions: Mock
  getPatterns: Mock
  getStaleThreshold: Mock
  setStaleThreshold: Mock
}

interface MockBookmarksAPI {
  list: Mock
  listByType: Mock
  toggle: Mock
  isBookmarked: Mock
  delete: Mock
  reorder: Mock
}

interface MockRemindersAPI {
  create: Mock
  update: Mock
  delete: Mock
  list: Mock
  snooze: Mock
  dismiss: Mock
  getForTarget: Mock
}

interface MockVaultAPI {
  select: Mock
  create: Mock
  getAll: Mock
  getStatus: Mock
  getConfig: Mock
  updateConfig: Mock
  close: Mock
  switch: Mock
  remove: Mock
  reindex: Mock
}

// ============================================================================
// Create Mock API
// ============================================================================

/**
 * Create a mock window.api object with all methods mocked.
 */
export function createMockAPI(config?: MockAPIConfig): Record<string, unknown> {
  const journalGet = vi.fn().mockResolvedValue(null)
  const journalCreate = vi.fn().mockResolvedValue({ success: true })
  const journalUpdate = vi.fn().mockResolvedValue({ success: true })
  const journalDelete = vi.fn().mockResolvedValue({ success: true })
  const journalGetMonth = vi.fn().mockResolvedValue([])

  const defaultMocks = {
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
      openExternal: vi.fn().mockResolvedValue(undefined),
      revealInFinder: vi.fn().mockResolvedValue(undefined),
      getProperties: vi.fn().mockResolvedValue([]),
      setProperties: vi.fn().mockResolvedValue({ success: true }),
      getPropertyDefinitions: vi.fn().mockResolvedValue([]),
      createPropertyDefinition: vi.fn().mockResolvedValue({ success: true }),
      updatePropertyDefinition: vi.fn().mockResolvedValue({ success: true }),
      uploadAttachment: vi.fn().mockResolvedValue({ success: true }),
      listAttachments: vi.fn().mockResolvedValue([]),
      deleteAttachment: vi.fn().mockResolvedValue({ success: true }),
      getFolderConfig: vi.fn().mockResolvedValue(null),
      setFolderConfig: vi.fn().mockResolvedValue({ success: true }),
      getFolderTemplate: vi.fn().mockResolvedValue(null),
      exportPdf: vi.fn().mockResolvedValue({ success: true }),
      exportHtml: vi.fn().mockResolvedValue({ success: true }),
      getVersions: vi.fn().mockResolvedValue([]),
      getVersion: vi.fn().mockResolvedValue(null),
      restoreVersion: vi.fn().mockResolvedValue({ success: true }),
      deleteVersion: vi.fn().mockResolvedValue({ success: true }),
      ...config?.notes
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
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      getStats: vi.fn().mockResolvedValue({}),
      getLinkedTasks: vi.fn().mockResolvedValue([]),
      ...config?.tasks
    },

    // Search API
    search: {
      query: vi.fn().mockResolvedValue({ results: [], total: 0, hasMore: false, queryTime: 0 }),
      quick: vi.fn().mockResolvedValue({ notes: [] }),
      suggestions: vi.fn().mockResolvedValue([]),
      getRecent: vi.fn().mockResolvedValue([]),
      addRecent: vi.fn().mockResolvedValue({ success: true }),
      clearRecent: vi.fn().mockResolvedValue({ success: true }),
      getStats: vi.fn().mockResolvedValue({ indexed: 0, pending: 0 }),
      rebuildIndex: vi.fn().mockResolvedValue({ success: true }),
      ...config?.search
    },

    // Journal API
    journal: {
      get: journalGet,
      getEntry: journalGet,
      create: journalCreate,
      createEntry: journalCreate,
      update: journalUpdate,
      updateEntry: journalUpdate,
      delete: journalDelete,
      deleteEntry: journalDelete,
      list: vi.fn().mockResolvedValue({ entries: [] }),
      getHeatmap: vi.fn().mockResolvedValue([]),
      getMonth: journalGetMonth,
      getMonthEntries: journalGetMonth,
      getYearStats: vi.fn().mockResolvedValue([]),
      getDayContext: vi.fn().mockResolvedValue({ tasks: [], events: [], overdueCount: 0 }),
      getAllTags: vi.fn().mockResolvedValue([]),
      getStreak: vi.fn().mockResolvedValue({ current: 0, longest: 0 }),
      ...config?.journal
    },

    // Inbox API
    inbox: {
      capture: vi.fn().mockResolvedValue({ success: true }),
      captureText: vi.fn().mockResolvedValue({ success: true }),
      captureLink: vi.fn().mockResolvedValue({ success: true }),
      captureVoice: vi.fn().mockResolvedValue({ success: true }),
      list: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ success: true }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      file: vi.fn().mockResolvedValue({ success: true }),
      archive: vi.fn().mockResolvedValue({ success: true }),
      snooze: vi.fn().mockResolvedValue({ success: true }),
      unsnooze: vi.fn().mockResolvedValue({ success: true }),
      getStats: vi.fn().mockResolvedValue({ total: 0, unread: 0, stale: 0 }),
      getSnoozed: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
      getSuggestions: vi.fn().mockResolvedValue([]),
      getPatterns: vi.fn().mockResolvedValue([]),
      getStaleThreshold: vi.fn().mockResolvedValue(7),
      setStaleThreshold: vi.fn().mockResolvedValue({ success: true }),
      ...config?.inbox
    },

    // Bookmarks API
    bookmarks: {
      list: vi.fn().mockResolvedValue({ bookmarks: [], total: 0, hasMore: false }),
      listByType: vi.fn().mockResolvedValue({ bookmarks: [], total: 0, hasMore: false }),
      toggle: vi.fn().mockResolvedValue({ success: true, isBookmarked: false, bookmark: null }),
      isBookmarked: vi.fn().mockResolvedValue(false),
      delete: vi.fn().mockResolvedValue({ success: true }),
      reorder: vi.fn().mockResolvedValue({ success: true }),
      ...config?.bookmarks
    },

    // Reminders API
    reminders: {
      create: vi.fn().mockResolvedValue({ success: true }),
      update: vi.fn().mockResolvedValue({ success: true }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      list: vi.fn().mockResolvedValue({ reminders: [], total: 0, hasMore: false }),
      snooze: vi.fn().mockResolvedValue({ success: true }),
      dismiss: vi.fn().mockResolvedValue({ success: true }),
      getForTarget: vi.fn().mockResolvedValue([]),
      ...config?.reminders
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
      ...config?.vault
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
    onJournalEntryCreated: vi.fn().mockReturnValue(() => {}),
    onJournalEntryUpdated: vi.fn().mockReturnValue(() => {}),
    onJournalEntryDeleted: vi.fn().mockReturnValue(() => {}),
    onJournalExternalChange: vi.fn().mockReturnValue(() => {}),
    onInboxCaptured: vi.fn().mockReturnValue(() => {}),
    onInboxUpdated: vi.fn().mockReturnValue(() => {}),
    onInboxArchived: vi.fn().mockReturnValue(() => {}),
    onInboxFiled: vi.fn().mockReturnValue(() => {}),
    onInboxSnoozed: vi.fn().mockReturnValue(() => {}),
    onInboxSnoozeDue: vi.fn().mockReturnValue(() => {}),
    onInboxTranscriptionComplete: vi.fn().mockReturnValue(() => {}),
    onInboxMetadataComplete: vi.fn().mockReturnValue(() => {}),
    onInboxProcessingError: vi.fn().mockReturnValue(() => {}),
    onSearchIndexRebuildProgress: vi.fn().mockReturnValue(() => {}),
    onSearchIndexRebuildCompleted: vi.fn().mockReturnValue(() => {}),
    onBookmarkCreated: vi.fn().mockReturnValue(() => {}),
    onBookmarkDeleted: vi.fn().mockReturnValue(() => {}),
    onBookmarksReordered: vi.fn().mockReturnValue(() => {}),
    onReminderCreated: vi.fn().mockReturnValue(() => {}),
    onReminderUpdated: vi.fn().mockReturnValue(() => {}),
    onReminderDeleted: vi.fn().mockReturnValue(() => {}),
    onReminderDue: vi.fn().mockReturnValue(() => {}),
    onReminderDismissed: vi.fn().mockReturnValue(() => {}),
    onReminderSnoozed: vi.fn().mockReturnValue(() => {}),
    onSettingsChanged: vi.fn().mockReturnValue(() => {})
  }

  return defaultMocks
}

// ============================================================================
// Test Wrapper Provider
// ============================================================================

interface WrapperOptions {
  queryClient?: QueryClient
  mockAPI?: MockAPIConfig
}

/**
 * Create a wrapper component for testing hooks.
 * Provides QueryClientProvider and sets up window.api mocks.
 */
export function createHookWrapper(options: WrapperOptions = {}) {
  const queryClient = options.queryClient || createTestQueryClient()
  const mockAPI = createMockAPI(options.mockAPI)

  // Set up window.api mock
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    value: {
      ...originalWindow,
      api: mockAPI
    },
    writable: true
  })

  return {
    wrapper: function Wrapper({ children }: { children: ReactNode }): ReactElement {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    },
    queryClient,
    mockAPI
  }
}

// ============================================================================
// Custom renderHook with Providers
// ============================================================================

interface RenderHookWithProvidersOptions<TProps> extends Omit<RenderHookOptions<TProps>, 'wrapper'> {
  queryClient?: QueryClient
  mockAPI?: MockAPIConfig
}

interface RenderHookWithProvidersResult<TResult, TProps> extends RenderHookResult<TResult, TProps> {
  queryClient: QueryClient
  mockAPI: Record<string, unknown>
}

/**
 * Custom renderHook that includes all providers and mock API setup.
 * Returns the hook result along with queryClient and mockAPI for assertions.
 *
 * @example
 * ```tsx
 * const { result, mockAPI } = renderHookWithProviders(() => useNotes())
 *
 * // Wait for hook to settle
 * await waitFor(() => expect(result.current.isLoading).toBe(false))
 *
 * // Assert mock was called
 * expect(mockAPI.notes.list).toHaveBeenCalled()
 * ```
 */
export function renderHookWithProviders<TResult, TProps = unknown>(
  hook: (props: TProps) => TResult,
  options: RenderHookWithProvidersOptions<TProps> = {}
): RenderHookWithProvidersResult<TResult, TProps> {
  const { queryClient, mockAPI, ...renderOptions } = options
  const { wrapper, queryClient: client, mockAPI: api } = createHookWrapper({ queryClient, mockAPI })

  const result = renderHook(hook, { wrapper, ...renderOptions })

  return {
    ...result,
    queryClient: client,
    mockAPI: api
  }
}

// ============================================================================
// Test Setup Helpers
// ============================================================================

let originalApi: unknown
let hadOriginalApi = false

/**
 * Set up hook test environment.
 * Call in beforeEach to ensure clean state.
 */
export function setupHookTestEnvironment(mockAPIConfig?: MockAPIConfig) {
  if (typeof window === 'undefined') {
    throw new Error('setupHookTestEnvironment requires a DOM-like environment.')
  }

  hadOriginalApi = Object.prototype.hasOwnProperty.call(window, 'api')
  originalApi = (window as Window & { api?: unknown }).api
  const mockAPI = createMockAPI(mockAPIConfig)

  Object.defineProperty(window, 'api', {
    value: mockAPI,
    writable: true
  })

  return mockAPI
}

/**
 * Clean up hook test environment.
 * Call in afterEach to restore the previous mock API.
 */
export function cleanupHookTestEnvironment() {
  if (typeof window === 'undefined') {
    return
  }

  if (hadOriginalApi) {
    Object.defineProperty(window, 'api', {
      value: originalApi,
      writable: true
    })
  } else {
    delete (window as Window & { api?: unknown }).api
  }
}

/**
 * Create a standard hook test harness with beforeEach/afterEach setup.
 */
export function createHookTestHarness(mockAPIConfig?: MockAPIConfig) {
  let mockAPI: Record<string, unknown>
  let queryClient: QueryClient

  beforeEach(() => {
    mockAPI = setupHookTestEnvironment(mockAPIConfig)
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
  })

  return {
    getMockAPI: () => mockAPI,
    getQueryClient: () => queryClient,
    getWrapper: () => {
      return function Wrapper({ children }: { children: ReactNode }): ReactElement {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      }
    }
  }
}

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Wait for a specified number of milliseconds.
 * Useful for testing debounced hooks.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for React Query to settle.
 */
export async function waitForQueryToSettle(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Advance fake timers and flush promises.
 * Useful for testing debounced operations.
 */
export async function advanceTimersAndFlush(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ============================================================================
// Mock Data Factories
// ============================================================================

/**
 * Create a mock note object.
 */
export function createMockNote(overrides: Partial<{
  id: string
  title: string
  content: string
  path: string
  folder: string
  tags: string[]
  created: string
  modified: string
}> = {}) {
  return {
    id: overrides.id ?? 'note-1',
    title: overrides.title ?? 'Test Note',
    content: overrides.content ?? 'Test content',
    path: overrides.path ?? 'notes/test-note.md',
    folder: overrides.folder ?? 'notes',
    tags: overrides.tags ?? [],
    created: overrides.created ?? new Date().toISOString(),
    modified: overrides.modified ?? new Date().toISOString(),
    ...overrides
  }
}

/**
 * Create a mock task object.
 */
export function createMockTask(overrides: Partial<{
  id: string
  title: string
  description: string
  projectId: string
  statusId: string
  priority: number
  dueDate: string | null
  completedAt: string | null
  archivedAt: string | null
  position: number
}> = {}) {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Test Task',
    description: overrides.description ?? '',
    projectId: overrides.projectId ?? 'project-1',
    statusId: overrides.statusId ?? 'status-1',
    priority: overrides.priority ?? 2,
    dueDate: overrides.dueDate ?? null,
    completedAt: overrides.completedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    position: overrides.position ?? 0,
    ...overrides
  }
}

/**
 * Create a mock journal entry object.
 */
export function createMockJournalEntry(overrides: Partial<{
  id: string
  date: string
  content: string
  tags: string[]
  wordCount: number
  activityLevel: number
}> = {}) {
  return {
    id: overrides.id ?? 'journal-1',
    date: overrides.date ?? '2026-01-03',
    content: overrides.content ?? 'Test journal content',
    tags: overrides.tags ?? [],
    wordCount: overrides.wordCount ?? 10,
    activityLevel: overrides.activityLevel ?? 1,
    ...overrides
  }
}

/**
 * Create a mock inbox item object.
 */
export function createMockInboxItem(overrides: Partial<{
  id: string
  type: string
  title: string
  content: string
  url: string | null
  createdAt: string
  snoozedUntil: string | null
}> = {}) {
  return {
    id: overrides.id ?? 'inbox-1',
    type: overrides.type ?? 'text',
    title: overrides.title ?? 'Test Inbox Item',
    content: overrides.content ?? 'Test content',
    url: overrides.url ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    snoozedUntil: overrides.snoozedUntil ?? null,
    ...overrides
  }
}

/**
 * Create a mock bookmark object.
 */
export function createMockBookmark(overrides: Partial<{
  id: string
  itemType: string
  itemId: string
  itemTitle: string
  position: number
  createdAt: string
}> = {}) {
  return {
    id: overrides.id ?? 'bookmark-1',
    itemType: overrides.itemType ?? 'note',
    itemId: overrides.itemId ?? 'note-1',
    itemTitle: overrides.itemTitle ?? 'Test Note',
    position: overrides.position ?? 0,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...overrides
  }
}

/**
 * Create a mock reminder object.
 */
export function createMockReminder(overrides: Partial<{
  id: string
  targetType: string
  targetId: string
  dueAt: string
  note: string
  status: string
}> = {}) {
  return {
    id: overrides.id ?? 'reminder-1',
    targetType: overrides.targetType ?? 'note',
    targetId: overrides.targetId ?? 'note-1',
    dueAt: overrides.dueAt ?? new Date().toISOString(),
    note: overrides.note ?? '',
    status: overrides.status ?? 'pending',
    ...overrides
  }
}
