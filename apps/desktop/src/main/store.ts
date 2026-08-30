import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { LocaleSchema, type Locale } from '@memry/contracts/locale-api'
import { clampZoomFactor, DEFAULT_ZOOM_FACTOR, type ZoomFactor } from '@memry/contracts/ui-zoom'
import { createLogger } from './lib/logger'
import { trackMainError } from './telemetry/diagnostics'

const logger = createLogger('Store')

/**
 * Vault information stored in config
 */
export interface StoredVaultInfo {
  path: string
  name: string
  noteCount: number
  taskCount: number
  lastOpened: string
  isDefault: boolean
  /** Server vault uuid; stamped when the vault is opened while sync is set up */
  vaultUuid?: string
}

export interface CachedEntitlement {
  isPaid: boolean
  plan: string
  status: string
  /**
   * Plan limits from the last billing status. Optional: stores written by older
   * app versions have no `limits` key, and it is only populated on a billing
   * fetch — so every reader must tolerate it being absent and fall back to
   * server-authoritative behaviour rather than blocking.
   */
  limits?: {
    /** Max plaintext bytes per file the plan allows. */
    maxFileSize: number
  }
  /**
   * When `limits` was last fetched (epoch ms). Optional: stores written by older
   * app versions have no `cachedAt`, and those must be read as stale rather than
   * fresh — see `getCachedMaxFileSize`.
   */
  cachedAt?: number
}

/**
 * Sync-related persistent state
 */
export interface SyncStoreData {
  recoveryPhraseConfirmed?: boolean
  email?: string
  /** Server device id for this install; seeds device rows in newly provisioned vault DBs */
  deviceId?: string
  /** Last known account vault list (decrypted names) for offline switcher display */
  accountVaultsCache?: AccountVaultsCache
  /** Cache-first entitlement snapshot; gates whether sync runs without a server call */
  entitlement?: CachedEntitlement
  /**
   * The account's key verifier (same value the server stores from /auth/setup).
   * Non-secret — it is a KDF-derived check value, not key material. Persisted at
   * sign-in/recovery/linking so the app can detect a local master key that no
   * longer matches the account (vault-key mismatch) even while offline.
   */
  accountKeyVerifier?: string
}

export interface AccountVaultsCache {
  fetchedAt: number
  vaults: Array<{
    vaultUuid: string
    name: string | null
    itemCount: number
    createdAt: number | null
  }>
}

export interface AgentStoreData {
  disclosureAccepted?: boolean
  accessMode?: 'vault_only' | 'computer_access'
  toolApprovalMode?: 'always_accept' | 'ask'
  localProvider?: {
    preset?: 'ollama' | 'lm_studio' | 'llama_cpp' | 'custom'
    baseUrl?: string
    model?: string
    allowNonLoopback?: boolean
  }
}

/**
 * Bookkeeping for the on-disk CRDT stores. They live in userData, outside every
 * vault, so a vault's own database is not a place this can be recorded.
 */
