/**
 * IPC Events Contract Tests
 *
 * ipc-events.ts exports the EVENT_CHANNELS constant plus a family of
 * TypeScript event payload interfaces. Lock the channel map shape here and
 * rely on `satisfies` assertions for compile-time coverage of the payload
 * types (no Zod schemas in this module).
 */

import { describe, it, expect } from 'vitest'

import type {
  AttachmentUploadFailedEvent,
  CertificatePinFailedEvent,
  ClockSkewWarningEvent,
  ConflictDetectedEvent,
  DeviceRenamedEvent,
  DeviceRevokedEvent,
  DownloadProgressEvent,
  InitialSyncPhase,
  InitialSyncProgressEvent,
  ItemCorruptEvent,
  ItemRecoveredEvent,
  ItemSyncedEvent,
  KeyRotationProgressEvent,
  LinkingApprovedEvent,
  LinkingFinalizedEvent,
  LinkingRequestEvent,
  OAuthCallbackEvent,
  OAuthErrorEvent,
  OtpDetectedEvent,
  QuarantinedItemInfo,
  QueueClearedEvent,
  SecurityWarningEvent,
  SessionExpiredEvent,
  SessionExpiredReason,
  SyncPausedEvent,
  SyncResumedEvent,
  SyncStatusChangedEvent,
  UploadProgressEvent
} from './ipc-events'
import { EVENT_CHANNELS } from './ipc-events'

