/** Seam 6 — locating and provisioning vault roots. */
export interface LocalVault {
  vaultId: string
  root: string
}

export interface VaultDirectoryAdapter {
  resolveVaultRoot(vaultId: string): Promise<string>
  listLocalVaults(): Promise<LocalVault[]>
  /**
   * New-device path. Must not dead-end: the vault picker's "primary folder was
   * never provisioned" failure is exactly what this contract exists to forbid.
   */
  provision(vaultId: string): Promise<string>
}
