/**
 * Start offsets of every case-insensitive occurrence of `query` in `text`,
 * overlapping ones included ("aa" in "aaa" is two).
 *
 * The one matching rule behind both the find bar, which walks the editor DOM,
 * and the search palette, which counts occurrences in a note body before the
 * note is open. A palette row opens "the Nth match" by index, so the two sides
 * must agree on what a match is.
 */
export function findOffsets(text: string, query: string): number[] {
  const offsets: number[] = []
  if (!query) return offsets
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    offsets.push(at)
  }
  return offsets
}