describe('EVENT_CHANNELS', () => {
  it('namespaces every channel under sync:/auth:/crypto:', () => {
    const allowed = /^(sync|auth|crypto):/
    for (const value of Object.values(EVENT_CHANNELS)) {
      expect(allowed.test(value)).toBe(true)
    }
  })

  it('has unique channel values', () => {
    const values = Object.values(EVENT_CHANNELS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('pins expected well-known channels', () => {
    expect(EVENT_CHANNELS.STATUS_CHANGED).toBe('sync:status-changed')
    expect(EVENT_CHANNELS.ITEM_SYNCED).toBe('sync:item-synced')
    expect(EVENT_CHANNELS.CONFLICT_DETECTED).toBe('sync:conflict-detected')
    expect(EVENT_CHANNELS.KEY_ROTATION_PROGRESS).toBe('crypto:key-rotation-progress')
    expect(EVENT_CHANNELS.SESSION_EXPIRED).toBe('auth:session-expired')
    expect(EVENT_CHANNELS.OTP_DETECTED).toBe('auth:otp-detected')
    expect(EVENT_CHANNELS.OAUTH_CALLBACK).toBe('auth:oauth-callback')
    expect(EVENT_CHANNELS.OAUTH_ERROR).toBe('auth:oauth-error')
    expect(EVENT_CHANNELS.CERTIFICATE_PIN_FAILED).toBe('sync:certificate-pin-failed')
  })
})

describe('event payload types (compile-time shape locks)', () => {
  it('SyncStatusChangedEvent accepts full shape', () => {
    const event: SyncStatusChangedEvent = {
      status: 'syncing',
      lastSyncAt: 1,
      pendingCount: 0,
      error: 'x',
      errorCategory: 'network_offline',
      offlineSince: 2
    }
    expect(event.status).toBe('syncing')
  })

  it('ItemSyncedEvent covers push/pull + operation', () => {
    const push: ItemSyncedEvent = { itemId: 'id', type: 'task', operation: 'push' }
    const pull: ItemSyncedEvent = {
      itemId: 'id',
      type: 'task',
      operation: 'pull',
      itemOperation: 'delete'
    }
    expect([push.operation, pull.operation]).toEqual(['push', 'pull'])
  })

  it('ConflictDetectedEvent carries optional clocks', () => {
    const event: ConflictDetectedEvent = {
      itemId: 'id',
      type: 'task',
      localVersion: { title: 'a' },
      remoteVersion: { title: 'b' },
      localClock: { 'd-1': 1 },
      remoteClock: { 'd-2': 1 }
    }
    expect(event.localClock?.['d-1']).toBe(1)
  })

  it('LinkingRequestEvent + LinkingApprovedEvent hold sessionId', () => {
    const req: LinkingRequestEvent = {
      sessionId: 's-1',
      newDeviceName: 'Laptop',
      newDevicePlatform: 'macos'
    }
    const ok: LinkingApprovedEvent = { sessionId: 's-1' }
    expect(req.sessionId).toBe(ok.sessionId)
  })

  it('UploadProgressEvent / DownloadProgressEvent have progress 0..1-style fields', () => {
    const up: UploadProgressEvent = {
      attachmentId: 'a',
      sessionId: 's',
      progress: 0.5,
      status: 'uploading'
    }
    const down: DownloadProgressEvent = {
      attachmentId: 'a',
      progress: 1,
      status: 'complete'
    }
    expect(up.progress + down.progress).toBe(1.5)
  })

  it('InitialSyncProgressEvent locks phase union', () => {
    const phases: InitialSyncPhase[] = [
      'manifest',
      'notes',
      'tasks',
      'attachments',
      'complete'
    ]
    for (const phase of phases) {
      const event: InitialSyncProgressEvent = {
        phase,
        totalItems: 0,
        processedItems: 0
      }
      expect(event.phase).toBe(phase)
    }
  })

  it('QueueClearedEvent / SyncPausedEvent / SyncResumedEvent', () => {
    const cleared: QueueClearedEvent = { itemCount: 3, duration: 100 }
    const paused: SyncPausedEvent = { pendingCount: 2 }
    const resumed: SyncResumedEvent = { pendingCount: 0 }
    expect(cleared.itemCount + paused.pendingCount + resumed.pendingCount).toBe(5)
  })

  it('KeyRotationProgressEvent accepts optional error', () => {
    const event: KeyRotationProgressEvent = {
      phase: 're-encrypting',
      totalItems: 10,
      processedItems: 5,
      error: undefined
    }
    expect(event.phase).toBe('re-encrypting')
  })

  it('SessionExpiredEvent reason union', () => {
    const reasons: SessionExpiredReason[] = [
      'token_expired',
      'device_revoked',
      'server_error'
    ]
    for (const reason of reasons) {
      const event: SessionExpiredEvent = { reason }
      expect(event.reason).toBe(reason)
    }
  })

  it('OtpDetectedEvent + OAuth events', () => {
    const otp: OtpDetectedEvent = { code: '123456' }
    const cb: OAuthCallbackEvent = { code: 'c', state: 's' }
    const err: OAuthErrorEvent = { error: 'denied' }
    expect(otp.code).toBe('123456')
    expect(cb.state).toBe('s')
    expect(err.error).toBe('denied')
  })

  it('ClockSkewWarningEvent carries skew seconds', () => {
    const event: ClockSkewWarningEvent = {
      localTime: 1000,
      serverTime: 1060,
      skewSeconds: 60
    }
    expect(event.skewSeconds).toBe(60)
  })

  it('AttachmentUploadFailedEvent carries noteId + diskPath', () => {
    const event: AttachmentUploadFailedEvent = {
      noteId: 'n',
      diskPath: '/tmp/x',
      error: 'disk full'
    }
    expect(event.noteId).toBe('n')
  })

  it('DeviceRevokedEvent / DeviceRenamedEvent', () => {
    const revoked: DeviceRevokedEvent = { unsyncedCount: 3 }
    const renamed: DeviceRenamedEvent = { deviceId: 'd', name: 'Phone' }
    expect(revoked.unsyncedCount).toBe(3)
    expect(renamed.name).toBe('Phone')
  })

  it('LinkingFinalizedEvent allows either deviceId or error', () => {
    const ok: LinkingFinalizedEvent = { deviceId: 'd' }
    const bad: LinkingFinalizedEvent = { error: 'mismatch' }
    expect(ok.deviceId).toBe('d')
    expect(bad.error).toBe('mismatch')
  })

  it('ItemRecoveredEvent / ItemCorruptEvent', () => {
    const rec: ItemRecoveredEvent = { itemId: 'i', type: 'note' }
    const corrupt: ItemCorruptEvent = { itemId: 'i', type: 'note', error: 'bad sig' }
    expect(rec.type).toBe(corrupt.type)
  })

  it('SecurityWarningEvent locks signature_verification_failed literal', () => {
    const event: SecurityWarningEvent = {
      itemId: 'i',
      itemType: 'note',
      signerDeviceId: 'd',
      reason: 'signature_verification_failed',
      attemptCount: 2,
      permanent: false
    }
    expect(event.reason).toBe('signature_verification_failed')
  })

  it('QuarantinedItemInfo carries attempt metadata', () => {
    const info: QuarantinedItemInfo = {
      itemId: 'i',
      itemType: 'note',
      signerDeviceId: 'd',
      failedAt: 100,
      attemptCount: 3,
      lastError: 'boom',
      permanent: true
    }
    expect(info.permanent).toBe(true)
  })

  it('CertificatePinFailedEvent captures pin comparison', () => {
    const event: CertificatePinFailedEvent = {
      hostname: 'api.memry.app',
      actualHash: 'sha256/a',
      expectedHashes: ['sha256/b', 'sha256/c']
    }
    expect(event.expectedHashes.length).toBe(2)
  })
})
