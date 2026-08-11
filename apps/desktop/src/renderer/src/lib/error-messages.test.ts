import { beforeEach, describe, it, expect } from 'vitest'
import { createRendererI18n } from '@memry/i18n/renderer'
import { getUserErrorMessage, getSyncErrorMessage, ERROR_CODES } from './error-messages'

describe('getUserErrorMessage', () => {
  beforeEach(async () => {
    await createRendererI18n({ locale: 'en' })
  })

  it('returns English messages from the errors namespace for representative codes', () => {
    expect(getUserErrorMessage(ERROR_CODES.VAULT_NOT_FOUND)).toBe(
      'Vault not found. It may have been moved or deleted.'
    )
    expect(getUserErrorMessage('network_offline')).toBe(
      'You are offline. Changes will sync when you reconnect.'
    )
  })

  it('returns Turkish namespace resources for Turkish errors', async () => {
    await createRendererI18n({ locale: 'tr' })

    expect(getUserErrorMessage(ERROR_CODES.NOTE_WRITE_FAILED)).toBe(
      'Bu not kaydedilemedi. Disk alanını ve izinlerini kontrol edin.'
    )
  })

  it('returns user-friendly message for known vault error codes', () => {
    expect(getUserErrorMessage(ERROR_CODES.VAULT_NOT_FOUND)).toContain('Vault not found')
    expect(getUserErrorMessage(ERROR_CODES.VAULT_NOT_INITIALIZED)).toContain('No vault is open')
    expect(getUserErrorMessage(ERROR_CODES.VAULT_PERMISSION_DENIED)).toContain('Permission denied')
  })

  it('returns user-friendly message for known note error codes', () => {
    expect(getUserErrorMessage(ERROR_CODES.NOTE_NOT_FOUND)).toContain('could not be found')
    expect(getUserErrorMessage(ERROR_CODES.NOTE_WRITE_FAILED)).toContain('Failed to save')
    expect(getUserErrorMessage(ERROR_CODES.NOTE_READ_FAILED)).toContain('Failed to read')
    expect(getUserErrorMessage(ERROR_CODES.NOTE_DELETE_FAILED)).toContain('Failed to delete')
  })

  it('returns user-friendly message for known crypto error codes', () => {
    expect(getUserErrorMessage(ERROR_CODES.ENCRYPTION_FAILED)).toContain('encrypt')
    expect(getUserErrorMessage(ERROR_CODES.DECRYPTION_FAILED)).toContain('decrypt')
    expect(getUserErrorMessage(ERROR_CODES.INVALID_KEY_LENGTH)).toContain('Invalid encryption key')
  })

  it('returns user-friendly message for known db error codes', () => {
    expect(getUserErrorMessage(ERROR_CODES.DB_CONNECTION_FAILED)).toContain('database')
    expect(getUserErrorMessage(ERROR_CODES.DB_CORRUPTED)).toContain('corrupted')
  })

  it('returns user-friendly message for sync error categories', () => {
    expect(getUserErrorMessage('network_offline')).toContain('offline')
    expect(getUserErrorMessage('auth_expired')).toContain('expired')
    expect(getUserErrorMessage('device_revoked')).toContain('removed')
    expect(getUserErrorMessage('rate_limited')).toContain('Too many requests')
    expect(getUserErrorMessage('storage_quota_exceeded')).toContain('full')
    expect(getUserErrorMessage('sync_payment_required')).toContain('paid Sync plan')
    expect(getUserErrorMessage('certificate_pin_failed')).toContain('connection')
  })

  it('returns provided fallback for unknown error codes', () => {
    expect(getUserErrorMessage('TOTALLY_UNKNOWN_CODE', 'Custom fallback')).toBe('Custom fallback')
  })

  it('returns default fallback when no fallback provided and code unknown', () => {
    expect(getUserErrorMessage('UNKNOWN_CODE')).toBe('Something went wrong. Please try again.')
  })
})

describe('getSyncErrorMessage', () => {
  beforeEach(async () => {
    await createRendererI18n({ locale: 'en' })
  })

  it('returns messages for all sync error categories', () => {
    expect(getSyncErrorMessage('network_offline')).toBeTruthy()
    expect(getSyncErrorMessage('network_timeout')).toBeTruthy()
    expect(getSyncErrorMessage('server_error')).toBeTruthy()
    expect(getSyncErrorMessage('auth_expired')).toBeTruthy()
    expect(getSyncErrorMessage('device_revoked')).toBeTruthy()
    expect(getSyncErrorMessage('rate_limited')).toBeTruthy()
    expect(getSyncErrorMessage('crypto_failure')).toBeTruthy()
    expect(getSyncErrorMessage('version_incompatible')).toBeTruthy()
    expect(getSyncErrorMessage('storage_quota_exceeded')).toBeTruthy()
    expect(getSyncErrorMessage('note_too_large')).toBeTruthy()
    expect(getSyncErrorMessage('sync_payment_required')).toBeTruthy()
    expect(getSyncErrorMessage('certificate_pin_failed')).toBeTruthy()
    expect(getSyncErrorMessage('unknown')).toBeTruthy()
  })

  it('returns sync messages from the errors namespace', () => {
    expect(getSyncErrorMessage('certificate_pin_failed')).toBe(
      'Secure connection failed. Check your network connection.'
    )
  })
})

describe('ERROR_CODES', () => {
  it('has all expected vault error codes', () => {
    expect(ERROR_CODES.VAULT_NOT_FOUND).toBe('VAULT_NOT_FOUND')
    expect(ERROR_CODES.VAULT_NOT_INITIALIZED).toBe('VAULT_NOT_INITIALIZED')
    expect(ERROR_CODES.VAULT_INVALID_PATH).toBe('VAULT_INVALID_PATH')
    expect(ERROR_CODES.VAULT_PERMISSION_DENIED).toBe('VAULT_PERMISSION_DENIED')
    expect(ERROR_CODES.VAULT_ALREADY_EXISTS).toBe('VAULT_ALREADY_EXISTS')
    expect(ERROR_CODES.VAULT_CORRUPTED).toBe('VAULT_CORRUPTED')
  })

  it('has all expected crypto error codes', () => {
    expect(ERROR_CODES.ENCRYPTION_FAILED).toBe('ENCRYPTION_FAILED')
    expect(ERROR_CODES.DECRYPTION_FAILED).toBe('DECRYPTION_FAILED')
    expect(ERROR_CODES.INVALID_KEY_LENGTH).toBe('INVALID_KEY_LENGTH')
    expect(ERROR_CODES.INVALID_NONCE_LENGTH).toBe('INVALID_NONCE_LENGTH')
  })
})
