import { randomBytes } from 'node:crypto'
import keytar from 'keytar'
import { store } from '../store'

const SERVICE = 'com.memry.capture'
const ACCOUNT = 'pairing-token'
const ALLOWLIST_KEY = 'captureAllowedOrigins'

let claimWindowUntil = 0

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export async function getCaptureToken(): Promise<string> {
  const existing = await keytar.getPassword(SERVICE, ACCOUNT)
  if (existing) return existing
  const token = generateToken()
  await keytar.setPassword(SERVICE, ACCOUNT, token)
  return token
}

export async function rotateCaptureToken(): Promise<string> {
  const token = generateToken()
  await keytar.setPassword(SERVICE, ACCOUNT, token)
  store.set(ALLOWLIST_KEY, [])
  return token
}

export async function unpairCapture(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT)
  store.set(ALLOWLIST_KEY, [])
}

function allowlist(): string[] {
  const raw = store.get(ALLOWLIST_KEY)
  return Array.isArray(raw) ? (raw as string[]) : []
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
  if (!origin.startsWith('chrome-extension://')) return null
  const list = allowlist()
  if (!list.includes(origin)) store.set(ALLOWLIST_KEY, [...list, origin])
  claimWindowUntil = 0 // single claim closes the window
  return { token: await getCaptureToken() }
}
