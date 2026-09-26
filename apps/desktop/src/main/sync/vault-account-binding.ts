import fs from 'fs'
import path from 'path'

import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { decodeJwt } from 'jose'

import * as schema from '@memry/db-schema/data-schema'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { OFFLINE_CLOCK_DEVICE_ID } from '@memry/contracts/sync-api'
import type { VaultBindingChoice, VaultBindingState } from '@memry/contracts/ipc-sync-ops'

import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  findVault,
  getAccountVaultsCache,
  getCurrentVaultPath,
  getStoredDeviceId,
  upsertVault
} from '../store'
import { getFromServer } from './http-client'
import { getValidAccessToken, retrieveToken } from './token-manager'

const log = createLogger('Sync:VaultAccountBinding')

/**
 * Which account a vault syncs with, stored in the vault's own data DB so the
 * binding travels with the folder. A plain settings row: older app versions
 * ignore the key, and vaults written by them simply have none (unbound).
 *
 * Why it exists: sign-out keeps every vault on disk, and nothing used to record
 * whose they were. The next account to sign in on the machine started syncing
 * them — its own key, its own account, someone else's notes — and sign-in with a
 * non-empty vault open silently merged it into the account's largest vault.
 */
export const VAULT_ACCOUNT_BINDING_SETTING = 'sync.account-binding.v1'

export interface VaultAccountBinding {
  userId: string
  /** 'sync' = syncs with `userId`; 'local' = `userId` chose to keep it on this device. */
  mode: 'sync' | 'local'
}

export interface AccountVaultSummary {
  vaultUuid: string
  itemCount?: number
}

export interface BindingInputs {
  binding: VaultAccountBinding | null
  userId: string
  localVaultUuid: string
  hasLocalContent: boolean
  /** Written by a device other than this one (another account's session). */
  hasForeignHistory: boolean
  /** null = the account's vault list could not be fetched. */
  accountVaults: AccountVaultSummary[] | null
}

export type BindingDecision =
  { action: 'start'; bind: boolean } | { action: 'hold'; state: VaultBindingState }

/**
 * Whether the open vault may sync with `userId`. Sync starts only when the
 * answer is unambiguous; everything else holds and asks, or refuses.
 *
 * Order matters:
 * - an empty vault has nothing to leak, so it binds before any network check
 *   (a vault created offline would otherwise pick up clocks and look foreign);
 * - the account already knowing the uuid is proof of ownership, and is how
 *   vaults from older app versions get bound without a prompt;
 * - history from another device on a vault the account does not know means
 *   some other account synced it.
 */
export function decideVaultBinding(input: BindingInputs): BindingDecision {
  const { binding, userId } = input

  if (binding?.userId === userId) {
    return binding.mode === 'sync'
      ? { action: 'start', bind: false }
      : { action: 'hold', state: { status: 'local-only' } }
  }
  if (binding?.mode === 'sync') return { action: 'hold', state: { status: 'foreign' } }

  if (!input.hasLocalContent) return { action: 'start', bind: true }
  if (input.accountVaults === null) return { action: 'hold', state: { status: 'unknown' } }
  if (input.accountVaults.some((v) => v.vaultUuid === input.localVaultUuid)) {
    return { action: 'start', bind: true }
  }
  if (input.hasForeignHistory) return { action: 'hold', state: { status: 'foreign' } }

  const target = pickMergeTarget(input.accountVaults)
  return {
    action: 'hold',
    state: {
      status: 'needs-decision',
      accountVaultCount: input.accountVaults.length,
      mergeTarget: target
        ? { vaultUuid: target.vaultUuid, name: cachedVaultName(target.vaultUuid) }
        : null
    }
  }
}

function pickMergeTarget(vaults: AccountVaultSummary[]): AccountVaultSummary | undefined {
  return [...vaults].sort((a, b) => (b.itemCount ?? 0) - (a.itemCount ?? 0))[0]
}

function cachedVaultName(vaultUuid: string): string | null {
  return getAccountVaultsCache()?.vaults.find((v) => v.vaultUuid === vaultUuid)?.name ?? null
}

/**
 * Is `choice` allowed from `state`? Foreign vaults accept nothing: syncing one
 * would need a fresh identity and a full re-push (its items carry another
 * account's clocks and would never be seeded), which is a separate feature.
 * Recording a 'local' choice for one would be worse — it would replace the
 * owner's binding with ours and turn the vault into a local-only vault that
 * this account could then switch to syncing.
 */
