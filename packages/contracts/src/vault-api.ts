/**
 * Vault Management IPC API Contract
 *
 * Handles vault selection, loading, and configuration.
 * All operations run in the main process.
 */

import { z } from 'zod'

// Import and re-export channels from the contract-local surface.
import { VaultChannels } from './ipc-channels'
export { VaultChannels }

// ============================================================================
// Types
// ============================================================================

export interface VaultInfo {
  path: string
  name: string
  noteCount: number
  taskCount: number
  lastOpened: string
  isDefault: boolean
  /** Server vault uuid; stamped when the vault is opened while sync is set up */
  vaultUuid?: string
  /**
   * The folder is not reachable on this machine right now: deleted, or on a
   * drive or share that is not mounted. Set by `vault:get-all` only; the entry
   * stays registered until the user forgets it.
   */
  isMissing?: boolean
  /**
   * The vault's own accent (`#rrggbb`), read from its config.json. Set by
   * `vault:get-all` only, and absent for missing folders; consumers fall back
   * to the default tint.
   */
  accentColor?: string
  /**
   * The vault's own icon (`icon:<HugeiconName>` or an emoji), read from its
   * config.json. Set by `vault:get-all` only; absent when never set, reset, or
   * the folder is missing, and consumers draw the default icon.
   */
  icon?: string
}

export interface AccountVaultInfo {
  vaultUuid: string
  /** Decrypted display name; null when absent or undecryptable */
  name: string | null
  itemCount: number
  createdAt: number | null
  /** Path of the local copy, null when the vault is cloud-only */
  localPath: string | null
  /** Default destination folder for download */
  suggestedPath: string
}

export interface VaultStatus {
  isOpen: boolean
  path: string | null
  isIndexing: boolean
  indexProgress: number // 0-100
  /** Files already visited by the in-flight background index build. Absent outside a build. */
  indexBuilt?: number
  /** Total files the in-flight background index build will visit. Absent outside a build. */
  indexTotal?: number
  error: string | null
}

export interface VaultConfig {
  excludePatterns: string[]
  /** Default folder for newly created notes; '' = vault root */
  defaultNoteFolder: string
  journalFolder: string
  /** Configurable date format for journal filenames (e.g. 'YYYY-MM-DD') */
  journalDateFormat: string
  attachmentsFolder: string
}

// ============================================================================
// Request Schemas (validated at IPC boundary)
// ============================================================================

export const SelectVaultSchema = z.object({
  path: z.string().optional() // If not provided, shows folder picker
})

export const CreateVaultSchema = z.object({
  /** Parent folder; the vault folder `<path>/<name>` is created inside it */
  path: z.string().min(1),
  name: z.string().trim().min(1).max(100)
})

export const DownloadRemoteVaultSchema = z.object({
  vaultUuid: z.string().min(1),
  parentPath: z.string().optional()
})

/**
 * A vault icon: a Hugeicons library icon (`icon:<Name>`) or an emoji. Uploaded
 * `custom:` icons are refused: their image lives in one vault, while a vault
 * icon is drawn for every vault in the list and synced account-wide.
 */
export const VaultIconSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) =>
    value.startsWith('icon:')
      ? /^icon:[A-Za-z0-9]+$/.test(value)
      : !value.startsWith('custom:') && value.length <= 32 && !/[\s\p{Cc}]/u.test(value)
  )

export const SetVaultIconSchema = z.object({
  path: z.string().min(1),
  /** null resets to the default icon. */
  icon: VaultIconSchema.nullable()
})

export const UpdateVaultConfigSchema = z.object({
  excludePatterns: z.array(z.string()).optional(),
  defaultNoteFolder: z.string().optional(),
  journalFolder: z.string().optional(),
  journalDateFormat: z.string().optional(),
  attachmentsFolder: z.string().optional()
})

// ============================================================================
// Response Types
// ============================================================================

export interface SelectVaultResponse {
  success: boolean
  vault: VaultInfo | null
  error?: string
  /** Machine-readable failure reason; absent on success and on older builds */
  errorCode?: 'already-exists' | 'invalid-name'
}

export interface GetVaultsResponse {
  vaults: VaultInfo[]
  currentVault: string | null
}

// ============================================================================
// Handler Signatures (for main process implementation)
// ============================================================================

