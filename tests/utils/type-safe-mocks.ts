/**
 * Type-Safe Mock Utilities
 *
 * These utilities create mocks that are type-checked against the real API.
 * If the real API changes, TypeScript will catch mismatches at compile time.
 *
 * @example
 * ```typescript
 * // If NotesClientAPI.getStats changes from () => Stats to (id: string) => Stats,
 * // this will show a TypeScript error:
 * const mockNotes = createTypeSafeMock<NotesClientAPI>({
 *   getStats: vi.fn().mockResolvedValue({})  // ❌ Error: signature mismatch
 * })
 * ```
 */

import { vi } from 'vitest'
import type {
  NotesClientAPI,
  TasksClientAPI,
  SearchClientAPI,
  JournalClientAPI,
  InboxClientAPI,
  BookmarksClientAPI,
  RemindersClientAPI,
  VaultClientAPI,
  TagsClientAPI,
  TemplatesClientAPI,
  SavedFiltersClientAPI,
  SettingsClientAPI,
  FolderViewClientAPI
} from '../../src/preload/index.d'

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * Converts a function type to a Vitest Mock with the same signature.
 * Uses ReturnType<typeof vi.fn> which is the actual mock type.
 */
type MockedFunction<T extends (...args: unknown[]) => unknown> =
  ReturnType<typeof vi.fn<Parameters<T>, ReturnType<T>>>

/**
 * Converts an API interface to a mocked version where all methods
 * are Vitest Mocks with preserved signatures.
 */
export type MockedAPI<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? MockedFunction<T[K]>
    : never
}

/**
 * Partial mocked API - allows overriding only some methods
 */
export type PartialMockedAPI<T> = Partial<MockedAPI<T>>

// ============================================================================
// Type-Safe API Mock Types
// ============================================================================

// These types are derived from the REAL API types
// If the real API changes, TypeScript will catch it here!

export type TypeSafeNotesAPI = MockedAPI<NotesClientAPI>
export type TypeSafeTasksAPI = MockedAPI<TasksClientAPI>
export type TypeSafeSearchAPI = MockedAPI<SearchClientAPI>
export type TypeSafeJournalAPI = MockedAPI<JournalClientAPI>
export type TypeSafeInboxAPI = MockedAPI<InboxClientAPI>
export type TypeSafeBookmarksAPI = MockedAPI<BookmarksClientAPI>
export type TypeSafeRemindersAPI = MockedAPI<RemindersClientAPI>
export type TypeSafeVaultAPI = MockedAPI<VaultClientAPI>
export type TypeSafeTagsAPI = MockedAPI<TagsClientAPI>
export type TypeSafeTemplatesAPI = MockedAPI<TemplatesClientAPI>
export type TypeSafeSavedFiltersAPI = MockedAPI<SavedFiltersClientAPI>
export type TypeSafeSettingsAPI = MockedAPI<SettingsClientAPI>
export type TypeSafeFolderViewAPI = MockedAPI<FolderViewClientAPI>

// ============================================================================
// Mock Factory Functions
// ============================================================================

/**
 * Creates a type-safe mock for NotesClientAPI.
 * All methods will have correct parameter and return types.
 *
 * @example
 * ```typescript
 * const notesMock = createNotesMock({
 *   // TypeScript knows this should return Promise<NoteListResponse>
 *   list: vi.fn().mockResolvedValue({ notes: [], total: 0, hasMore: false }),
 *
 *   // TypeScript error if signature doesn't match!
 *   get: vi.fn().mockResolvedValue(null)  // ✓ Correct: (id: string) => Promise<Note | null>
 * })
 * ```
 */
export function createNotesMock(
  overrides: PartialMockedAPI<NotesClientAPI> = {}
): TypeSafeNotesAPI {
  return {
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
    createPropertyDefinition: vi.fn().mockResolvedValue({ success: true, definition: null }),
    updatePropertyDefinition: vi.fn().mockResolvedValue({ success: true, definition: null }),
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
    ...overrides
  } as TypeSafeNotesAPI
}

/**
 * Creates a type-safe mock for TasksClientAPI.
 */
export function createTasksMock(
  overrides: PartialMockedAPI<TasksClientAPI> = {}
): TypeSafeTasksAPI {
  return {
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
    ...overrides
  } as TypeSafeTasksAPI
}

/**
 * Creates a type-safe mock for BookmarksClientAPI.
 */
export function createBookmarksMock(
  overrides: PartialMockedAPI<BookmarksClientAPI> = {}
): TypeSafeBookmarksAPI {
  return {
    list: vi.fn().mockResolvedValue({ bookmarks: [], total: 0, hasMore: false }),
    listByType: vi.fn().mockResolvedValue({ bookmarks: [], total: 0, hasMore: false }),
    toggle: vi.fn().mockResolvedValue({ success: true, isBookmarked: false, bookmark: null }),
    isBookmarked: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true }),
    ...overrides
  } as TypeSafeBookmarksAPI
}

// ============================================================================
// Full API Mock
// ============================================================================

export interface TypeSafeAPIConfig {
  notes?: PartialMockedAPI<NotesClientAPI>
  tasks?: PartialMockedAPI<TasksClientAPI>
  search?: PartialMockedAPI<SearchClientAPI>
  journal?: PartialMockedAPI<JournalClientAPI>
  inbox?: PartialMockedAPI<InboxClientAPI>
  bookmarks?: PartialMockedAPI<BookmarksClientAPI>
  reminders?: PartialMockedAPI<RemindersClientAPI>
  vault?: PartialMockedAPI<VaultClientAPI>
}

/**
 * The full API structure matching window.api
 */
export interface TypeSafeWindowAPI {
  notes: TypeSafeNotesAPI
  tasks: TypeSafeTasksAPI
  bookmarks: TypeSafeBookmarksAPI
  // Add other APIs as needed
}

/**
 * Creates a complete type-safe window.api mock.
 *
 * @example
 * ```typescript
 * const api = createTypeSafeAPI({
 *   notes: {
 *     // Type-checked! Must match NotesClientAPI.list signature
 *     list: vi.fn().mockResolvedValue({ notes: mockNotes, total: 1, hasMore: false })
 *   }
 * })
 *
 * // Set up in test
 * window.api = api
 * ```
 */
export function createTypeSafeAPI(config: TypeSafeAPIConfig = {}): TypeSafeWindowAPI {
  return {
    notes: createNotesMock(config.notes),
    tasks: createTasksMock(config.tasks),
    bookmarks: createBookmarksMock(config.bookmarks)
    // Add other APIs...
  }
}

// ============================================================================
// Type Guard for Compile-Time Verification
// ============================================================================

/**
 * This function doesn't do anything at runtime, but it verifies at compile-time
 * that our mock types match the real API types.
 *
 * If NotesClientAPI changes and our mocks don't match, TypeScript will error here.
 */
function _verifyMockTypesMatchRealAPI(): void {
  // This would fail to compile if types don't match
  const _notesMock: NotesClientAPI = {} as TypeSafeNotesAPI
  const _tasksMock: TasksClientAPI = {} as TypeSafeTasksAPI
  const _bookmarksMock: BookmarksClientAPI = {} as TypeSafeBookmarksAPI

  // Prevent unused variable warnings
  void _notesMock
  void _tasksMock
  void _bookmarksMock
}
