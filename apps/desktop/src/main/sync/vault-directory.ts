import fs from 'fs'
import path from 'path'

import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'
import { VaultChannels } from '@memry/contracts/ipc-channels'
import {
  VaultIconSchema,
  type AccountVaultInfo,
  type SelectVaultResponse
} from '@memry/contracts/vault-api'

import { retrieveKey, secureCleanup } from '../crypto'
import { deriveKey } from '../crypto/keys'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { isValidDirectory } from '../vault/init'
import { readVaultIcon, writeVaultIcon } from '../vault/vault-icon'
import { defaultVaultParentDir as defaultParentDir } from '../vault/default-parent'
import {
  getAccountVaultsCache,
  getCurrentVaultPath,
  getVaults,
  removeVault as removeVaultFromStore,
  setAccountVaultsCache,
  upsertVault
} from '../store'
import { abandonBootstrap, beginBootstrap, markBootstrapInteractive } from './bootstrap-metrics'
import { deleteFromServer, getFromServer, postToServer, putToServer } from './http-client'
import { getValidAccessToken } from './token-manager'
import { getSignedInUserId } from './vault-account-binding'
import {
  decryptVaultIcon,
  decryptVaultName,
  encryptVaultIcon,
  encryptVaultName
} from './vault-name-crypto'

const log = createLogger('VaultDirectory')

const REFRESH_THROTTLE_MS = 30_000

interface ServerVaultEntry {
  vaultUuid: string
  itemCount: number
  createdAt: number | null
  encryptedName: string | null
  nameNonce: string | null
  /** Absent from servers that predate vault icons. */
  encryptedIcon?: string | null
  iconNonce?: string | null
  iconUpdatedAt?: number | null
}

let lastRefreshAt = 0

export function __resetThrottleForTests(): void {
  lastRefreshAt = 0
}

async function getNameKey(): Promise<Uint8Array | null> {
  const masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
  if (!masterKey) return null
  try {
    return await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
  } finally {
    secureCleanup(masterKey)
  }
}

/**
 * Fetch the account vault list, decrypt names, cache for the switcher, and
 * self-register any local vault the server does not know (or knows under a
 * stale name). Covers sign-in with pre-existing local vaults, vaults created
 * while signed in, and folder renames — all through the same diff.
 */
