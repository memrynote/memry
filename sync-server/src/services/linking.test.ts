import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'
import {
  createLinkingSession,
  getSession,
  requireSession,
  transitionToScanned,
  transitionToApproved,
  transitionToCompleted,
  type LinkingSessionRow
} from './linking'

// ============================================================================
// D1 mock helpers
// ============================================================================

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
}

const createMockStatement = (overrides?: Partial<MockStatement>): MockStatement => {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    ...overrides
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

const createMockDb = () => ({
  prepare: vi.fn().mockReturnValue(createMockStatement()),
  batch: vi.fn().mockResolvedValue([])
})

const futureExpiry = Math.floor(Date.now() / 1000) + 300
const pastExpiry = Math.floor(Date.now() / 1000) - 10

const makeSession = (overrides: Partial<LinkingSessionRow> = {}): LinkingSessionRow => ({
  id: 'session-1',
  user_id: 'user-1',
  initiator_device_id: 'dev-1',
  ephemeral_public_key: 'eph-pk',
  new_device_public_key: null,
  new_device_confirm: null,
  encrypted_master_key: null,
  encrypted_key_nonce: null,
  key_confirm: null,
  status: 'pending',
  expires_at: futureExpiry,
  created_at: futureExpiry - 300,
  completed_at: null,
  ...overrides
})

// ============================================================================
// Tests: getSession
// ============================================================================

describe('getSession', () => {
  it('should return session row when found', async () => {
    // #given
    const session = makeSession()
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(session)
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getSession(db as unknown as D1Database, 'session-1')

    // #then
    expect(result).toEqual(session)
    expect(stmt.bind).toHaveBeenCalledWith('session-1')
  })

  it('should return null when session not found', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(null)
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getSession(db as unknown as D1Database, 'nonexistent')

    // #then
    expect(result).toBeNull()
  })
})

// ============================================================================
// Tests: requireSession
// ============================================================================

describe('requireSession', () => {
  it('should throw LINKING_SESSION_NOT_FOUND when session does not exist', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(null)
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(requireSession(db as unknown as D1Database, 'missing')).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_SESSION_NOT_FOUND,
        statusCode: 404
      })
    )
  })
})

// ============================================================================
// Tests: transitionToScanned
// ============================================================================

describe('transitionToScanned', () => {
  it('should transition pending → scanned and return userId + initiatorDeviceId', async () => {
    // #given
    const session = makeSession({ status: 'pending' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 1 } })

    const db = createMockDb()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(updateStmt)

    // #when
    const result = await transitionToScanned(
      db as unknown as D1Database,
      'session-1',
      'new-pk',
      'new-confirm'
    )

    // #then
    expect(result).toEqual({ userId: 'user-1', initiatorDeviceId: 'dev-1' })
    expect(updateStmt.bind).toHaveBeenCalledWith('new-pk', 'new-confirm', 'session-1')
  })

  it('should throw LINKING_CONCURRENT_ATTEMPT when session already scanned', async () => {
    // #given — requireSession returns pending (stale read), UPDATE fails, re-read shows scanned
    const session = makeSession({ status: 'pending' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(makeSession({ status: 'scanned' }))

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(
      transitionToScanned(db as unknown as D1Database, 'session-1', 'new-pk', 'confirm')
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_CONCURRENT_ATTEMPT,
        statusCode: 409
      })
    )
  })

  it('should throw LINKING_INVALID_TRANSITION when session in wrong state', async () => {
    // #given — session moved to 'approved' (not 'scanned')
    const session = makeSession({ status: 'pending' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(makeSession({ status: 'approved' }))

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(
      transitionToScanned(db as unknown as D1Database, 'session-1', 'new-pk', 'confirm')
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_INVALID_TRANSITION,
        statusCode: 409
      })
    )
  })

  it('should throw LINKING_SESSION_EXPIRED when session expired', async () => {
    // #given
    const session = makeSession({ status: 'pending', expires_at: pastExpiry })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const db = createMockDb()
    db.prepare.mockReturnValue(selectStmt)

    // #when / #then
    await expect(
      transitionToScanned(db as unknown as D1Database, 'session-1', 'new-pk', 'confirm')
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_SESSION_EXPIRED,
        statusCode: 410
      })
    )
  })

  it('should throw LINKING_SESSION_NOT_FOUND when session deleted between CAS and re-read', async () => {
    // #given — CAS fails, re-read returns null (session cleaned up)
    const session = makeSession({ status: 'pending' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(null)

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(
      transitionToScanned(db as unknown as D1Database, 'session-1', 'new-pk', 'confirm')
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_SESSION_NOT_FOUND,
        statusCode: 404
      })
    )
  })
})

// ============================================================================
// Tests: transitionToApproved
// ============================================================================

