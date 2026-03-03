import { AppError, ErrorCodes } from '../lib/errors'

export interface User {
  id: string
  email: string
  email_verified: number
  auth_method: string
  auth_provider: string | null
  auth_provider_id: string | null
  kdf_salt: string | null
  key_verifier: string | null
  storage_used: number
  storage_limit: number
  created_at: number
  updated_at: number
}

export const createUser = async (
  db: D1Database,
  params: {
    email: string
    authMethod: string
    authProvider?: string
    authProviderId?: string
    emailVerified?: number
  }
): Promise<User> => {
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, auth_provider, auth_provider_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      params.email,
      params.emailVerified ?? 0,
      params.authMethod,
      params.authProvider ?? null,
      params.authProviderId ?? null,
      now,
      now
    )
    .run()

  return {
    id,
    email: params.email,
    email_verified: params.emailVerified ?? 0,
    auth_method: params.authMethod,
    auth_provider: params.authProvider ?? null,
    auth_provider_id: params.authProviderId ?? null,
    kdf_salt: null,
    key_verifier: null,
    storage_used: 0,
    storage_limit: 5368709120,
    created_at: now,
    updated_at: now
  }
}

export const getUserByEmail = async (db: D1Database, email: string): Promise<User | null> => {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>()
}

export const getUserById = async (db: D1Database, userId: string): Promise<User | null> => {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<User>()
}

export const updateUser = async (
  db: D1Database,
  userId: string,
  updates: Partial<Pick<User, 'email_verified' | 'kdf_salt' | 'key_verifier'>>
): Promise<void> => {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.email_verified !== undefined) {
    setClauses.push('email_verified = ?')
    values.push(updates.email_verified)
  }
  if (updates.kdf_salt !== undefined) {
    setClauses.push('kdf_salt = ?')
    values.push(updates.kdf_salt)
  }
  if (updates.key_verifier !== undefined) {
    setClauses.push('key_verifier = ?')
    values.push(updates.key_verifier)
  }

  if (setClauses.length === 0) return

  setClauses.push('updated_at = ?')
  values.push(Math.floor(Date.now() / 1000))
  values.push(userId)

  await db
    .prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()
}

export const linkIdentity = async (
  db: D1Database,
  userId: string,
  provider: string,
  providerId: string
): Promise<void> => {
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await db
    .prepare(
      `INSERT INTO user_identities (id, user_id, provider, provider_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider, provider_id) DO NOTHING`
    )
    .bind(id, userId, provider, providerId, now)
    .run()
}

export const findUserByIdentity = async (
  db: D1Database,
  provider: string,
  providerId: string
): Promise<User | null> => {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN user_identities ui ON u.id = ui.user_id
       WHERE ui.provider = ? AND ui.provider_id = ?`
    )
    .bind(provider, providerId)
    .first<User>()
}

export const getOrCreateUserByEmail = async (
  db: D1Database,
  email: string,
  params: { authMethod: string; authProvider?: string; authProviderId?: string }
): Promise<{ user: User; isNewUser: boolean }> => {
  const existing = await getUserByEmail(db, email)

  if (existing) {
    if (params.authProvider && params.authProviderId) {
      await linkIdentity(db, existing.id, params.authProvider, params.authProviderId)
    }
    return { user: existing, isNewUser: false }
  }

  const user = await createUser(db, {
    email,
    authMethod: params.authMethod,
    authProvider: params.authProvider,
    authProviderId: params.authProviderId,
    emailVerified: params.authProvider ? 1 : 0
  })

  if (params.authProvider && params.authProviderId) {
    await linkIdentity(db, user.id, params.authProvider, params.authProviderId)
  }

  return { user, isNewUser: true }
}