export function isChoiceAllowed(state: VaultBindingState, choice: VaultBindingChoice): boolean {
  switch (state.status) {
    case 'needs-decision':
      return choice !== 'merge' || state.mergeTarget !== null
    case 'local-only':
      return choice === 'sync'
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Open-vault state
// ---------------------------------------------------------------------------

const NEUTRAL_STATE: VaultBindingState = { status: 'bound' }
let currentState: VaultBindingState = NEUTRAL_STATE

export function getVaultBindingState(): VaultBindingState {
  return currentState
}

export function setVaultBindingState(state: VaultBindingState): void {
  if (JSON.stringify(state) === JSON.stringify(currentState)) return
  currentState = state
  broadcastToAllWindows(EVENT_CHANNELS.VAULT_BINDING_CHANGED, state)
}

/** Back to neutral: the runtime stopped (vault switch, sign-out, quit). */
export function resetVaultBindingState(): void {
  setVaultBindingState(NEUTRAL_STATE)
}

/**
 * Gather the inputs for the open vault and decide. The network is only asked
 * when the vault is unbound and has content.
 */
export async function evaluateOpenVaultBinding(
  db: DataDb
): Promise<{ userId: string | null; decision: BindingDecision }> {
  const userId = await getSignedInUserId()
  if (!userId) return { userId, decision: { action: 'hold', state: { status: 'unknown' } } }

  const binding = readVaultAccountBinding(db)
  const hasLocalContent =
    binding?.userId === userId ? true : vaultHasLocalContent(db, getCurrentVaultPath())
  const unbound = binding?.userId !== userId && binding?.mode !== 'sync'
  const needsServer = unbound && hasLocalContent

  const decision = decideVaultBinding({
    binding,
    userId,
    localVaultUuid: getOrCreateVaultUuid(db),
    hasLocalContent,
    hasForeignHistory: needsServer ? vaultHasForeignHistory(db) : false,
    accountVaults: needsServer ? await fetchAccountVaults() : []
  })
  return { userId, decision }
}

/**
 * Runtime-start gate for the open vault: decide, bind when that is the answer,
 * and publish the state. Returns 'start', 'held' (never syncs as things stand),
 * or 'unknown' (ownership could not be checked; retry).
 */
export async function applyOpenVaultBinding(db: DataDb): Promise<'start' | 'held' | 'unknown'> {
  const { userId, decision } = await evaluateOpenVaultBinding(db)
  if (decision.action === 'hold') {
    setVaultBindingState(decision.state)
    log.info('Sync held for this vault', { binding: decision.state.status })
    return decision.state.status === 'unknown' ? 'unknown' : 'held'
  }
  if (decision.bind && userId) {
    bindVaultForSync(db, userId)
    log.info('Vault bound to the signed-in account')
    // Lazy: vault-directory imports this module.
    void import('./vault-directory')
      .then(({ refreshVaultDirectory }) => refreshVaultDirectory({ force: true }))
      .catch(() => {})
  }
  setVaultBindingState({ status: 'bound' })
  return 'start'
}

const BINDING_RETRY_MS = 60_000
let bindingRetryTimer: NodeJS.Timeout | null = null

/** One pending retry of `start` after an 'unknown' gate; a no-op while one is pending. */
export function scheduleBindingRetry(start: () => Promise<unknown>): void {
  if (bindingRetryTimer) return
  bindingRetryTimer = setTimeout(() => {
    bindingRetryTimer = null
    void start().catch((err) => log.warn('Sync retry after vault ownership check failed', err))
  }, BINDING_RETRY_MS)
  bindingRetryTimer.unref?.()
}

export function cancelBindingRetry(): void {
  if (bindingRetryTimer) clearTimeout(bindingRetryTimer)
  bindingRetryTimer = null
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function readVaultAccountBinding(db: DataDb): VaultAccountBinding | null {
  const row = db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, VAULT_ACCOUNT_BINDING_SETTING))
    .get()
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<VaultAccountBinding>
    if (typeof parsed.userId !== 'string' || !parsed.userId) return null
    if (parsed.mode !== 'sync' && parsed.mode !== 'local') return null
    return { userId: parsed.userId, mode: parsed.mode }
  } catch {
    return null
  }
}

/**
 * Persist the binding in the vault DB and mirror it onto the vault's store
 * entry, which is what the account vault directory reads for vaults that are
 * not open.
 */
