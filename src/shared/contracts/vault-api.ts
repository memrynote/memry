/**
 * Vault Management IPC API Contract
 *
 * Handles vault selection, loading, and configuration.
 * All operations run in the main process.
 */

import { z } from 'zod';

// Import and re-export channels from shared (single source of truth)
import { VaultChannels } from '../ipc-channels';
export { VaultChannels };

// ============================================================================
// Types
// ============================================================================

export interface VaultInfo {
  path: string;
  name: string;
  noteCount: number;
  taskCount: number;
  lastOpened: string;
  isDefault: boolean;
}

export interface VaultStatus {
  isOpen: boolean;
  path: string | null;
  isIndexing: boolean;
  indexProgress: number; // 0-100
  error: string | null;
}

export interface VaultConfig {
  excludePatterns: string[];
  defaultNoteFolder: string;
  journalFolder: string;
  attachmentsFolder: string;
}

// ============================================================================
// Request Schemas (validated at IPC boundary)
// ============================================================================

export const SelectVaultSchema = z.object({
  path: z.string().optional(), // If not provided, shows folder picker
});

export const CreateVaultSchema = z.object({
  path: z.string(),
  name: z.string().min(1).max(100),
});

export const UpdateVaultConfigSchema = z.object({
  excludePatterns: z.array(z.string()).optional(),
  defaultNoteFolder: z.string().optional(),
  journalFolder: z.string().optional(),
  attachmentsFolder: z.string().optional(),
});

// ============================================================================
// Response Types
// ============================================================================

export interface SelectVaultResponse {
  success: boolean;
  vault: VaultInfo | null;
  error?: string;
}

export interface GetVaultsResponse {
  vaults: VaultInfo[];
  currentVault: string | null;
}

// ============================================================================
// Handler Signatures (for main process implementation)
// ============================================================================

export interface VaultHandlers {
  [VaultChannels.invoke.SELECT]: (
    input: z.infer<typeof SelectVaultSchema>
  ) => Promise<SelectVaultResponse>;

  [VaultChannels.invoke.CREATE]: (
    input: z.infer<typeof CreateVaultSchema>
  ) => Promise<SelectVaultResponse>;

  [VaultChannels.invoke.GET_ALL]: () => Promise<GetVaultsResponse>;

  [VaultChannels.invoke.GET_STATUS]: () => Promise<VaultStatus>;

  [VaultChannels.invoke.GET_CONFIG]: () => Promise<VaultConfig>;

  [VaultChannels.invoke.UPDATE_CONFIG]: (
    input: z.infer<typeof UpdateVaultConfigSchema>
  ) => Promise<VaultConfig>;

  [VaultChannels.invoke.CLOSE]: () => Promise<void>;

  [VaultChannels.invoke.SWITCH]: (vaultPath: string) => Promise<SelectVaultResponse>;

  [VaultChannels.invoke.REMOVE]: (vaultPath: string) => Promise<void>;

  [VaultChannels.invoke.REINDEX]: () => Promise<void>;
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
  select(path?: string): Promise<SelectVaultResponse>;
  create(path: string, name: string): Promise<SelectVaultResponse>;
  getAll(): Promise<GetVaultsResponse>;
  getStatus(): Promise<VaultStatus>;
  getConfig(): Promise<VaultConfig>;
  updateConfig(config: Partial<VaultConfig>): Promise<VaultConfig>;
  close(): Promise<void>;
  switch(vaultPath: string): Promise<SelectVaultResponse>;
  remove(vaultPath: string): Promise<void>;
  reindex(): Promise<void>;
}
