import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  createUser,
  getUserByEmail,
  getUserById,
  updateUser,
  linkIdentity,
  findUserByIdentity,
  getOrCreateUserByEmail
} from './user'

// ============================================================================
// D1 mock
// ============================================================================

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  all: ReturnType<typeof vi.fn>
}

const createMockStatement = (): MockStatement => {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue({ results: [] })
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

const createMockDb = () => ({
  prepare: vi.fn().mockReturnValue(createMockStatement())
})

// ============================================================================
// Tests: createUser
// ============================================================================

describe('createUser', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
  })

  it('should insert a row into the users table', async () => {
    // #when
    await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'))
  })

  it('should return a User with the provided email and auth method', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(user.email).toBe('alice@example.com')
    expect(user.auth_method).toBe('email')
  })

  it('should generate a UUID for the user id', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('should default email_verified to 0 when not provided', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(user.email_verified).toBe(0)
  })

  it('should use the provided emailVerified value', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'google',
      emailVerified: 1
    })

    // #then
    expect(user.email_verified).toBe(1)
  })

  it('should default auth_provider and auth_provider_id to null', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(user.auth_provider).toBeNull()
    expect(user.auth_provider_id).toBeNull()
  })

  it('should set auth_provider and auth_provider_id when provided', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'google',
      authProvider: 'google',
      authProviderId: 'google-123'
    })

    // #then
    expect(user.auth_provider).toBe('google')
    expect(user.auth_provider_id).toBe('google-123')
  })

  it('should default kdf_salt and key_verifier to null', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(user.kdf_salt).toBeNull()
    expect(user.key_verifier).toBeNull()
  })

  it('should default storage_used to 0 and storage_limit to 5GB', async () => {
    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(user.storage_used).toBe(0)
    expect(user.storage_limit).toBe(5368709120)
  })

  it('should set created_at and updated_at to current unix timestamp', async () => {
    // #given
    const expectedTimestamp = Math.floor(new Date('2026-01-15T00:00:00Z').getTime() / 1000)

    // #when
    const user = await createUser(db as unknown as D1Database, {
      email: 'alice@example.com',
      authMethod: 'email'
    })

    // #then
    expect(user.created_at).toBe(expectedTimestamp)
    expect(user.updated_at).toBe(expectedTimestamp)
  })

  it('should bind all parameters to the prepared statement', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await createUser(db as unknown as D1Database, {
      email: 'bob@example.com',
      authMethod: 'google',
      authProvider: 'google',
      authProviderId: 'g-456',
      emailVerified: 1
    })

    // #then
    const bindArgs = stmt.bind.mock.calls[0]
    expect(bindArgs[1]).toBe('bob@example.com')
    expect(bindArgs[2]).toBe(1)
    expect(bindArgs[3]).toBe('google')
    expect(bindArgs[4]).toBe('google')
    expect(bindArgs[5]).toBe('g-456')
  })
})

// ============================================================================
// Tests: getUserByEmail
// ============================================================================

describe('getUserByEmail', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should query users by email', async () => {
    // #when
    await getUserByEmail(db as unknown as D1Database, 'alice@example.com')

    // #then
    expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM users WHERE email = ?')
  })

  it('should bind the email parameter', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getUserByEmail(db as unknown as D1Database, 'alice@example.com')

    // #then
    expect(stmt.bind).toHaveBeenCalledWith('alice@example.com')
  })

  it('should return the user when found', async () => {
    // #given
    const mockUser = { id: 'u-1', email: 'alice@example.com' }
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(mockUser)
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getUserByEmail(db as unknown as D1Database, 'alice@example.com')

    // #then
    expect(result).toEqual(mockUser)
  })

  it('should return null when user not found', async () => {
    // #when
    const result = await getUserByEmail(db as unknown as D1Database, 'nobody@example.com')

    // #then
    expect(result).toBeNull()
  })
})

// ============================================================================
// Tests: getUserById
// ============================================================================

describe('getUserById', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should query users by id', async () => {
    // #when
    await getUserById(db as unknown as D1Database, 'user-1')

    // #then
    expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?')
  })

  it('should bind the userId parameter', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getUserById(db as unknown as D1Database, 'user-1')

    // #then
    expect(stmt.bind).toHaveBeenCalledWith('user-1')
  })

  it('should return the user when found', async () => {
    // #given
    const mockUser = { id: 'user-1', email: 'alice@example.com' }
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(mockUser)
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getUserById(db as unknown as D1Database, 'user-1')

    // #then
    expect(result).toEqual(mockUser)
  })

  it('should return null when user not found', async () => {
    // #when
    const result = await getUserById(db as unknown as D1Database, 'nonexistent-id')

    // #then
    expect(result).toBeNull()
  })
})

