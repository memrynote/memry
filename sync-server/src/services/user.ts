/**
 * User Service
 *
 * Handles CRUD operations for user accounts in D1 database.
 * Used by auth routes for signup, login, and account management.
 *
 * @module services/user
 */

import type { Env } from '../index'
import { NotFoundError, ConflictError, ValidationError } from '../lib/errors'

// =============================================================================
// Types
// =============================================================================

/**
 * User record from D1 database
 */
export interface User {
  id: string
  email: string
  email_verified: number
  auth_method: 'email' | 'oauth'
  auth_provider: string | null
  auth_provider_id: string | null
  password_hash: string | null
  password_salt: string | null
  kdf_salt: string
  key_verifier: string
  email_verification_token: string | null
  email_verification_expires: number | null
  password_reset_token: string | null
  password_reset_expires: number | null
  storage_used: number
  storage_limit: number
  created_at: number
  updated_at: number
}

/**
 * Public user data (safe to return to client)
 */
export interface UserPublic {
  id: string
  email: string
  emailVerified: boolean
  authMethod: 'email' | 'oauth'
  authProvider?: 'google'
  storageUsed: number
  storageLimit: number
  createdAt: Date
}

/**
 * Create user input
 */
export interface CreateUserInput {
  email: string
  authMethod: 'email' | 'oauth'
  authProvider?: 'google'
  authProviderId?: string
  passwordHash?: string
  passwordSalt?: string
  emailVerificationToken?: string
  emailVerificationExpires?: number
}

/**
 * Update user input
 */
export interface UpdateUserInput {
  emailVerified?: boolean
  emailVerificationToken?: string | null
  emailVerificationExpires?: number | null
  passwordHash?: string
  passwordSalt?: string
  passwordResetToken?: string | null
  passwordResetExpires?: number | null
  kdfSalt?: string
  keyVerifier?: string
  storageUsed?: number
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate a unique ID for users
 */
function generateId(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Convert database user to public user
 */
export function toPublicUser(user: User): UserPublic {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.email_verified === 1,
    authMethod: user.auth_method,
    authProvider: user.auth_provider as 'google' | undefined,
    storageUsed: user.storage_used,
    storageLimit: user.storage_limit,
    createdAt: new Date(user.created_at)
  }
}

// =============================================================================
// User Service Functions
// =============================================================================

/**
 * Create a new user.
 *
 * @param db - D1 database instance
 * @param input - User creation data
 * @returns Created user
 * @throws ConflictError if email already exists
 */
export async function createUser(db: D1Database, input: CreateUserInput): Promise<User> {
  const now = Date.now()
  const id = generateId()

  // For new users, we need placeholder values for kdf_salt and key_verifier
  // These will be set during first device setup
  const placeholderSalt = crypto.getRandomValues(new Uint8Array(16))
  const placeholderSaltBase64 = btoa(String.fromCharCode(...placeholderSalt))
  const placeholderVerifier = crypto.getRandomValues(new Uint8Array(32))
  const placeholderVerifierBase64 = btoa(String.fromCharCode(...placeholderVerifier))

  try {
    await db
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, auth_method, auth_provider, auth_provider_id,
          password_hash, password_salt, kdf_salt, key_verifier,
          email_verification_token, email_verification_expires,
          storage_used, storage_limit, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.email.toLowerCase(),
        input.authMethod === 'oauth' ? 1 : 0, // OAuth users are pre-verified
        input.authMethod,
        input.authProvider || null,
        input.authProviderId || null,
        input.passwordHash || null,
        input.passwordSalt || null,
        placeholderSaltBase64,
        placeholderVerifierBase64,
        input.emailVerificationToken || null,
        input.emailVerificationExpires || null,
        0, // storage_used
        5368709120, // storage_limit (5GB)
        now,
        now
      )
      .run()

    // Return the created user
    return (await getUserById(db, id))!
  } catch (error) {
    // Check for unique constraint violation
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      throw new ConflictError('Email already registered')
    }
    throw error
  }
}

/**
 * Get user by ID.
 *
 * @param db - D1 database instance
 * @param id - User ID
 * @returns User or null if not found
 */
export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const result = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>()
  return result || null
}

/**
 * Get user by email.
 *
 * @param db - D1 database instance
 * @param email - User email
 * @returns User or null if not found
 */
export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const result = await db
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<User>()
  return result || null
}

/**
 * Get user by OAuth provider ID.
 *
 * @param db - D1 database instance
 * @param provider - OAuth provider
 * @param providerId - Provider's user ID
 * @returns User or null if not found
 */
