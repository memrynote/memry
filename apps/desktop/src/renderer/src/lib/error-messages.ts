import type { SyncErrorCategory } from '@memry/contracts/ipc-sync-ops'
import { enErrors } from '@memry/i18n/locales/en-errors'
import { getI18n } from 'react-i18next'

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

const ERROR_MESSAGE_KEYS: Record<string, string> = {
  [ERROR_CODES.VAULT_NOT_FOUND]: 'vault.notFound',
  [ERROR_CODES.VAULT_NOT_INITIALIZED]: 'vault.notInitialized',
  [ERROR_CODES.VAULT_INVALID_PATH]: 'vault.invalidPath',
  [ERROR_CODES.VAULT_PERMISSION_DENIED]: 'vault.permissionDenied',
  [ERROR_CODES.VAULT_ALREADY_EXISTS]: 'vault.alreadyExists',
  [ERROR_CODES.VAULT_CORRUPTED]: 'vault.corrupted',

  [ERROR_CODES.NOTE_NOT_FOUND]: 'note.notFound',
  [ERROR_CODES.NOTE_INVALID_FRONTMATTER]: 'note.invalidFrontmatter',
  [ERROR_CODES.NOTE_DUPLICATE_ID]: 'note.duplicateId',
  [ERROR_CODES.NOTE_WRITE_FAILED]: 'note.writeFailed',
  [ERROR_CODES.NOTE_READ_FAILED]: 'note.readFailed',
  [ERROR_CODES.NOTE_DELETE_FAILED]: 'note.deleteFailed',
  [ERROR_CODES.NOTE_INVALID_PATH]: 'note.invalidPath',

  [ERROR_CODES.DB_CONNECTION_FAILED]: 'database.connectionFailed',
  [ERROR_CODES.DB_MIGRATION_FAILED]: 'database.migrationFailed',
  [ERROR_CODES.DB_QUERY_FAILED]: 'database.queryFailed',
  [ERROR_CODES.DB_NOT_INITIALIZED]: 'database.notInitialized',
  [ERROR_CODES.DB_CONSTRAINT_VIOLATION]: 'database.constraintViolation',
  [ERROR_CODES.DB_CORRUPTED]: 'database.corrupted',

  [ERROR_CODES.WATCHER_START_FAILED]: 'watcher.startFailed',
  [ERROR_CODES.WATCHER_STOP_FAILED]: 'watcher.stopFailed',
  [ERROR_CODES.WATCHER_EVENT_ERROR]: 'watcher.eventError',

  [ERROR_CODES.ATTACHMENT_FILE_TOO_LARGE]: 'attachment.fileTooLarge',
  [ERROR_CODES.ATTACHMENT_UNSUPPORTED_TYPE]: 'attachment.unsupportedType',
  [ERROR_CODES.ATTACHMENT_WRITE_FAILED]: 'attachment.writeFailed',
  [ERROR_CODES.ATTACHMENT_DELETE_FAILED]: 'attachment.deleteFailed',

  [ERROR_CODES.ENCRYPTION_FAILED]: 'encryption.failed',
  [ERROR_CODES.DECRYPTION_FAILED]: 'encryption.decryptionFailed',
  [ERROR_CODES.INVALID_KEY_LENGTH]: 'encryption.invalidKeyLength',
  [ERROR_CODES.INVALID_NONCE_LENGTH]: 'encryption.invalidNonceLength',

  [ERROR_CODES.INBOX_ATTACHMENT_WRITE_FAILED]: 'inboxAttachment.writeFailed',
  [ERROR_CODES.INBOX_ATTACHMENT_DELETE_FAILED]: 'inboxAttachment.deleteFailed'
}

const SYNC_ERROR_KEYS: Record<SyncErrorCategory, string> = {
  network_offline: 'sync.networkOffline',
  network_timeout: 'sync.networkTimeout',
  server_error: 'sync.serverError',
  auth_expired: 'sync.authExpired',
  device_revoked: 'sync.deviceRevoked',
  rate_limited: 'sync.rateLimited',
  crypto_failure: 'sync.cryptoFailure',
  version_incompatible: 'sync.versionIncompatible',
  storage_quota_exceeded: 'sync.storageQuotaExceeded',
  file_too_large: 'sync.fileTooLarge',
  note_too_large: 'sync.noteTooLarge',
  sync_payment_required: 'sync.paymentRequired',
  certificate_pin_failed: 'sync.certificatePinFailed',
  unknown: 'sync.unknown'
}

function getEnglishErrorResource(key: string): string | undefined {
  let current: unknown = enErrors
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' ? current : undefined
}

function resolveErrorKey(key: string): string {
  const namespacedKey = `errors:${key}`
  const translated = getI18n()?.t(namespacedKey)
  if (typeof translated === 'string' && translated !== namespacedKey) return translated
  return getEnglishErrorResource(key) ?? namespacedKey
}

export function getUserErrorMessage(code: string, fallback?: string): string {
  const key = ERROR_MESSAGE_KEYS[code] ?? SYNC_ERROR_KEYS[code as SyncErrorCategory]
  if (key) return resolveErrorKey(key)
  return fallback ?? resolveErrorKey('generic.somethingWentWrong')
}

export function getSyncErrorMessage(category: SyncErrorCategory): string {
  return resolveErrorKey(SYNC_ERROR_KEYS[category] ?? 'sync.unknown')
}
