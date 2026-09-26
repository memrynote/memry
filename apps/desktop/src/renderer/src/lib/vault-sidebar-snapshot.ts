/**
 * Sidebar snapshots per vault
 *
 * Only one vault is open at a time: main owns a single set of databases,
 * watcher and sync runtime. So while the user swipes, the neighbouring vault
 * has no live data to render. What it does have is the sidebar it drew the last
 * time it was open. That markup is kept here, keyed by vault path, and painted
 * as a static, inert page: during the swipe, in the gap while main switches,
 * and over the incoming sidebar until its queries have loaded.
 *
 * Persisted to localStorage so a vault visited in an earlier session still
 * previews. The markup is the app's own rendered DOM (React-escaped text), but
 * it is sanitized anyway before it is stored or injected.
 */

import type { CSSProperties } from 'react'

const STORAGE_PREFIX = 'vault-sidebar-snapshot:'
/** Snapshots above this stay in memory only, so one huge tree cannot eat the origin's quota. */
const MAX_PERSISTED_CHARS = 256 * 1024

/** `data-snapshot-exclude` marks overlays that sit inside a captured subtree but are not part of it. */
const REMOVED_ELEMENTS =
  'script, iframe, object, embed, link, style, template, [data-snapshot-exclude]'
const REMOVED_ATTRIBUTES = new Set([
  'id',
  'tabindex',
  'autofocus',
  'contenteditable',
  'data-tour',
  'data-testid',
  'aria-describedby',
  'aria-labelledby',
  'aria-controls'
])

const memory = new Map<string, string>()

/**
 * Serialize `root`'s children as inert markup: no scripts, no handlers, no
 * focus targets, and no ids or tour anchors that would duplicate live ones.
 */
export function serializeSidebarSnapshot(root: Element): string {
  const clone = root.cloneNode(true) as Element
  for (const el of clone.querySelectorAll(REMOVED_ELEMENTS)) el.remove()
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (
        name.startsWith('on') ||
        REMOVED_ATTRIBUTES.has(name) ||
        ((name === 'href' || name === 'src' || name === 'xlink:href') &&
          /^\s*javascript:/i.test(attr.value))
      ) {
        el.removeAttribute(attr.name)
      }
    }
  }
  return clone.innerHTML
}

/** Record `root` as the sidebar of `vaultPath`. */
export function captureVaultSidebarSnapshot(vaultPath: string, root: Element): void {
  const html = serializeSidebarSnapshot(root)
  if (!html) return
  memory.set(vaultPath, html)
  try {
    if (html.length <= MAX_PERSISTED_CHARS) {
      localStorage.setItem(STORAGE_PREFIX + vaultPath, html)
    } else {
      localStorage.removeItem(STORAGE_PREFIX + vaultPath)
    }
  } catch {
    // Quota or disabled storage: the in-memory copy still serves this session.
  }
}

export function getVaultSidebarSnapshot(vaultPath: string): string | null {
  const cached = memory.get(vaultPath)
  if (cached !== undefined) return cached
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + vaultPath)
    if (stored) memory.set(vaultPath, stored)
    return stored
  } catch {
    return null
  }
}

/** Drop a vault's snapshot, e.g. when the vault is forgotten. */
export function clearVaultSidebarSnapshot(vaultPath: string): void {
  memory.delete(vaultPath)
  try {
    localStorage.removeItem(STORAGE_PREFIX + vaultPath)
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** Test-only reset of the in-memory copies. */
export function resetVaultSidebarSnapshots(): void {
  memory.clear()
}

/**
 * The tint tokens for a subtree painted in another vault's accent. The derived
 * tokens are resolved where they are declared (`:root`), so overriding
 * `--tint` alone would leave them on the open vault's colour.
 */
export function vaultTintStyle(accent: string): CSSProperties {
  return {
    '--user-accent-color': accent,
    '--tint': accent,
    '--tint-hover': `color-mix(in srgb, ${accent} 85%, black)`,
    '--tint-light': `color-mix(in srgb, ${accent} 15%, transparent)`,
    '--tint-lighter': `color-mix(in srgb, ${accent} 10%, transparent)`,
    '--tint-muted': `color-mix(in srgb, ${accent} 50%, transparent)`,
    '--tint-ring': `color-mix(in srgb, ${accent} 30%, transparent)`,
    '--tint-border': `color-mix(in srgb, ${accent} 50%, transparent)`
  } as CSSProperties
}