// ============================================================================
// Tests: updateUser
// ============================================================================

describe('updateUser', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
  })

  it('should not call db when updates object is empty', async () => {
    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {})

    // #then
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('should update email_verified field', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      email_verified: 1
    })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('email_verified = ?'))
  })

  it('should update kdf_salt field', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      kdf_salt: 'new-salt'
    })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('kdf_salt = ?'))
  })

  it('should update key_verifier field', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      key_verifier: 'new-verifier'
    })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('key_verifier = ?'))
  })

  it('should update multiple fields at once', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      email_verified: 1,
      kdf_salt: 'salt-abc',
      key_verifier: 'verifier-xyz'
    })

    // #then
    const query = db.prepare.mock.calls[0][0] as string
    expect(query).toContain('email_verified = ?')
    expect(query).toContain('kdf_salt = ?')
    expect(query).toContain('key_verifier = ?')
  })

  it('should always include updated_at in the SET clause', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      email_verified: 1
    })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('updated_at = ?'))
  })

  it('should bind field values followed by timestamp and userId', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)
    const expectedTimestamp = Math.floor(new Date('2026-01-15T00:00:00Z').getTime() / 1000)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      email_verified: 1
    })

    // #then
    expect(stmt.bind).toHaveBeenCalledWith(1, expectedTimestamp, 'user-1')
  })

  it('should bind all three fields in correct order when all provided', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)
    const expectedTimestamp = Math.floor(new Date('2026-01-15T00:00:00Z').getTime() / 1000)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      email_verified: 1,
      kdf_salt: 'salt',
      key_verifier: 'verifier'
    })

    // #then
    expect(stmt.bind).toHaveBeenCalledWith(1, 'salt', 'verifier', expectedTimestamp, 'user-1')
  })

  it('should use WHERE id = ? clause', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await updateUser(db as unknown as D1Database, 'user-1', {
      email_verified: 1
    })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ?'))
  })
})

// ============================================================================
// Tests: linkIdentity
// ============================================================================

describe('linkIdentity', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should insert into user_identities table', async () => {
    // #when
    await linkIdentity(db as unknown as D1Database, 'user-1', 'google', 'google-id-123')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_identities'))
  })

  it('should use ON CONFLICT DO NOTHING for idempotency', async () => {
    // #when
    await linkIdentity(db as unknown as D1Database, 'user-1', 'google', 'google-id-123')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (provider, provider_id) DO NOTHING')
    )
  })

  it('should bind userId, provider, and providerId', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await linkIdentity(db as unknown as D1Database, 'user-1', 'github', 'gh-456')

    // #then
    const bindArgs = stmt.bind.mock.calls[0]
    expect(bindArgs[1]).toBe('user-1')
    expect(bindArgs[2]).toBe('github')
    expect(bindArgs[3]).toBe('gh-456')
  })
})

// ============================================================================
// Tests: findUserByIdentity
// ============================================================================

describe('findUserByIdentity', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should join users with user_identities', async () => {
    // #when
    await findUserByIdentity(db as unknown as D1Database, 'google', 'google-id-123')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('JOIN user_identities'))
  })

  it('should filter by provider and provider_id', async () => {
    // #given
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await findUserByIdentity(db as unknown as D1Database, 'google', 'google-id-123')

    // #then
    expect(stmt.bind).toHaveBeenCalledWith('google', 'google-id-123')
  })

  it('should return the user when identity exists', async () => {
    // #given
    const mockUser = { id: 'u-1', email: 'alice@example.com' }
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(mockUser)
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await findUserByIdentity(db as unknown as D1Database, 'google', 'google-id-123')

    // #then
    expect(result).toEqual(mockUser)
  })

  it('should return null when identity not found', async () => {
    // #when
    const result = await findUserByIdentity(db as unknown as D1Database, 'google', 'nonexistent')

    // #then
    expect(result).toBeNull()
  })
})

// ============================================================================
// Tests: getOrCreateUserByEmail
// ============================================================================