/**
 * Embed target → loadable `memry-file://` URL. Targets that do not resolve to a
 * file inside the vault are omitted, so callers can leave those embeds as the
 * author wrote them instead of rendering a broken image.
 */
export type ResolvedEmbeds = Record<string, string>

/**
 * `notePath` (vault-relative) makes the resolver return targets relative to that
 * note, which is what keeps the rewritten markdown portable when the note is
 * saved back. Omit it only on read-only surfaces that never persist what they
 * render; those get absolute `memry-file://` URLs instead.
 */
export interface ResolveEmbedsInput {
  refs: string[]
  notePath?: string
}

export interface VaultHandlers {
  [VaultChannels.invoke.SELECT]: (
    input: z.infer<typeof SelectVaultSchema>
  ) => Promise<SelectVaultResponse>

  [VaultChannels.invoke.CREATE]: (
    input: z.infer<typeof CreateVaultSchema>
  ) => Promise<SelectVaultResponse>

  [VaultChannels.invoke.GET_DEFAULT_PARENT]: () => Promise<string>

  [VaultChannels.invoke.GET_ALL]: () => Promise<GetVaultsResponse>

  [VaultChannels.invoke.GET_STATUS]: () => Promise<VaultStatus>

  [VaultChannels.invoke.GET_CONFIG]: () => Promise<VaultConfig>

  [VaultChannels.invoke.UPDATE_CONFIG]: (
    input: z.infer<typeof UpdateVaultConfigSchema>
  ) => Promise<VaultConfig>

  [VaultChannels.invoke.CLOSE]: () => Promise<void>

  [VaultChannels.invoke.SWITCH]: (vaultPath: string) => Promise<SelectVaultResponse>

  [VaultChannels.invoke.REMOVE]: (vaultPath: string) => Promise<void>

  [VaultChannels.invoke.REINDEX]: () => Promise<void>

  [VaultChannels.invoke.REVEAL]: () => Promise<void>

  [VaultChannels.invoke.LIST_ACCOUNT]: () => Promise<AccountVaultInfo[]>

  [VaultChannels.invoke.DOWNLOAD_REMOTE]: (
    input: z.infer<typeof DownloadRemoteVaultSchema>
  ) => Promise<SelectVaultResponse>

  [VaultChannels.invoke.DELETE_FROM_ACCOUNT]: (vaultUuid: string) => Promise<void>

  [VaultChannels.invoke.SET_ICON]: (input: z.infer<typeof SetVaultIconSchema>) => Promise<void>

  [VaultChannels.invoke.RESOLVE_EMBEDS]: (input: ResolveEmbedsInput) => Promise<ResolvedEmbeds>
}

// ============================================================================
// Client API (for renderer process)
// ============================================================================

/**
 * Vault service client interface for renderer process
 *
 * @example
 * ```typescript
 * const vault = window.api.vault;
 *
 * // Select a vault
 * const result = await vault.select();
 * if (result.success) {
 *   console.log('Opened vault:', result.vault.name);
 * }
 *
 * // Listen for status changes
 * window.api.on('vault:status-changed', (status) => {
 *   setVaultStatus(status);
 * });
 * ```
 */
export interface VaultClientAPI {
  select(path?: string): Promise<SelectVaultResponse>
  /** Create `<parentPath>/<name>` and open it */
  create(parentPath: string, name: string): Promise<SelectVaultResponse>
  getDefaultParent(): Promise<string>
  getAll(): Promise<GetVaultsResponse>
  getStatus(): Promise<VaultStatus>
  getConfig(): Promise<VaultConfig>
  updateConfig(config: Partial<VaultConfig>): Promise<VaultConfig>
  close(): Promise<void>
  switch(vaultPath: string): Promise<SelectVaultResponse>
  remove(vaultPath: string): Promise<void>
  reindex(): Promise<void>
  reveal(): Promise<void>
  listAccount(): Promise<AccountVaultInfo[]>
  downloadRemote(vaultUuid: string, parentPath?: string): Promise<SelectVaultResponse>
  deleteFromAccount(vaultUuid: string): Promise<void>
  setIcon(path: string, icon: string | null): Promise<void>
  resolveEmbeds(input: ResolveEmbedsInput): Promise<ResolvedEmbeds>
}