export interface CrdtStoreData {
  /**
   * Vault uuid that inherited the pre-per-vault global `crdt-store` directory.
   *
   * Every build before per-vault scoping wrote one store for the whole install,
   * keyed by note id — so its history belongs to whichever vault last wrote a
   * given note, and journal notes (deterministic date ids like `j2026-08-13`)
   * genuinely collided across vaults. Exactly one vault may take it over, and
   * this records which: absent means the legacy store is still unclaimed,
   * present means every other vault starts from an empty store and re-seeds
   * from its own markdown.
   *
   * Optional: stores written by older app versions have no `crdtStore` key at
   * all, which reads as "unclaimed" — the correct starting state.
   */
  legacyStoreClaimedBy?: string
  /** When the claim was recorded (epoch ms). Diagnostics only. */
  legacyStoreClaimedAt?: number
  /**
   * Vault uuid whose inherited legacy store still has to have its
   * cross-vault-ambiguous documents set aside.
   *
   * Only written when the install has known more than one vault, because only
   * then can the legacy store hold a document that is not this vault's. Written
   * in the same file write as the claim and cleared only after a complete pass,
   * so an interrupted migration is resumed rather than silently skipped. See
   * `inheritLegacyCrdtStore` in sync/crdt-store-path.ts.
   *
   * Optional for the same reason as the claim: older stores have no `crdtStore`
   * key at all, which reads as "nothing pending" — the correct starting state.
   */
  legacyStorePartitionPendingFor?: string
  /**
   * Store directories left behind by a vault uuid that changed, as
   * `adopted uuid -> uuid the directory is still named after`.
   *
   * A store is named after its vault's uuid, and that uuid is resolved once —
   * when the provider opens the store. Device linking rewrites it afterwards
   * (`adoptVaultLocally`), so from the *next* open onwards the vault looks for a
   * directory that does not exist and its whole merge history is orphaned under
   * the old name. This is what the next open reads to find it.
   *
   * A map rather than a single record because the rename is per vault and an
   * install has many; entries are removed as they settle, so it holds one key
   * per vault that linked and has not been opened since.
   *
   * Optional for the same reason as the two above: older stores have no
   * `crdtStore` key at all, which reads as "nothing pending" — correct for
   * every install that has not linked under a build that records this.
   */
  pendingRenames?: Record<string, string>
  /**
   * Consecutive launches that ended with no on-disk CRDT store, reset to 0 the
   * moment one opens.
   *
   * Persisted because the thing worth telling the user about is not one bad
   * launch — the store recovers from those on its own — but a machine that has
   * been running CRDT state in memory for a while and has no idea. A whole
   * Windows population did exactly that with a single log line as the only
   * signal (issue #1583); this is what the notice counts.
   *
   * Optional for the same reason as the keys above: stores written by older app
   * versions have no `crdtStore` key at all, which reads as 0 — the correct
   * starting state for an install that has never degraded.
   */
  inMemorySessions?: number
}

/**
 * Last known main-window geometry, restored on the next launch / dock reopen so
 * the window comes back at the size and position the user left it.
 */
export interface StoredWindowBounds {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

/**
 * Auto-updater preferences that must survive restarts and be readable by the
 * main process before any renderer loads (so the startup update check honors them).
 */
export interface UpdaterStoreData {
  /** Display version the user chose to skip; suppresses automatic prompts for it. */
  skippedVersion?: string
  /** When true, updates download + install without prompting. */
  autoDownload?: boolean
  /** When true (default), the app checks for updates at launch and on an interval. */
  autoCheck?: boolean
}

/**
 * Application store schema
 */
interface StoreSchema {
  /** App-level locale used before a vault is open */
  locale: Locale | null
  /** Path to the currently open vault */
  currentVault: string | null
  /** List of known vaults */
  vaults: StoredVaultInfo[]
  /** Sync configuration */
  sync: SyncStoreData
  /** Local agent-chat preferences */
  agent: AgentStoreData
  /** Localhost capture: origins that have completed the pairing handshake */
  captureAllowedOrigins: string[]
  /** Auto-updater preferences */
  updater: UpdaterStoreData
  /** Last known main-window geometry (null until the window is first sized) */
  windowBounds: StoredWindowBounds | null
  /**
   * Whole-UI zoom applied to every window's webContents.
   *
   * Device-local like `windowBounds`: it describes the physical display, not
   * the vault, so the right value on a 27-inch monitor is the wrong one on a
   * 13-inch laptop. Read through `getUiZoomFactor`, never raw — `readConfig`
   * merges the parsed file in unvalidated, so this field can hold anything.
   */
  uiZoomFactor: number
  /** Cross-vault bookkeeping for the userData-level CRDT stores */
  crdtStore: CrdtStoreData
}

const CONFIG_FILE = 'memry-config.json'

const defaultData: StoreSchema = {
  locale: null,
  currentVault: null,
  vaults: [],
  sync: {},
  agent: {},
  captureAllowedOrigins: [],
  updater: {},
  windowBounds: null,
  uiZoomFactor: DEFAULT_ZOOM_FACTOR,
  crdtStore: {}
}

/** In-memory cache — populated on first read, updated on every write. */
let cache: StoreSchema | null = null

/**
 * Get the config file path in the app's userData directory
 */
function getConfigPath(): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, CONFIG_FILE)
}