export async function getUserByOAuthProvider(
  db: D1Database,
  provider: string,
  providerId: string
): Promise<User | null> {
  const result = await db
    .prepare('SELECT * FROM users WHERE auth_provider = ? AND auth_provider_id = ?')
    .bind(provider, providerId)
    .first<User>()
  return result || null
}

/**
 * Get user by verification token.
 *
 * @param db - D1 database instance
 * @param token - Email verification token
 * @returns User or null if not found
 */
export async function getUserByVerificationToken(
  db: D1Database,
  token: string
): Promise<User | null> {
  const result = await db
    .prepare('SELECT * FROM users WHERE email_verification_token = ?')
    .bind(token)
    .first<User>()
  return result || null
}

/**
 * Get user by password reset token.
 *
 * @param db - D1 database instance
 * @param token - Password reset token
 * @returns User or null if not found
 */
export async function getUserByResetToken(db: D1Database, token: string): Promise<User | null> {
  const result = await db
    .prepare('SELECT * FROM users WHERE password_reset_token = ?')
    .bind(token)
    .first<User>()
  return result || null
}

/**
 * Update user fields.
 *
 * @param db - D1 database instance
 * @param id - User ID
 * @param updates - Fields to update
 * @returns Updated user
 * @throws NotFoundError if user not found
 */
export async function updateUser(
  db: D1Database,
  id: string,
  updates: UpdateUserInput
): Promise<User> {
  const now = Date.now()

  // Build dynamic update query
  const fields: string[] = ['updated_at = ?']
  const values: (string | number | null)[] = [now]

  if (updates.emailVerified !== undefined) {
    fields.push('email_verified = ?')
    values.push(updates.emailVerified ? 1 : 0)
  }

  if (updates.emailVerificationToken !== undefined) {
    fields.push('email_verification_token = ?')
    values.push(updates.emailVerificationToken)
  }

  if (updates.emailVerificationExpires !== undefined) {
    fields.push('email_verification_expires = ?')
    values.push(updates.emailVerificationExpires)
  }

  if (updates.passwordHash !== undefined) {
    fields.push('password_hash = ?')
    values.push(updates.passwordHash)
  }

  if (updates.passwordSalt !== undefined) {
    fields.push('password_salt = ?')
    values.push(updates.passwordSalt)
  }

  if (updates.passwordResetToken !== undefined) {
    fields.push('password_reset_token = ?')
    values.push(updates.passwordResetToken)
  }

  if (updates.passwordResetExpires !== undefined) {
    fields.push('password_reset_expires = ?')
    values.push(updates.passwordResetExpires)
  }

  if (updates.kdfSalt !== undefined) {
    fields.push('kdf_salt = ?')
    values.push(updates.kdfSalt)
  }

  if (updates.keyVerifier !== undefined) {
    fields.push('key_verifier = ?')
    values.push(updates.keyVerifier)
  }

  if (updates.storageUsed !== undefined) {
    fields.push('storage_used = ?')
    values.push(updates.storageUsed)
  }

  values.push(id)

  const result = await db
    .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  if (result.meta.changes === 0) {
    throw new NotFoundError('User')
  }

  return (await getUserById(db, id))!
}

/**
 * Set KDF salt and key verifier for first device setup.
 *
 * @param db - D1 database instance
 * @param userId - User ID
 * @param kdfSalt - KDF salt (Base64)
 * @param keyVerifier - Key verifier (Base64)
 * @returns Updated user
 */
export async function setKdfSaltAndVerifier(
  db: D1Database,
  userId: string,
  kdfSalt: string,
  keyVerifier: string
): Promise<User> {
  // Validate Base64 format
  try {
    const saltBytes = atob(kdfSalt)
    if (saltBytes.length < 16) {
      throw new ValidationError('KDF salt must be at least 16 bytes')
    }
  } catch {
    throw new ValidationError('Invalid KDF salt format (must be valid Base64)')
  }

  try {
    const verifierBytes = atob(keyVerifier)
    if (verifierBytes.length !== 32) {
      throw new ValidationError('Key verifier must be exactly 32 bytes')
    }
  } catch {
    throw new ValidationError('Invalid key verifier format (must be valid Base64)')
  }

  return updateUser(db, userId, { kdfSalt, keyVerifier })
}

/**
 * Delete user and all associated data.
 *
 * @param db - D1 database instance
 * @param id - User ID
 * @returns True if deleted
 */
export async function deleteUser(db: D1Database, id: string): Promise<boolean> {
  // CASCADE delete will handle devices, linking_sessions, sync_items
  const result = await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
  return result.meta.changes > 0
}
