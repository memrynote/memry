import type { CustomTheme } from '@memry/contracts/themes-api'
import { getStatus } from '../../vault/index'
import { writeThemeFile, renameThemeFile, deleteThemeFile } from '../../vault/themes'

/**
 * Vault-file side effects for theme sync applies. No-ops when no vault is
 * open (DB row still lands; the file is rewritten on the next local edit).
 */
export function applyThemeFile(slug: string, theme: CustomTheme, previousSlug?: string): void {
  const vaultPath = getStatus().path
  if (!vaultPath) return
  if (previousSlug && previousSlug !== slug) {
    renameThemeFile(vaultPath, previousSlug, slug)
  }
  writeThemeFile(vaultPath, slug, theme)
}

export function removeThemeFile(slug: string): void {
  const vaultPath = getStatus().path
  if (!vaultPath) return
  deleteThemeFile(vaultPath, slug)
}