/**
 * Read the config file (only called when cache is cold).
 */
function readConfig(): StoreSchema {
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(content) as Partial<StoreSchema>
      return { ...defaultData, ...parsed }
    }
  } catch (error) {
    logger.error('Error reading config:', error)
    // A corrupt/unreadable config makes the app look factory-reset (vault list,
    // current vault, window bounds all gone) — must be visible fleet-wide.
    trackMainError('store', 'config_read_failed', error)
  }
  return { ...defaultData }
}

/**
 * Write the config file and keep the cache in sync.
 */
function writeConfig(data: StoreSchema): void {
  try {
    const configPath = getConfigPath()
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8')
    cache = data
  } catch (error) {
    logger.error('Error writing config:', error)
    // Silently loses vault registration / currentVault / device id until restart;
    // the in-memory cache masks it, so telemetry is the only timely signal.
    trackMainError('store', 'config_write_failed', error)
  }
}

function getCache(): StoreSchema {
  if (!cache) {
    cache = readConfig()
  }
  return cache
}

/**
 * Simple store object that mimics electron-store API
 */
export const store = {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K] {
    return getCache()[key]
  },

  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    const data = { ...getCache(), [key]: value }
    writeConfig(data)
  }
}

/**
 * Get the last persisted main-window geometry, or null if none saved yet.
 */
export function getWindowBounds(): StoredWindowBounds | null {
  return store.get('windowBounds')
}

/**
 * Persist the main-window geometry for restore on the next launch / dock reopen.
 */
export function setWindowBounds(bounds: StoredWindowBounds): void {
  store.set('windowBounds', bounds)
}

/**
 * Get the persisted whole-UI zoom factor, snapped to the shared ladder.
 *
 * Installs written before this setting existed have no key at all and read as
 * the default through `defaultData`; anything else on disk is reconciled here.
 */
export function getUiZoomFactor(): ZoomFactor {
  return clampZoomFactor(store.get('uiZoomFactor'))
}

/**
 * Persist the whole-UI zoom factor, snapped to the shared ladder.
 */
export function setUiZoomFactor(factor: number): void {
  store.set('uiZoomFactor', clampZoomFactor(factor))
}

/**
 * Get the current vault path
 */
export function getCurrentVaultPath(): string | null {
  return store.get('currentVault')
}

/**
 * Set the current vault path
 */
export function setCurrentVaultPath(path: string | null): void {
  store.set('currentVault', path)
}

/**
 * Get the app-level locale used before a vault is open.
 */
export function getStoredLocale(): Locale | null {
  const parsed = LocaleSchema.safeParse(store.get('locale'))
  return parsed.success ? parsed.data : null
}

/**
 * Persist the app-level locale used by shell surfaces such as the vault picker.
 */
export function setStoredLocale(locale: Locale): void {
  store.set('locale', LocaleSchema.parse(locale))
}

/**
 * Get all known vaults
 */
export function getVaults(): StoredVaultInfo[] {
  return store.get('vaults')
}

/**
 * Add or update a vault in the known vaults list
 */
export function upsertVault(vault: StoredVaultInfo): void {
  const vaults = store.get('vaults')
  const existingIndex = vaults.findIndex((v) => v.path === vault.path)

  if (existingIndex >= 0) {
    // The server vault uuid is the ONLY link between this row and the account
    // vault directory — losing it makes the vault look cloud-only and mints a
    // fresh dormant folder on the next Download. Callers rebuild VaultInfo
    // from scratch and stamp the uuid best-effort, so a row update without a
    // uuid must never erase one that was already stored.
    const existing = vaults[existingIndex]
    vaults[existingIndex] = { ...vault, vaultUuid: vault.vaultUuid ?? existing.vaultUuid }
  } else {
    vaults.push(vault)
  }

  store.set('vaults', vaults)
}