describe('transitionToApproved', () => {
  it('should transition scanned → approved', async () => {
    // #given
    const session = makeSession({ status: 'scanned' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 1 } })

    const db = createMockDb()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(updateStmt)

    // #when / #then
    await expect(
      transitionToApproved(
        db as unknown as D1Database,
        'session-1',
        'user-1',
        'enc-key',
        'enc-nonce',
        'kc'
      )
    ).resolves.toBeUndefined()
  })

  it('should throw LINKING_CONCURRENT_ATTEMPT when session already approved', async () => {
    // #given
    const session = makeSession({ status: 'scanned' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(makeSession({ status: 'approved' }))

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(
      transitionToApproved(
        db as unknown as D1Database,
        'session-1',
        'user-1',
        'enc-key',
        'enc-nonce',
        'kc'
      )
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_CONCURRENT_ATTEMPT,
        statusCode: 409
      })
    )
  })

  it('should throw LINKING_INVALID_TRANSITION when wrong user', async () => {
    // #given — throws before UPDATE, so only 1 prepare call needed
    const session = makeSession({ status: 'scanned', user_id: 'user-1' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const db = createMockDb()
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when / #then
    await expect(
      transitionToApproved(
        db as unknown as D1Database,
        'session-1',
        'wrong-user',
        'enc-key',
        'enc-nonce',
        'kc'
      )
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_INVALID_TRANSITION,
        message: 'Not authorized to approve this session',
        statusCode: 409
      })
    )
  })

  it('should throw LINKING_INVALID_TRANSITION when session in wrong state', async () => {
    // #given — CAS fails, re-read shows 'completed' (not 'approved')
    const session = makeSession({ status: 'scanned' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(makeSession({ status: 'completed' }))

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(
      transitionToApproved(
        db as unknown as D1Database,
        'session-1',
        'user-1',
        'enc-key',
        'enc-nonce',
        'kc'
      )
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_INVALID_TRANSITION,
        statusCode: 409
      })
    )
  })

  it('should throw LINKING_SESSION_NOT_FOUND when session deleted between CAS and re-read', async () => {
    // #given
    const session = makeSession({ status: 'scanned' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(null)

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(
      transitionToApproved(
        db as unknown as D1Database,
        'session-1',
        'user-1',
        'enc-key',
        'enc-nonce',
        'kc'
      )
    ).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_SESSION_NOT_FOUND,
        statusCode: 404
      })
    )
  })
})

// ============================================================================
// Tests: transitionToCompleted
// ============================================================================

describe('transitionToCompleted', () => {
  it('should transition approved → completed and return encrypted key data', async () => {
    // #given
    const session = makeSession({
      status: 'approved',
      encrypted_master_key: 'enc-mk',
      encrypted_key_nonce: 'enc-n',
      key_confirm: 'kc'
    })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 1 } })

    const db = createMockDb()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(updateStmt)

    // #when
    const result = await transitionToCompleted(db as unknown as D1Database, 'session-1')

    // #then
    expect(result).toEqual({
      encryptedMasterKey: 'enc-mk',
      encryptedKeyNonce: 'enc-n',
      keyConfirm: 'kc'
    })
  })

  it('should throw LINKING_CONCURRENT_ATTEMPT when session already completed', async () => {
    // #given
    const session = makeSession({ status: 'approved' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(makeSession({ status: 'completed' }))

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(transitionToCompleted(db as unknown as D1Database, 'session-1')).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_CONCURRENT_ATTEMPT,
        statusCode: 409
      })
    )
  })

  it('should throw LINKING_INVALID_TRANSITION when session in wrong state', async () => {
    // #given — CAS fails, re-read shows 'pending' (not 'completed')
    const session = makeSession({ status: 'approved' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(makeSession({ status: 'pending' }))

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(transitionToCompleted(db as unknown as D1Database, 'session-1')).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_INVALID_TRANSITION,
        statusCode: 409
      })
    )
  })

  it('should throw LINKING_SESSION_NOT_FOUND when session deleted between CAS and re-read', async () => {
    // #given
    const session = makeSession({ status: 'approved' })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(session)
    const updateStmt = createMockStatement()
    updateStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const rereadStmt = createMockStatement()
    rereadStmt.first.mockResolvedValue(null)

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(updateStmt)
      .mockReturnValueOnce(rereadStmt)

    // #when / #then
    await expect(transitionToCompleted(db as unknown as D1Database, 'session-1')).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCodes.LINKING_SESSION_NOT_FOUND,
        statusCode: 404
      })
    )
  })
})

// ============================================================================
// Tests: createLinkingSession
// ============================================================================

describe('createLinkingSession', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'new-session-id' as `${string}-${string}-${string}-${string}-${string}`
    )
  })

  it('should call db.batch with cancel + insert statements', async () => {
    // #given
    const cancelStmt = createMockStatement()
    const insertStmt = createMockStatement()
    const db = createMockDb()
    db.prepare.mockReturnValueOnce(cancelStmt).mockReturnValueOnce(insertStmt)

    // #when
    const result = await createLinkingSession(
      db as unknown as D1Database,
      'user-1',
      'dev-1',
      'eph-pk'
    )

    // #then
    expect(result.sessionId).toBe('new-session-id')
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(db.batch).toHaveBeenCalledWith([cancelStmt, insertStmt])
    expect(db.prepare).toHaveBeenCalledTimes(2)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("SET status = 'cancelled'"))
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO linking_sessions'))
  })

  it('should work when no existing sessions need cancelling (cancel is no-op)', async () => {
    // #given — batch succeeds regardless; cancel UPDATE affects 0 rows
    const cancelStmt = createMockStatement()
    const insertStmt = createMockStatement()
    const db = createMockDb()
    db.prepare.mockReturnValueOnce(cancelStmt).mockReturnValueOnce(insertStmt)
    db.batch.mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 1 } }])

    // #when
    const result = await createLinkingSession(
      db as unknown as D1Database,
      'user-1',
      'dev-1',
      'eph-pk'
    )

    // #then
    expect(result.sessionId).toBe('new-session-id')
    expect(db.batch).toHaveBeenCalledTimes(1)
  })
})
