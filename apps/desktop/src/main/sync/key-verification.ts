import { z } from 'zod'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'

import { generateKeyVerifier, retrieveKey, secureCleanup } from '../crypto'
import { createLogger } from '../lib/logger'
import { store } from '../store'
import { getFromServer } from './http-client'
import { getValidAccessToken } from './token-manager'

const log = createLogger('Sync:KeyVerification')

const KeyVerifierResponseSchema = z.object({
  kdfSalt: z.string(),
  keyVerifier: z.string().nullable()
})

/**
 * How recently a sign-in / recovery / linking flow touched key material.
 * While such a flow is mid-flight the keychain legitimately holds a key that
 * may not yet match the account (the true key lands at flow finalize), so
 * mismatch detection must stand down instead of tearing the session down or
 * blocking sync — the flow itself restarts the runtime when it finishes.
 */
const KEY_MATERIAL_ACTIVITY_WINDOW_MS = 2 * 60 * 1000

let lastKeyMaterialActivityAt = 0

export function markKeyMaterialActivity(): void {
  lastKeyMaterialActivityAt = Date.now()
}

/**
 * The flow that touched key material has finalized: the keychain holds the
 * final key and the account verifier is cached, so mismatch checks can
 * classify again immediately instead of waiting out the transition window.
 */
export function clearKeyMaterialActivity(): void {
  lastKeyMaterialActivityAt = 0
}

export function isKeyMaterialActivityRecent(): boolean {
  return Date.now() - lastKeyMaterialActivityAt < KEY_MATERIAL_ACTIVITY_WINDOW_MS
}

/** Milliseconds until the key-material transition window expires (0 when clear). */
export function keyMaterialActivityRemainingMs(): number {
  return Math.max(0, KEY_MATERIAL_ACTIVITY_WINDOW_MS - (Date.now() - lastKeyMaterialActivityAt))
}

/** Test-only: reset module state between test cases. */
export function resetKeyVerificationForTests(): void {
  lastKeyMaterialActivityAt = 0
}

/**
 * Persist the account key verifier locally so mismatch checks work offline.
 * Called from every flow that establishes key material (first-device setup,
 * recovery-phrase restore, device linking) via persistKeysAndRegisterDevice.
 */
export function persistAccountKeyVerifier(keyVerifier: string): void {
  store.set('sync', { ...store.get('sync'), accountKeyVerifier: keyVerifier })
}

/**
 * The account's key verifier: local copy first (works offline), else fetched
 * from the server with the session's access token and cached locally. Returns
 * null when unknowable right now (offline, no session, older server).
 */
async function resolveAccountKeyVerifier(): Promise<string | null> {
  const stored = store.get('sync').accountKeyVerifier
  if (stored) return stored

  try {
    const accessToken = await getValidAccessToken()
    if (!accessToken) return null
    const raw = await getFromServer<unknown>('/auth/key-verifier', accessToken)
    const parsed = KeyVerifierResponseSchema.safeParse(raw)
    if (!parsed.success || !parsed.data.keyVerifier) return null
    persistAccountKeyVerifier(parsed.data.keyVerifier)
    return parsed.data.keyVerifier
  } catch (err) {
    log.debug('Account key verifier fetch unavailable', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

export type AccountKeyCheck = 'match' | 'mismatch' | 'transition' | 'unknown'

/**
 * Does the master key in the local keychain still match the account?
 *
 * - 'match'      — verified against the account verifier; safe to sync.
 * - 'mismatch'   — the local key can never decrypt this account's data.
 *                  Pulling would fail on every item; the caller must route the
 *                  user to recovery instead of syncing.
 * - 'transition' — a sign-in / recovery / linking flow is re-establishing key
 *                  material right now. The key may legitimately be mid-swap:
 *                  do not sync, do not record failures, do not escalate — the
 *                  flow restarts the runtime itself when it finishes.
 * - 'unknown'    — cannot tell right now (no key readable, offline and no
 *                  local verifier copy). Callers treat this as "proceed as
 *                  before" — never destructive.
 */
export async function checkLocalKeyAgainstAccount(): Promise<AccountKeyCheck> {
  if (isKeyMaterialActivityRecent()) return 'transition'

  let masterKey: Uint8Array | null = null
  try {
    masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
  } catch {
    // Transient keychain read failure — never classify on an uncertain read.
    return 'unknown'
  }
  if (!masterKey) return 'unknown'

  let localVerifier: string
  try {
    localVerifier = await generateKeyVerifier(masterKey)
  } finally {
    secureCleanup(masterKey)
  }

  const accountVerifier = await resolveAccountKeyVerifier()
  if (!accountVerifier) return 'unknown'

  return localVerifier === accountVerifier ? 'match' : 'mismatch'
}
