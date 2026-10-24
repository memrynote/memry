/**
 * localStorage key for the Collections tree's expanded folders.
 *
 * Folder ids only mean something inside their own vault, so each vault keeps
 * its own set. Builds before this stored one device-wide key and wiped it on
 * every vault switch: the tree under a switch cover then opened fully
 * collapsed while the snapshot above it still showed the folders open.
 */

const LEGACY_KEY = 'sidebar-tree-expanded'

/**
 * The key for `vaultPath`. The first vault to ask after an upgrade claims the
 * legacy device-wide set: that set was written by the vault open at the time,
 * which is the one the app reopens on launch. Outside a vault workspace the
 * legacy key is used as is.
 */
export function sidebarTreeExpandedKey(vaultPath: string | null): string {
  if (!vaultPath) return LEGACY_KEY
  const key = `${LEGACY_KEY}:${vaultPath}`
  try {
    if (localStorage.getItem(key) === null) {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy !== null) {
        localStorage.setItem(key, legacy)
        localStorage.removeItem(LEGACY_KEY)
      }
    }
  } catch {
    // Storage unavailable: the tree starts collapsed, as it would with no entry.
  }
  return key
}
