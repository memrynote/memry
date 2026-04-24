import type { SyncErrorCategory } from '@memry/contracts/ipc-sync-ops'

export const ERROR_CODES = {
  VAULT_NOT_FOUND: 'VAULT_NOT_FOUND',
  VAULT_NOT_INITIALIZED: 'VAULT_NOT_INITIALIZED',
  VAULT_INVALID_PATH: 'VAULT_INVALID_PATH',
  VAULT_PERMISSION_DENIED: 'VAULT_PERMISSION_DENIED',
  VAULT_ALREADY_EXISTS: 'VAULT_ALREADY_EXISTS',
  VAULT_CORRUPTED: 'VAULT_CORRUPTED',

  NOTE_NOT_FOUND: 'NOTE_NOT_FOUND',
  NOTE_INVALID_FRONTMATTER: 'NOTE_INVALID_FRONTMATTER',
  NOTE_DUPLICATE_ID: 'NOTE_DUPLICATE_ID',
  NOTE_WRITE_FAILED: 'NOTE_WRITE_FAILED',
  NOTE_READ_FAILED: 'NOTE_READ_FAILED',
  NOTE_DELETE_FAILED: 'NOTE_DELETE_FAILED',
  NOTE_INVALID_PATH: 'NOTE_INVALID_PATH',

  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_MIGRATION_FAILED: 'DB_MIGRATION_FAILED',
  DB_QUERY_FAILED: 'DB_QUERY_FAILED',
  DB_NOT_INITIALIZED: 'DB_NOT_INITIALIZED',
  DB_CONSTRAINT_VIOLATION: 'DB_CONSTRAINT_VIOLATION',
  DB_CORRUPTED: 'DB_CORRUPTED',

  WATCHER_START_FAILED: 'WATCHER_START_FAILED',
  WATCHER_STOP_FAILED: 'WATCHER_STOP_FAILED',
  WATCHER_EVENT_ERROR: 'WATCHER_EVENT_ERROR',

  ATTACHMENT_FILE_TOO_LARGE: 'ATTACHMENT_FILE_TOO_LARGE',
  ATTACHMENT_UNSUPPORTED_TYPE: 'ATTACHMENT_UNSUPPORTED_TYPE',
  ATTACHMENT_WRITE_FAILED: 'ATTACHMENT_WRITE_FAILED',
  ATTACHMENT_DELETE_FAILED: 'ATTACHMENT_DELETE_FAILED',

  ENCRYPTION_FAILED: 'ENCRYPTION_FAILED',
  DECRYPTION_FAILED: 'DECRYPTION_FAILED',
  INVALID_KEY_LENGTH: 'INVALID_KEY_LENGTH',
  INVALID_NONCE_LENGTH: 'INVALID_NONCE_LENGTH',

  INBOX_ATTACHMENT_WRITE_FAILED: 'INBOX_ATTACHMENT_WRITE_FAILED',
  INBOX_ATTACHMENT_DELETE_FAILED: 'INBOX_ATTACHMENT_DELETE_FAILED'
} as const

