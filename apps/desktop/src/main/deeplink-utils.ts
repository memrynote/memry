export function parseInboxOpenItemId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'memry:' || parsed.hostname !== 'open') return null
    return parsed.searchParams.get('item')
  } catch {
    return null
  }
}