export async function refreshVaultDirectory(opts?: { force?: boolean }): Promise<void> {
  if (!opts?.force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return

  const token = await getValidAccessToken()
  if (!token) return
  const nameKey = await getNameKey()
  if (!nameKey) return

  try {
    const { vaults } = await getFromServer<{ vaults: ServerVaultEntry[] }>('/sync/vaults', token)
    lastRefreshAt = Date.now()

    const remote = vaults.map((v) => ({
      vaultUuid: v.vaultUuid,
      name:
        v.encryptedName && v.nameNonce
          ? decryptVaultName(v.encryptedName, v.nameNonce, nameKey, v.vaultUuid)
          : null,
      itemCount: v.itemCount,
      createdAt: v.createdAt
    }))
    setAccountVaultsCache({ fetchedAt: Date.now(), vaults: remote })

    const remoteByUuid = new Map(remote.map((v) => [v.vaultUuid, v]))
    const serverByUuid = new Map(vaults.map((v) => [v.vaultUuid, v]))
    const userId = await getSignedInUserId()
    let iconsChanged = false
    for (const local of getVaults()) {
      if (!local.vaultUuid) continue
      // Only vaults this account syncs. The list is every folder ever opened on
      // this machine, including another account's vaults left behind by a
      // sign-out; registering those would hand their names and a vault slot to
      // whoever signed in next. Unbound vaults register once they bind.
      const binding = local.accountBinding
      if (!userId || binding?.mode !== 'sync' || binding.userId !== userId) continue
      const entry = remoteByUuid.get(local.vaultUuid)
      if (!entry || entry.name !== local.name) {
        const { encryptedName, nameNonce } = encryptVaultName(local.name, nameKey, local.vaultUuid)
        try {
          await postToServer(
            '/sync/vaults',
            { vaultUuid: local.vaultUuid, encryptedName, nameNonce },
            token
          )
        } catch (err) {
          // 402 (free plan / vault limit) is expected here — registration retries
          // on the next refresh once entitlements change.
          log.info('Vault self-registration skipped', { vaultUuid: local.vaultUuid, err })
        }
      }
      const server = serverByUuid.get(local.vaultUuid)
      if (await syncVaultIcon(local.path, local.vaultUuid, server, nameKey, token)) {
        iconsChanged = true
      }
    }
    if (iconsChanged) broadcastToAllWindows(VaultChannels.events.LIST_CHANGED)
  } catch (err) {
    log.warn('Vault directory refresh failed', err)
  } finally {
    secureCleanup(nameKey)
  }
}

/**
 * Reconcile one local vault's icon with the account copy, last writer wins on
 * the change time. A local change not yet accepted is pushed; a newer account
 * copy is adopted into the vault's config.json. Returns true when the local
 * icon changed. Failures leave the pending change for the next refresh.
 */
async function syncVaultIcon(
  vaultPath: string,
  vaultUuid: string,
  server: ServerVaultEntry | undefined,
  key: Uint8Array,
  token: string
): Promise<boolean> {
  if (!isValidDirectory(vaultPath)) return false
  const local = readVaultIcon(vaultPath)
  const remoteAt = server?.iconUpdatedAt ?? null

  if (local?.pendingSync && (remoteAt === null || local.updatedAt > remoteAt)) {
    const sealed =
      local.value === null
        ? { encryptedIcon: null, iconNonce: null }
        : encryptVaultIcon(local.value, key, vaultUuid)
    try {
      await putToServer(
        `/sync/vaults/${encodeURIComponent(vaultUuid)}/icon`,
        { ...sealed, iconUpdatedAt: local.updatedAt },
        token
      )
    } catch (err) {
      // 402, 404 (not registered yet, or a server without icon support) and
      // network errors: the change stays pending and retries on the next refresh.
      log.info('Vault icon push skipped', { vaultUuid, err })
      return false
    }
    // A stale write the server refused (applied: false) is adopted from the
    // account copy on the next refresh. The user may have changed the icon
    // again while the request was in flight: only clear the flag for this change.
    const current = readVaultIcon(vaultPath)
    if (current && current.updatedAt === local.updatedAt) {
      writeVaultIcon(vaultPath, { ...current, pendingSync: false })
    }
    return false
  }

  if (remoteAt !== null && remoteAt > (local?.updatedAt ?? -1)) {
    let value: string | null = null
    if (server?.encryptedIcon && server.iconNonce) {
      value = decryptVaultIcon(server.encryptedIcon, server.iconNonce, key, vaultUuid)
      // Undecryptable, or a format this version cannot draw: keep the local
      // icon rather than clearing it.
      if (value === null || !VaultIconSchema.safeParse(value).success) return false
    }
    writeVaultIcon(vaultPath, { value, updatedAt: remoteAt, pendingSync: false })
    return true
  }

  if (local?.pendingSync) {
    // Same change time on both sides: the account already has this change.
    writeVaultIcon(vaultPath, { ...local, pendingSync: false })
  }
  return false
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function suggestVaultFolder(
  vault: { vaultUuid: string; name: string | null },
  parent: string = defaultParentDir()
): string {
  const fallback = `memry-vault-${vault.vaultUuid.slice(0, 8)}`
  const base = (vault.name ? slugify(vault.name) : '') || fallback
  let candidate = path.join(parent, base)
  let suffix = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base}-${suffix++}`)
  }
  return candidate
}

export function listAccountVaults(): AccountVaultInfo[] {
  const cache = getAccountVaultsCache()
  const localByUuid = new Map(
    getVaults()
      .filter((v) => v.vaultUuid)
      .map((v) => [v.vaultUuid as string, v])
  )
  return (cache?.vaults ?? []).map((v) => ({
    vaultUuid: v.vaultUuid,
    name: v.name,
    itemCount: v.itemCount,
    createdAt: v.createdAt,
    localPath: localByUuid.get(v.vaultUuid)?.path ?? null,
    suggestedPath: suggestVaultFolder(v)
  }))
}

/**
 * Purge a vault from the sync account and drop its local list entry.
 *
 * Both halves always run together: refreshVaultDirectory self-registers every
 * local vault, so a server-only delete would resurrect itself on the next
 * refresh. Files on disk are never touched.
 */
export async function deleteAccountVault(vaultUuid: string): Promise<void> {
  const local = getVaults().find((v) => v.vaultUuid === vaultUuid)
  if (local && local.path === getCurrentVaultPath()) {
    throw new Error('Cannot delete the active vault. Switch to another vault first.')
  }

  const token = await getValidAccessToken()
  if (!token) {
    throw new Error('Sign in to delete a vault from your account.')
  }

  await deleteFromServer(`/sync/vaults/${encodeURIComponent(vaultUuid)}`, token)

  if (local) removeVaultFromStore(local.path)

  log.info('Vault deleted from account', { vaultUuid, hadLocalCopy: !!local })
}

export async function downloadRemoteVault(input: {
  vaultUuid: string
  parentPath?: string
}): Promise<SelectVaultResponse> {
  const { selectVault } = await import('../vault')

  const existing = getVaults().find((v) => v.vaultUuid === input.vaultUuid)
  if (existing) return selectVault({ path: existing.path })

  // A cloud-only vault materializing locally IS the fresh-device bootstrap:
  // open the measurement window before any provisioning work happens (#1835).
  beginBootstrap('vault_download')

  // Everything past this point can fail (mkdir, provisioning, opening the
  // vault). The window is module-global and one-shot: a download that dies
  // here must close it, or steady-state bytes pollute a window whose t0
  // describes a download that never happened.
  try {
    const cached = getAccountVaultsCache()?.vaults.find((v) => v.vaultUuid === input.vaultUuid)
    const parent = input.parentPath ?? defaultParentDir()
    fs.mkdirSync(parent, { recursive: true })
    const folder = suggestVaultFolder(
      { vaultUuid: input.vaultUuid, name: cached?.name ?? null },
      parent
    )

    const { createDormantVault } = await import('./vault-provisioning')
    createDormantVault(folder, input.vaultUuid)
    // createDormantVault repoints the data.db singleton — open the new vault now
    // so the singleton ends on the vault the user is actually in.
    const result = await selectVault({ path: folder })
    if (!result.success) {
      // The vault did not open — there is no bootstrap to measure and no
      // interactive mark to fire.
      abandonBootstrap()
      return result
    }
    markBootstrapInteractive()

    // selectVault stamps the uuid best-effort from the data.db; here the uuid is
    // known authoritatively, and losing (or keeping a stale foreign) uuid means
    // the next Download of this vault mints yet another empty folder. Enforce it
    // on the registry row.
    const row = getVaults().find((v) => v.path === folder)
    if (row && row.vaultUuid !== input.vaultUuid) {
      upsertVault({ ...row, vaultUuid: input.vaultUuid })
    }

    return result
  } catch (error) {
    abandonBootstrap()
    throw error
  }
}
