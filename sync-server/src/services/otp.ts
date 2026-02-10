import { AppError, ErrorCodes } from '../lib/errors'

const OTP_LENGTH = 6
const OTP_EXPIRY_SECONDS = 600
const MAX_ATTEMPTS = 5
const MAX_EMAIL_REQUESTS = 3
const EMAIL_WINDOW_SECONDS = 600

export const generateOtp = (): string => {
  const array = new Uint32Array(1)
  crypto.getRandomValues(array)
  return String(array[0] % 1_000_000).padStart(OTP_LENGTH, '0')
}

export const hashOtp = async (code: string): Promise<string> => {
  const encoded = new TextEncoder().encode(code)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const constantTimeCompare = async (a: string, b: string): Promise<boolean> => {
  const encoder = new TextEncoder()
  const aBuf = encoder.encode(a)
  const bBuf = encoder.encode(b)
  if (aBuf.byteLength !== bBuf.byteLength) return false
  return crypto.subtle.timingSafeEqual(aBuf, bBuf)
}

export const storeOtp = async (
  db: D1Database,
  email: string,
  code: string
): Promise<{ id: string; expiresAt: number }> => {
  const now = Math.floor(Date.now() / 1000)

  await db.prepare('UPDATE otp_codes SET used = 1 WHERE email = ? AND used = 0').bind(email).run()

  const id = crypto.randomUUID()
  const codeHash = await hashOtp(code)
  const expiresAt = now + OTP_EXPIRY_SECONDS

  await db
    .prepare(
      'INSERT INTO otp_codes (id, email, code_hash, expires_at, attempts, used, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)'
    )
    .bind(id, email, codeHash, expiresAt, now)
    .run()

  return { id, expiresAt }
}

export const verifyOtp = async (db: D1Database, email: string, code: string): Promise<void> => {
  const now = Math.floor(Date.now() / 1000)

  const record = await db
    .prepare(
      'SELECT id, code_hash, attempts FROM otp_codes WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
    )
    .bind(email, now)
    .first<{ id: string; code_hash: string; attempts: number }>()

  if (!record) {
    throw new AppError(ErrorCodes.AUTH_OTP_EXPIRED, 'OTP expired or not found', 401)
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new AppError(ErrorCodes.AUTH_OTP_MAX_ATTEMPTS, 'Maximum OTP attempts exceeded', 401)
  }

  const inputHash = await hashOtp(code)
  const isMatch = await constantTimeCompare(inputHash, record.code_hash)

  if (!isMatch) {
    await db
      .prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?')
      .bind(record.id)
      .run()
    throw new AppError(ErrorCodes.AUTH_INVALID_OTP, 'Invalid OTP code', 401)
  }

  await db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').bind(record.id).run()
}

export const hasPendingOtp = async (db: D1Database, email: string): Promise<boolean> => {
  const now = Math.floor(Date.now() / 1000)
  const record = await db
    .prepare(
      'SELECT id FROM otp_codes WHERE email = ? AND used = 0 AND expires_at > ? LIMIT 1'
    )
    .bind(email, now)
    .first<{ id: string }>()
  return !!record
}

export const checkEmailRateLimit = async (db: D1Database, email: string): Promise<void> => {
  const key = `otp-email:${email}`
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - EMAIL_WINDOW_SECONDS

  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_start)
         VALUES (?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`
      )
      .bind(key, now, windowStart, windowStart, now),
    db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key)
  ])

  const row = (result[1] as D1Result).results?.[0] as
    | { count: number; window_start: number }
    | undefined
  const count = row?.count ?? 0

  if (count > MAX_EMAIL_REQUESTS) {
    throw new AppError(ErrorCodes.RATE_LIMITED, 'Too many OTP requests for this email', 429)
  }
}
