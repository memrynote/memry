import { randomBytes } from 'node:crypto'
import { deleteSecret, getSecret, setSecret } from '../secrets/secret-storage'
import { store } from '../store'
import { isExtensionOrigin } from './auth'

const SERVICE = 'com.memry.capture'
const ACCOUNT = 'pairing-token'
const ALLOWLIST_KEY = 'captureAllowedOrigins'

let claimWindowUntil = 0
let cachedToken: string | null = null
let inFlightRead: Promise<string> | null = null

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

// Resolve once, then serve from memory: the token never changes except via
// rotate/unpair, and /capture reads it on every request — a keychain round-trip
// per request is both slow and racy (two first-run callers could mint different
// tokens). The in-flight guard collapses concurrent first reads into one.
export async function getCaptureToken(): Promise<string> {
  if (cachedToken) return cachedToken
  if (inFlightRead) return inFlightRead
  inFlightRead = (async () => {
    // An unreadable token is replaced on the next line, so treating it as
    // absent is safe and is the only way a profile stranded by the
    // v2026-08-06 identity rename can ever pair the clipper again.
    const existing = await getSecret(SERVICE, ACCOUNT, { treatUnreadableAsAbsent: true })
    const token = existing ?? generateToken()
    if (!existing) await setSecret(SERVICE, ACCOUNT, token)
    cachedToken = token
    return token
  })()
  try {
    return await inFlightRead
  } finally {
    inFlightRead = null
  }
}

export async function rotateCaptureToken(): Promise<string> {
  const token = generateToken()
  await setSecret(SERVICE, ACCOUNT, token)
  cachedToken = token
  store.set(ALLOWLIST_KEY, [])
  claimWindowUntil = 0
  return token
}

export async function unpairCapture(): Promise<void> {
  await deleteSecret(SERVICE, ACCOUNT)
  cachedToken = null
  store.set(ALLOWLIST_KEY, [])
  claimWindowUntil = 0
}

function allowlist(): string[] {
  const raw = store.get(ALLOWLIST_KEY)
  return Array.isArray(raw) ? raw : []
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false
  return allowlist().includes(origin)
}

export function openPairingWindow(ttlMs = 120_000): void {
  claimWindowUntil = Date.now() + ttlMs
}

export function isPairingWindowOpen(now = Date.now()): boolean {
  return now < claimWindowUntil
}

export async function claimPairing(origin: string): Promise<{ token: string } | null> {
  if (!isPairingWindowOpen()) return null
  if (!isExtensionOrigin(origin)) return null
  const list = allowlist()
  if (!list.includes(origin)) store.set(ALLOWLIST_KEY, [...list, origin])
  claimWindowUntil = 0 // single claim closes the window
  return { token: await getCaptureToken() }
}
