// The vault commands of the app, called through the page like the renderer calls them. Specs
// use these for the lifecycle and read the UI for what a user sees.
import type { Page } from './pw-compat/page'

declare global {
  interface Window {
    __TAURI__: { core: { invoke(command: string, args?: unknown): Promise<unknown> } }
  }
}

export interface VaultInfo {
  path: string
  name: string
  isDefault: boolean
  isMissing?: boolean
  accentColor?: string
  icon?: string
}

export interface VaultStatus {
  isOpen: boolean
  path: string | null
  error: string | null
}

export interface SelectResponse {
  success: boolean
  vault: VaultInfo | null
  error?: string
  errorCode?: 'already-exists' | 'invalid-name'
}

export interface VaultList {
  vaults: VaultInfo[]
  currentVault: string | null
}

/** Calls a command. A rejection becomes a thrown error carrying the serialized `CommandError`. */
export function invoke<T>(
  page: Page,
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  return page.evaluate(
    ([name, params]: [string, Record<string, unknown>]) =>
      window.__TAURI__.core.invoke(name, params),
    [command, args]
  ) as Promise<T>
}

export const vaultStatus = (page: Page) => invoke<VaultStatus>(page, 'vault_get_status')
export const vaultList = (page: Page) => invoke<VaultList>(page, 'vault_list')
