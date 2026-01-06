/**
 * Vault Management IPC API Contract
 *
 * Handles vault selection, loading, and configuration.
 * All operations run in the main process.
 */

import { z } from 'zod';

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
// IPC Channel Definitions
// ============================================================================

/**
 * IPC Channels for Vault operations
 *
 * invoke = request/response (ipcRenderer.invoke → ipcMain.handle)
 * on = one-way event (main → renderer via webContents.send)
 */
export const VaultChannels = {
  // Request/Response channels
  invoke: {
    /** Show folder picker and select vault */
    SELECT: 'vault:select',

    /** Create a new vault at specified path */
    CREATE: 'vault:create',

    /** Get list of known vaults */
    GET_ALL: 'vault:get-all',

    /** Get current vault status */
    GET_STATUS: 'vault:get-status',

    /** Get vault configuration */
    GET_CONFIG: 'vault:get-config',

    /** Update vault configuration */
    UPDATE_CONFIG: 'vault:update-config',

    /** Close current vault */
    CLOSE: 'vault:close',

    /** Switch to a different vault */
    SWITCH: 'vault:switch',

    /** Remove vault from known list (doesn't delete files) */
    REMOVE: 'vault:remove',

    /** Trigger manual reindex */
    REINDEX: 'vault:reindex',
  },

  // Event channels (main → renderer)
  events: {
    /** Vault status changed */
    STATUS_CHANGED: 'vault:status-changed',

    /** Indexing progress update */
    INDEX_PROGRESS: 'vault:index-progress',

    /** Vault error occurred */
    ERROR: 'vault:error',
  },
} as const;

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
