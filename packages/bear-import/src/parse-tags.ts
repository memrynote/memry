// Matches Bear's enclosed tag syntax: #[tag name]#
const ENCLOSED_TAG_RE = /#\[([^\]]+)\]#/g

export function parseTags(body: string): string[] {
  const seen = new Set<string>()

  // Extract enclosed tags: #[my tag]# → my_tag
  for (const match of body.matchAll(ENCLOSED_TAG_RE)) {
    const tag = match[1].trim().replace(/\s+/g, '_')
    if (tag) seen.add(tag)
  }

  // Extract simple tags: not at line start (headings start with #)
  // We split lines and only match tags not at position 0
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart()
    // Skip lines that are headings (start with # optionally preceded by whitespace)
    if (/^#{1,6}\s/.test(trimmed)) continue

    // Find all #tag patterns not at the very start of line
    const lineRe = /(?<!\S)#([\p{L}\p{N}/\-_]+)/gu
    for (const match of line.matchAll(lineRe)) {
      // Make sure it's not at position 0 of the line (which would be a heading)
      if (match.index === 0) continue
      const tag = match[1]
      if (tag) seen.add(tag)
    }
  }

  return Array.from(seen).sort()
}