describe('getOrCreateUserByEmail', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
  })

  it('should return existing user with isNewUser=false when email exists', async () => {
    // #given
    const existingUser = {
      id: 'existing-1',
      email: 'alice@example.com',
      email_verified: 1,
      auth_method: 'email',
      auth_provider: null,
      auth_provider_id: null,
      kdf_salt: null,
      key_verifier: null,
      storage_used: 0,
      storage_limit: 5368709120,
      created_at: 1000000,
      updated_at: 1000000
    }
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(existingUser)
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when
    const result = await getOrCreateUserByEmail(db as unknown as D1Database, 'alice@example.com', {
      authMethod: 'email'
    })

    // #then
    expect(result.isNewUser).toBe(false)
    expect(result.user).toEqual(existingUser)
  })

  it('should link identity when existing user logs in via OAuth', async () => {
    // #given
    const existingUser = {
      id: 'existing-1',
      email: 'alice@example.com',
      email_verified: 1,
      auth_method: 'email',
      auth_provider: null,
      auth_provider_id: null,
      kdf_salt: null,
      key_verifier: null,
      storage_used: 0,
      storage_limit: 5368709120,
      created_at: 1000000,
      updated_at: 1000000
    }
    const stmts: MockStatement[] = []
    db.prepare.mockImplementation(() => {
      const s = createMockStatement()
      stmts.push(s)
      return s
    })
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(existingUser)
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when
    await getOrCreateUserByEmail(db as unknown as D1Database, 'alice@example.com', {
      authMethod: 'google',
      authProvider: 'google',
      authProviderId: 'g-123'
    })

    // #then - second prepare call is linkIdentity INSERT
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_identities'))
  })

  it('should not link identity when existing user has no provider info', async () => {
    // #given
    const existingUser = {
      id: 'existing-1',
      email: 'alice@example.com',
      email_verified: 1,
      auth_method: 'email',
      auth_provider: null,
      auth_provider_id: null,
      kdf_salt: null,
      key_verifier: null,
      storage_used: 0,
      storage_limit: 5368709120,
      created_at: 1000000,
      updated_at: 1000000
    }
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(existingUser)
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when
    await getOrCreateUserByEmail(db as unknown as D1Database, 'alice@example.com', {
      authMethod: 'email'
    })

    // #then - only the SELECT was called, no INSERT for identity
    expect(db.prepare).toHaveBeenCalledTimes(1)
  })

  it('should create a new user with isNewUser=true when email does not exist', async () => {
    // #given - first call (getUserByEmail) returns null, second call (createUser INSERT) succeeds
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const insertStmt = createMockStatement()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(insertStmt)

    // #when
    const result = await getOrCreateUserByEmail(db as unknown as D1Database, 'new@example.com', {
      authMethod: 'email'
    })

    // #then
    expect(result.isNewUser).toBe(true)
    expect(result.user.email).toBe('new@example.com')
  })

  it('should set emailVerified=1 for new users with an OAuth provider', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const insertStmt = createMockStatement()
    const linkStmt = createMockStatement()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(insertStmt)
      .mockReturnValueOnce(linkStmt)

    // #when
    const result = await getOrCreateUserByEmail(db as unknown as D1Database, 'new@example.com', {
      authMethod: 'google',
      authProvider: 'google',
      authProviderId: 'g-789'
    })

    // #then
    expect(result.user.email_verified).toBe(1)
  })

  it('should set emailVerified=0 for new users without an OAuth provider', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const insertStmt = createMockStatement()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(insertStmt)

    // #when
    const result = await getOrCreateUserByEmail(db as unknown as D1Database, 'new@example.com', {
      authMethod: 'email'
    })

    // #then
    expect(result.user.email_verified).toBe(0)
  })

  it('should link identity after creating new user with OAuth', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const insertStmt = createMockStatement()
    const linkStmt = createMockStatement()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(insertStmt)
      .mockReturnValueOnce(linkStmt)

    // #when
    await getOrCreateUserByEmail(db as unknown as D1Database, 'new@example.com', {
      authMethod: 'google',
      authProvider: 'google',
      authProviderId: 'g-789'
    })

    // #then - third prepare call is linkIdentity
    expect(db.prepare).toHaveBeenCalledTimes(3)
    expect(db.prepare).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO user_identities')
    )
  })

  it('should not link identity after creating new user without OAuth', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const insertStmt = createMockStatement()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(insertStmt)

    // #when
    await getOrCreateUserByEmail(db as unknown as D1Database, 'new@example.com', {
      authMethod: 'email'
    })

    // #then - only SELECT + INSERT, no linkIdentity
    expect(db.prepare).toHaveBeenCalledTimes(2)
  })

  it('should not link identity when only authProvider is given without authProviderId', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const insertStmt = createMockStatement()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(insertStmt)

    // #when
    await getOrCreateUserByEmail(db as unknown as D1Database, 'new@example.com', {
      authMethod: 'google',
      authProvider: 'google'
    })

    // #then - no linkIdentity because authProviderId is missing
    expect(db.prepare).toHaveBeenCalledTimes(2)
  })
})
