import { useEffect, useState } from 'react'

/**
 * Resolves an item's own icon straight from the vault, keyed by the id inside
 * a memry:// href. The backend pipeline (tool results → model text → source
 * refs) only carries icons as best-effort hints; the vault is the source of
 * truth, and this works even while a turn is still streaming.
 */
const iconCache = new Map<string, Promise<string | null>>()

type VaultIconKind = 'note'

async function fetchIcon(kind: VaultIconKind, id: string): Promise<string | null> {
  try {
    if (kind === 'note') {
      const note = await window.api?.notes?.get?.(id)
      return note?.emoji ?? null
    }
    return null
  } catch {
    return null
  }
}

export function lookupVaultItemIcon(
  kind: string | undefined,
  id: string | undefined
): Promise<string | null> {
  if (kind !== 'note' || !id) return Promise.resolve(null)
  const key = `${kind}:${id}`
  let pending = iconCache.get(key)
  if (!pending) {
    pending = fetchIcon(kind, id)
    iconCache.set(key, pending)
  }
  return pending
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