export function writeVaultAccountBinding(db: DataDb, binding: VaultAccountBinding): void {
  const value = JSON.stringify(binding)
  db.insert(schema.settings)
    .values({ key: VAULT_ACCOUNT_BINDING_SETTING, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()

  const vaultPath = getCurrentVaultPath()
  const stored = vaultPath ? findVault(vaultPath) : undefined
  if (stored) upsertVault({ ...stored, accountBinding: binding })
}

// Mirrors the keys device registration clears for a freshly registered device.
const SESSION_SCOPED_SYNC_STATE_KEYS = ['lastCursor', 'lastSyncAt', 'initialSeedDone', 'syncPaused']

/**
 * Bind the open vault to `userId` for syncing.
 *
 * Sign-out only clears the vault that was open at the time. Any other vault
 * still holds the previous session's current-device row and cursor, and
 * `ensureDeviceRowForVault` would adopt that stale device id as the install's
 * identity. Drop them so the vault starts from this session's device.
 */
export function bindVaultForSync(db: DataDb, userId: string): void {
  const deviceId = getStoredDeviceId()
  if (deviceId) {
    const stale = db
      .select({ id: schema.syncDevices.id })
      .from(schema.syncDevices)
      .where(and(eq(schema.syncDevices.isCurrentDevice, true), ne(schema.syncDevices.id, deviceId)))
      .get()
    if (stale) {
      db.transaction((tx) => {
        tx.delete(schema.syncDevices).where(eq(schema.syncDevices.id, stale.id)).run()
        tx.delete(schema.syncState)
          .where(inArray(schema.syncState.key, SESSION_SCOPED_SYNC_STATE_KEYS))
          .run()
      })
      log.info('Dropped a previous session device row from the vault being bound')
    }
  }
  writeVaultAccountBinding(db, { userId, mode: 'sync' })
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The signed-in account id (`sub` of the session tokens), or null when signed out. */
export async function getSignedInUserId(): Promise<string | null> {
  for (const entry of [KEYCHAIN_ENTRIES.ACCESS_TOKEN, KEYCHAIN_ENTRIES.REFRESH_TOKEN]) {
    const token = await retrieveToken(entry)
    if (!token) continue
    try {
      const sub = decodeJwt(token).sub
      if (sub) return sub
    } catch {
      // Malformed token: try the next one.
    }
  }
  return null
}

export async function fetchAccountVaults(): Promise<AccountVaultSummary[] | null> {
  try {
    const token = await getValidAccessToken()
    if (!token) return null
    const { vaults } = await getFromServer<{ vaults: AccountVaultSummary[] }>('/sync/vaults', token)
    return vaults
  } catch (err) {
    log.warn('Could not fetch account vaults for binding check', err)
    return null
  }
}

const CONTENT_SCAN_MAX_DEPTH = 6
const CONTENT_SCAN_MAX_ENTRIES = 5_000

/**
 * Anything a user could lose or leak: a file in the vault folder (notes,
 * journals, attachments — dot-directories like `.memry` are app state), or a
 * task or inbox item. A freshly created vault has folders only.
 */
export function vaultHasLocalContent(db: DataDb, vaultPath: string | null): boolean {
  const rowExists = db.get<{ found: number } | undefined>(
    sql`SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM tasks) OR EXISTS (SELECT 1 FROM inbox_items)`
  )
  if (rowExists) return true
  return vaultPath ? folderHasFiles(vaultPath) : false
}

function folderHasFiles(root: string): boolean {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let seen = 0
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isFile()) return true
      // Past the scan budget, assume content: a false "empty" would bind
      // without asking, a false "has content" only asks once.
      if (++seen > CONTENT_SCAN_MAX_ENTRIES) return true
      if (entry.isDirectory() && depth < CONTENT_SCAN_MAX_DEPTH) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return false
}

/**
 * Does any synced row carry a clock tick from a device other than this one?
 * Offline edits tick a placeholder device and are this device's own. Every
 * sign-in registers a new device id, so ticks from a previous session —
 * another account's included — show up here.
 */
export function vaultHasForeignHistory(db: DataDb): boolean {
  // The install-wide id, not the vault's device row: a vault that was not open
  // at sign-out still has the previous session's row, which would make that
  // session's ticks look like our own.
  const deviceId = getStoredDeviceId() ?? ''
  const found = db.get<{ found: number } | undefined>(sql`
    SELECT 1 AS found WHERE
      EXISTS (SELECT 1 FROM tasks t, json_each(t.clock) c
              WHERE t.clock IS NOT NULL AND c.key NOT IN (${deviceId}, ${OFFLINE_CLOCK_DEVICE_ID}))
      OR EXISTS (SELECT 1 FROM inbox_items i, json_each(i.clock) c
              WHERE i.clock IS NOT NULL AND c.key NOT IN (${deviceId}, ${OFFLINE_CLOCK_DEVICE_ID}))
      OR EXISTS (SELECT 1 FROM note_metadata n, json_each(n.clock) c
              WHERE n.clock IS NOT NULL AND c.key NOT IN (${deviceId}, ${OFFLINE_CLOCK_DEVICE_ID}))
  `)
  return Boolean(found)
}
