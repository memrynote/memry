const MAX_SUGGESTIONS = 6

// Prefix matches first, then substring matches; tags already on the clip are
// skipped. Case-insensitive, matching how the vault treats tag identity.
export function matchTags(query: string, suggestions: string[], taken: string[]): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const takenSet = new Set(taken.map((t) => t.toLowerCase()))
  const prefix: string[] = []
  const inner: string[] = []
  for (const s of suggestions) {
    const lower = s.toLowerCase()
    if (takenSet.has(lower)) continue
    if (lower.startsWith(q)) prefix.push(s)
    else if (lower.includes(q)) inner.push(s)
  }
  return [...prefix, ...inner].slice(0, MAX_SUGGESTIONS)
}
