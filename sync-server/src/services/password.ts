/**
 * Password Service
 *
 * Handles password validation and Argon2id hashing for email authentication.
 * Uses argon2-wasm-edge for Cloudflare Workers compatibility.
 *
 * @module services/password
 */

import { argon2id } from 'argon2-wasm-edge'
import { ValidationError } from '../lib/errors'

// =============================================================================
// Configuration
// =============================================================================

/**
 * Password validation requirements
 */
const PASSWORD_REQUIREMENTS = {
  /** Minimum password length */
  minLength: 12,
  /** Require uppercase letter */
  requireUppercase: true,
  /** Require lowercase letter */
  requireLowercase: true,
  /** Require number */
  requireNumber: true,
  /** Require special character */
  requireSpecial: true,
}

/**
 * Argon2id parameters (matching client-side settings)
 * - Memory: 64 MiB (65536 KiB)
 * - Iterations: 3
 * - Parallelism: 4
 * - Output length: 32 bytes
 */
const ARGON2_PARAMS = {
  memorySize: 65536, // 64 MiB in KiB
  iterations: 3,
  parallelism: 4,
  hashLength: 32,
}

/** Salt length in bytes */
const SALT_LENGTH = 16

// =============================================================================
// Password Validation
// =============================================================================

/**
 * Password validation result
 */
export interface PasswordValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate password strength.
 *
 * Requirements:
 * - Minimum 12 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 *
 * @param password - Password to validate
 * @returns Validation result with any errors
 */
export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = []

  if (password.length < PASSWORD_REQUIREMENTS.minLength) {
    errors.push(`Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters`)
  }

  if (PASSWORD_REQUIREMENTS.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }

  if (PASSWORD_REQUIREMENTS.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }

  if (PASSWORD_REQUIREMENTS.requireNumber && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
  }

  if (PASSWORD_REQUIREMENTS.requireSpecial && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    errors.push('Password must contain at least one special character')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validate password and throw if invalid.
 *
 * @param password - Password to validate
 * @throws ValidationError if password doesn't meet requirements
 */
export function assertValidPassword(password: string): void {
  const result = validatePasswordStrength(password)
  if (!result.valid) {
    throw new ValidationError('Password does not meet requirements', {
      password: result.errors,
    })
  }
}

// =============================================================================
// Password Hashing
// =============================================================================

/**
 * Generate a cryptographic salt for password hashing.
 *
 * @returns Base64-encoded salt
 */
export function generatePasswordSalt(): string {
  const salt = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(salt)
  return btoa(String.fromCharCode(...salt))
}

/**
 * Fallback hash for local development when WASM is unavailable.
 * Uses PBKDF2 with SHA-256 (less secure than Argon2, but works locally).
 */
async function fallbackHash(password: string, saltBytes: Uint8Array): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  )
  return new Uint8Array(bits)
}

/**
 * Hash a password using Argon2id.
 *
 * Uses the following parameters:
 * - Memory: 64 MiB
 * - Iterations: 3
 * - Parallelism: 4
 * - Output: 32 bytes
 *
 * Falls back to PBKDF2 for local development where WASM is unavailable.
 *
 * @param password - Password to hash
 * @param salt - Base64-encoded salt (or null to generate new salt)
 * @returns Object with hash and salt (both Base64-encoded)
 */
export async function hashPassword(
  password: string,
  salt?: string
): Promise<{ hash: string; salt: string }> {
  // Generate salt if not provided
  const saltBase64 = salt || generatePasswordSalt()

  // Convert salt from Base64 to Uint8Array
  const saltBytes = Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0))

  // Convert password to Uint8Array
  const passwordBytes = new TextEncoder().encode(password)

  let hashBytes: Uint8Array

  try {
    // Try Argon2id first (works on Cloudflare Workers)
    hashBytes = await argon2id({
      password: passwordBytes,
      salt: saltBytes,
      memorySize: ARGON2_PARAMS.memorySize,
      iterations: ARGON2_PARAMS.iterations,
      parallelism: ARGON2_PARAMS.parallelism,
      hashLength: ARGON2_PARAMS.hashLength,
      outputType: 'binary',
    })
  } catch (error) {
    // Fallback to PBKDF2 for local development
    console.warn('Argon2 unavailable, using PBKDF2 fallback (local dev only)')
    hashBytes = await fallbackHash(password, saltBytes)
  }

  // Convert hash to Base64
  const hashBase64 = btoa(String.fromCharCode(...hashBytes))

  return {
    hash: hashBase64,
    salt: saltBase64,
  }
}

/**
 * Verify a password against a stored hash.
 *
 * @param password - Password to verify
 * @param storedHash - Base64-encoded stored hash
 * @param storedSalt - Base64-encoded stored salt
 * @returns True if password matches
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  try {
    // Hash the provided password with the stored salt
    const { hash } = await hashPassword(password, storedSalt)

    // Constant-time comparison
    return timingSafeEqual(hash, storedHash)
  } catch (error) {
    console.error('Password verification error:', error)
    return false
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 *
 * @param a - First string
 * @param b - Second string
 * @returns True if strings are equal
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return result === 0
}

// =============================================================================
// Token Generation
// =============================================================================

/**
 * Generate a secure random token for email verification or password reset.
 *
 * @param length - Token length in bytes (default 32)
 * @returns Hex-encoded token
 */
export function generateSecureToken(length: number = 32): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Token expiry durations in milliseconds
 */
export const TOKEN_EXPIRY = {
  /** Email verification token expiry (24 hours) */
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  /** Password reset token expiry (1 hour) */
  PASSWORD_RESET: 60 * 60 * 1000,
}