const ERROR_MESSAGES: Record<string, string> = {
  [ERROR_CODES.VAULT_NOT_FOUND]: 'Vault not found. It may have been moved or deleted.',
  [ERROR_CODES.VAULT_NOT_INITIALIZED]: 'No vault is open. Open or create a vault to continue.',
  [ERROR_CODES.VAULT_INVALID_PATH]: 'The selected path is not a valid vault location.',
  [ERROR_CODES.VAULT_PERMISSION_DENIED]:
    'Permission denied. Check that you have access to this folder.',
  [ERROR_CODES.VAULT_ALREADY_EXISTS]: 'A vault already exists at this location.',
  [ERROR_CODES.VAULT_CORRUPTED]: 'This vault appears to be corrupted. Try restoring from a backup.',

  [ERROR_CODES.NOTE_NOT_FOUND]: 'This note could not be found. It may have been deleted.',
  [ERROR_CODES.NOTE_INVALID_FRONTMATTER]: 'This note has invalid metadata and cannot be read.',
  [ERROR_CODES.NOTE_DUPLICATE_ID]: 'A note with this ID already exists.',
  [ERROR_CODES.NOTE_WRITE_FAILED]: 'Failed to save this note. Check disk space and permissions.',
  [ERROR_CODES.NOTE_READ_FAILED]: 'Failed to read this note. The file may be locked or corrupted.',
  [ERROR_CODES.NOTE_DELETE_FAILED]: 'Failed to delete this note. Check file permissions.',
  [ERROR_CODES.NOTE_INVALID_PATH]: 'The note path is invalid.',

  [ERROR_CODES.DB_CONNECTION_FAILED]:
    'Could not connect to the local database. Try restarting the app.',
  [ERROR_CODES.DB_MIGRATION_FAILED]: 'Database upgrade failed. Try restarting the app.',
  [ERROR_CODES.DB_QUERY_FAILED]: 'A database operation failed. Try again.',
  [ERROR_CODES.DB_NOT_INITIALIZED]: 'Database not ready. Try restarting the app.',
  [ERROR_CODES.DB_CONSTRAINT_VIOLATION]: 'A data conflict occurred. Try again.',
  [ERROR_CODES.DB_CORRUPTED]: 'The local database is corrupted. You may need to reset it.',

  [ERROR_CODES.WATCHER_START_FAILED]: 'Could not start watching for file changes.',
  [ERROR_CODES.WATCHER_STOP_FAILED]: 'Could not stop the file watcher.',
  [ERROR_CODES.WATCHER_EVENT_ERROR]: 'An error occurred while watching for file changes.',

  [ERROR_CODES.ATTACHMENT_FILE_TOO_LARGE]: 'This file is too large to attach.',
  [ERROR_CODES.ATTACHMENT_UNSUPPORTED_TYPE]: 'This file type is not supported.',
  [ERROR_CODES.ATTACHMENT_WRITE_FAILED]: 'Failed to save the attachment. Check disk space.',
  [ERROR_CODES.ATTACHMENT_DELETE_FAILED]: 'Failed to delete the attachment.',

  [ERROR_CODES.ENCRYPTION_FAILED]: 'Failed to encrypt data. Your keys may need to be regenerated.',
  [ERROR_CODES.DECRYPTION_FAILED]:
    'Failed to decrypt data. Your encryption keys may be out of date.',
  [ERROR_CODES.INVALID_KEY_LENGTH]: 'Invalid encryption key. Try signing out and back in.',
  [ERROR_CODES.INVALID_NONCE_LENGTH]: 'Encryption error. Try the operation again.',

  [ERROR_CODES.INBOX_ATTACHMENT_WRITE_FAILED]: 'Failed to save the inbox attachment.',
  [ERROR_CODES.INBOX_ATTACHMENT_DELETE_FAILED]: 'Failed to delete the inbox attachment.'
}

const SYNC_ERROR_MESSAGES: Record<SyncErrorCategory, string> = {
  network_offline: 'You are offline. Changes will sync when you reconnect.',
  network_timeout: 'The sync server took too long to respond. Will retry shortly.',
  server_error: 'The sync server encountered an error. Will retry automatically.',
  auth_expired: 'Your session has expired. Sign in again to continue syncing.',
  device_revoked: 'This device has been removed from your account.',
  rate_limited: 'Too many requests. Syncing will resume shortly.',
  crypto_failure: 'Failed to encrypt or decrypt sync data. Try signing out and back in.',
  version_incompatible: 'This version of Memry is no longer supported. Please update.',
  storage_quota_exceeded: 'Your sync storage is full. Free up space or upgrade your plan.',
  certificate_pin_failed: 'Secure connection failed. Check your network connection.',
  unknown: 'An unexpected sync error occurred. Will retry automatically.'
}

export function getUserErrorMessage(code: string, fallback?: string): string {
  return (
    ERROR_MESSAGES[code] ??
    SYNC_ERROR_MESSAGES[code as SyncErrorCategory] ??
    fallback ??
    'Something went wrong. Please try again.'
  )
}

export function getSyncErrorMessage(category: SyncErrorCategory): string {
  return SYNC_ERROR_MESSAGES[category]
}
