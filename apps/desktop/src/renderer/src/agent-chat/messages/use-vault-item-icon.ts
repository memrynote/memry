import { useEffect, useState } from 'react'

/**
 * Resolves an item's own icon straight from the vault, keyed by the id inside
 * a memry:// href. The backend pipeline (tool results → model text → source
 * refs) only carries icons as best-effort hints; the vault is the source of
 * truth, and this works even while a turn is still streaming.
 *
 * A single agent session can link an unbounded number of distinct notes, so the
 * cache is capped (least recently used first out) and entries go stale, rather
 * than pinning one promise per note for the lifetime of the window and serving
 * the icon a user has since changed.
 */
export const ICON_CACHE_LIMIT = 128
export const ICON_CACHE_TTL_MS = 5 * 60_000

interface CachedIcon {
  pending: Promise<string | null>
  cachedAt: number
}

const iconCache = new Map<string, CachedIcon>()

type VaultIconKind = 'note'

async function fetchIcon(kind: VaultIconKind, id: string): Promise<string | null> {
  if (kind === 'note') {
    const note = await window.api?.notes?.get?.(id)
    return note?.emoji ?? null
  }
  return null
}

/** A Map iterates in insertion order, so its leading keys are the least recently used. */
function evictOverflow(): void {
  for (const key of iconCache.keys()) {
    if (iconCache.size <= ICON_CACHE_LIMIT) break
    iconCache.delete(key)
  }
}

export function lookupVaultItemIcon(
  kind: string | undefined,
  id: string | undefined
): Promise<string | null> {
  if (kind !== 'note' || !id) return Promise.resolve(null)
  const key = `${kind}:${id}`
  const cached = iconCache.get(key)
  if (cached) {
    // Re-inserting counts the key as the most recently used one.
    iconCache.delete(key)
    if (Date.now() - cached.cachedAt < ICON_CACHE_TTL_MS) {
      iconCache.set(key, cached)
      return cached.pending
    }
  }
  const entry: CachedIcon = {
    // Concurrent callers share this one in-flight request; a failed lookup is
    // dropped again so the next one retries instead of inheriting a permanent
    // "this note has no icon".
    pending: fetchIcon(kind, id).catch(() => {
      if (iconCache.get(key) === entry) iconCache.delete(key)
      return null
    }),
    cachedAt: Date.now()
  }
  iconCache.set(key, entry)
  evictOverflow()
  return entry.pending
}

export function clearVaultItemIconCache(): void {
  iconCache.clear()
}

export function useVaultItemIcon(kind: string | undefined, id: string | undefined): string | null {
  const key = kind === 'note' && id ? `${kind}:${id}` : null
  const [resolved, setResolved] = useState<{ key: string; icon: string | null } | null>(null)

  useEffect(() => {
    if (!key || kind === undefined || id === undefined) return
    let cancelled = false
    void lookupVaultItemIcon(kind, id).then((icon) => {
      if (!cancelled) setResolved({ key, icon })
    })
    return () => {
      cancelled = true
    }
  }, [key, kind, id])

  // A stale lookup for a previous href is ignored by the key match instead of
  // being reset eagerly on prop change.
  return key !== null && resolved?.key === key ? resolved.icon : null
}