/**
 * Remove a vault from the known vaults list
 */
export function removeVault(vaultPath: string): void {
  const vaults = store.get('vaults')
  store.set(
    'vaults',
    vaults.filter((v) => v.path !== vaultPath)
  )
}

/**
 * Find a vault by path
 */
export function findVault(vaultPath: string): StoredVaultInfo | undefined {
  return store.get('vaults').find((v) => v.path === vaultPath)
}

/**
 * Get the install-wide server device id
 */
export function getStoredDeviceId(): string | undefined {
  return store.get('sync').deviceId
}

/**
 * Persist the install-wide server device id
 */
export function setStoredDeviceId(deviceId: string): void {
  store.set('sync', { ...store.get('sync'), deviceId })
}

/**
 * Get the cached account vault list
 */
export function getAccountVaultsCache(): AccountVaultsCache | undefined {
  return store.get('sync').accountVaultsCache
}

/**
 * Replace the cached account vault list
 */
export function setAccountVaultsCache(accountVaultsCache: AccountVaultsCache): void {
  store.set('sync', { ...store.get('sync'), accountVaultsCache })
}

/**
 * Get the default vault path used by CLI commands when --vault is omitted.
 */
export function getDefaultVaultPath(): string | null {
  return store.get('vaults').find((vault) => vault.isDefault)?.path ?? null
}

/**
 * Mark one known vault as the default used by CLI commands.
 */
export function setDefaultVaultPath(vaultPath: string): StoredVaultInfo | null {
  const vaults = store.get('vaults')
  const target = vaults.find((vault) => vault.path === vaultPath)
  if (!target) return null

  const updated = vaults.map((vault) => ({
    ...vault,
    isDefault: vault.path === vaultPath
  }))
  store.set('vaults', updated)

  return updated.find((vault) => vault.path === vaultPath) ?? null
}

/**
 * Which vault, if any, has already inherited the legacy global CRDT store.
 */
export function getLegacyCrdtStoreClaim(): string | undefined {
  return store.get('crdtStore').legacyStoreClaimedBy
}

/**
 * Record that `vaultUuid` owns the legacy global CRDT store.
 *
 * Written BEFORE the directory is moved, on purpose: a crash between the two
 * leaves a claim with the move unfinished, which the same vault resumes on its
 * next launch. The reverse order would leave the store movable by whichever
 * vault opened next, which is exactly the cross-vault history bleed per-vault
 * scoping exists to prevent.
 *
 * `partitionPending` rides along in the SAME write rather than in a second one:
 * a claim recorded without its pending partition would move a store this vault
 * cannot fully own and never revisit it.
 */
export function recordLegacyCrdtStoreClaim(
  vaultUuid: string,
  options?: { partitionPending?: boolean }
): void {
  store.set('crdtStore', {
    ...store.get('crdtStore'),
    legacyStoreClaimedBy: vaultUuid,
    legacyStoreClaimedAt: Date.now(),
    ...(options?.partitionPending ? { legacyStorePartitionPendingFor: vaultUuid } : {})
  })
}

/**
 * Which vault, if any, still owes its inherited legacy store a partition pass.
 */
export function getLegacyCrdtStorePartitionPending(): string | undefined {
  return store.get('crdtStore').legacyStorePartitionPendingFor
}

/**
 * Record that the partition pass has completed, so it is not run again.
 *
 * Cleared only after a full pass: a partial pass leaves the flag set and is
 * simply re-run, which is safe because setting a document aside is idempotent.
 */
export function clearLegacyCrdtStorePartitionPending(): void {
  const current = store.get('crdtStore')
  if (current.legacyStorePartitionPendingFor === undefined) return
  const { legacyStorePartitionPendingFor: _cleared, ...rest } = current
  store.set('crdtStore', rest)
}

/**
 * Which directory, if any, still holds `vaultUuid`'s CRDT store under the name
 * it had before this vault adopted that uuid.
 */
