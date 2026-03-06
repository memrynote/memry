/**
 * Error codes for vault operations
 */
export const VaultErrorCode = {
  NOT_FOUND: 'VAULT_NOT_FOUND',
  NOT_INITIALIZED: 'VAULT_NOT_INITIALIZED',
  INVALID_PATH: 'VAULT_INVALID_PATH',
  PERMISSION_DENIED: 'VAULT_PERMISSION_DENIED',
  ALREADY_EXISTS: 'VAULT_ALREADY_EXISTS',
  CORRUPTED: 'VAULT_CORRUPTED'
} as const

export type VaultErrorCode = (typeof VaultErrorCode)[keyof typeof VaultErrorCode]

/**
 * Error for vault-related operations.
 */
export class VaultError extends Error {
  constructor(
    message: string,
    public code: VaultErrorCode
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

/**
 * Error codes for note operations
 */
export const NoteErrorCode = {
  NOT_FOUND: 'NOTE_NOT_FOUND',
  INVALID_FRONTMATTER: 'NOTE_INVALID_FRONTMATTER',
  DUPLICATE_ID: 'NOTE_DUPLICATE_ID',
  WRITE_FAILED: 'NOTE_WRITE_FAILED',
  READ_FAILED: 'NOTE_READ_FAILED',
  DELETE_FAILED: 'NOTE_DELETE_FAILED',
  INVALID_PATH: 'NOTE_INVALID_PATH'
} as const

export type NoteErrorCode = (typeof NoteErrorCode)[keyof typeof NoteErrorCode]

/**
 * Error for note-related operations.
 */
export class NoteError extends Error {
  constructor(
    message: string,
    public code: NoteErrorCode,
    public noteId?: string
  ) {
    super(message)
    this.name = 'NoteError'
  }
}

/**
 * Error codes for database operations
 */
export const DatabaseErrorCode = {
  CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  MIGRATION_FAILED: 'DB_MIGRATION_FAILED',
  QUERY_FAILED: 'DB_QUERY_FAILED',
  NOT_INITIALIZED: 'DB_NOT_INITIALIZED',
  CONSTRAINT_VIOLATION: 'DB_CONSTRAINT_VIOLATION',
  CORRUPTED: 'DB_CORRUPTED'
} as const

export type DatabaseErrorCode = (typeof DatabaseErrorCode)[keyof typeof DatabaseErrorCode]

/**
 * Error for database-related operations.
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public code: DatabaseErrorCode
  ) {
    super(message)
    this.name = 'DatabaseError'
  }
}

/**
 * Error codes for file watcher operations
 */
export const WatcherErrorCode = {
  START_FAILED: 'WATCHER_START_FAILED',
  STOP_FAILED: 'WATCHER_STOP_FAILED',
  EVENT_ERROR: 'WATCHER_EVENT_ERROR'
} as const

export type WatcherErrorCode = (typeof WatcherErrorCode)[keyof typeof WatcherErrorCode]

/**
 * Error for file watcher operations.
 */
export class WatcherError extends Error {
  constructor(
    message: string,
    public code: WatcherErrorCode
  ) {
    super(message)
    this.name = 'WatcherError'
  }
}

/**
 * Type guard to check if an error is a VaultError
 */
export function isVaultError(error: unknown): error is VaultError {
  return error instanceof VaultError
}

/**
 * Type guard to check if an error is a NoteError
 */
export function isNoteError(error: unknown): error is NoteError {
  return error instanceof NoteError
}

/**
 * Type guard to check if an error is a DatabaseError
 */
export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError
}

/**
 * Type guard to check if an error is a WatcherError
 */
export function isWatcherError(error: unknown): error is WatcherError {
  return error instanceof WatcherError
}
