export interface AttachmentRef {
  name: string
  url: string
}

const FILE_TOKEN = /^\[\[file\s+(\{[\s\S]*\})\]\]$/

/** Parse a Todoist `[[file {json}]]` attachment token → { name, url }, or null. */
export function parseAttachmentToken(content: string): AttachmentRef | null {
  const m = content.trim().match(FILE_TOKEN)
  if (!m) return null
  try {
    const obj = JSON.parse(m[1]) as { file_name?: string; file_url?: string; image?: string }
    const url = obj.file_url ?? obj.image
    if (!url) return null
    return { name: obj.file_name ?? 'attachment', url }
  } catch {
    return null
  }
}

/** Turn a Todoist comment into markdown: attachment token → link; otherwise the trimmed text. */
export function commentToMarkdown(content: string): string {
  const att = parseAttachmentToken(content)
  if (att) return `[${att.name}](${att.url})`
  return content.trim()
}
