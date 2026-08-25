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
  path: z.string(),
  name: z.string().min(1).max(100)
})

export const DownloadRemoteVaultSchema = z.object({
  vaultUuid: z.string().min(1),
  parentPath: z.string().optional()
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
  create(path: string, name: string): Promise<SelectVaultResponse>
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
  resolveEmbeds(input: ResolveEmbedsInput): Promise<ResolvedEmbeds>
}