export function getPendingCrdtStoreRename(vaultUuid: string): string | undefined {
  return store.get('crdtStore').pendingRenames?.[vaultUuid]
}

/**
 * Record that the store named after `from` now belongs to the vault identified
 * as `to`.
 *
 * Written BEFORE the uuid itself is rewritten, for the same reason the legacy
 * claim is written before its move: the failure that matters is a crash between
 * the two. Recorded-but-not-rewritten leaves an entry for a uuid no vault has,
 * which is inert and is re-recorded identically when the link is retried;
 * rewritten-but-not-recorded is the orphan this exists to prevent.
 *
 * A uuid that changes twice before the store is next opened (link, unlink,
 * relink) must still name the directory that was actually written, so a chain
 * collapses onto its origin rather than pointing at a middle name no directory
 * ever had. Adopting back to where the store already sits cancels the rename
 * outright.
 *
 * The legacy claim and the partition it owes name a vault by uuid too, and that
 * uuid is exactly what is changing — so they move with it, in the same write.
 * Left behind they would name nobody: the legacy store could never be inherited
 * and its ambiguous documents could never be set aside.
 */
export function recordCrdtStoreRename(from: string, to: string): void {
  const current = store.get('crdtStore')
  const pending = { ...(current.pendingRenames ?? {}) }

  const origin = pending[from] ?? from
  delete pending[from]
  if (origin === to) {
    delete pending[to]
  } else {
    pending[to] = origin
  }

  store.set('crdtStore', {
    ...current,
    pendingRenames: pending,
    ...(current.legacyStoreClaimedBy === from ? { legacyStoreClaimedBy: to } : {}),
    ...(current.legacyStorePartitionPendingFor === from
      ? { legacyStorePartitionPendingFor: to }
      : {})
  })
}

/**
 * Record that `vaultUuid`'s store now sits under its own name.
 *
 * Cleared only once the directory is where it belongs (or provably never
 * existed), so an interrupted move is simply retried on the next open.
 */
export function clearPendingCrdtStoreRename(vaultUuid: string): void {
  const current = store.get('crdtStore')
  if (current.pendingRenames?.[vaultUuid] === undefined) return
  const { [vaultUuid]: _settled, ...rest } = current.pendingRenames
  store.set('crdtStore', { ...current, pendingRenames: rest })
}

/**
 * How many launches in a row have had no on-disk CRDT store. 0 = healthy.
 */
export function getCrdtInMemorySessions(): number {
  return store.get('crdtStore').inMemorySessions ?? 0
}

/**
 * Record this launch's CRDT persistence outcome and return the resulting streak.
 *
 * Idempotent when nothing changed (a healthy install at 0 writes no config), so
 * the common path costs a read.
 */
export function recordCrdtPersistenceOutcome(healthy: boolean): number {
  const current = store.get('crdtStore')
  const previous = current.inMemorySessions ?? 0
  const next = healthy ? 0 : previous + 1
  if (next !== previous) {
    store.set('crdtStore', { ...current, inMemorySessions: next })
  }
  return next
}

/**
 * Get the persisted auto-updater preferences.
 */
export function getUpdaterPrefs(): UpdaterStoreData {
  return store.get('updater')
}

/**
 * Persist the display version the user skipped (or clear it with null).
 */
export function setSkippedVersion(version: string | null): void {
  store.set('updater', { ...store.get('updater'), skippedVersion: version ?? undefined })
}

/**
 * Persist whether updates download + install automatically.
 */
export function setAutoDownloadPref(enabled: boolean): void {
  store.set('updater', { ...store.get('updater'), autoDownload: enabled })
}

/**
 * Persist whether the app checks for updates automatically (launch + interval).
 */
export function setAutoCheckPref(enabled: boolean): void {
  store.set('updater', { ...store.get('updater'), autoCheck: enabled })
}

/**
 * Update the lastOpened timestamp for a vault
 */
export function touchVault(vaultPath: string): void {
  const vault = findVault(vaultPath)
  if (vault) {
    upsertVault({
      ...vault,
      lastOpened: new Date().toISOString()
    })
  }
}
