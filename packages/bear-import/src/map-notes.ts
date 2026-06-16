import type { BearInfo, MappedNote } from './types.ts'
import { parseTags } from './parse-tags.ts'

// Matches ](assets/filename) to extract asset refs. Inner class also excludes
// `]` so a run cannot overrun across repeated `](assets/` anchors (ReDoS).
const ASSET_REF_RE = /\]\(assets\/([^)\]]+)\)/g

function extractTitle(md: string, folderName: string): string {
  for (const line of md.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim()
  }
  for (const line of md.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return folderName
}

function extractAssetRefs(md: string): string[] {
  const refs: string[] = []
  for (const match of md.matchAll(ASSET_REF_RE)) {
    refs.push(match[1])
  }
  return refs
}

export function mapNote(input: { folderName: string; md: string; info: BearInfo }): MappedNote {
  const { folderName, md, info } = input

  const title = extractTitle(md, folderName)
  const tags = parseTags(md)
  const assetRefs = extractAssetRefs(md)

  let folder: 'Bear' | 'Bear/Archived' | 'Bear/Trash'
  if (info.trashed) {
    folder = 'Bear/Trash'
  } else if (info.archived) {
    folder = 'Bear/Archived'
  } else {
    folder = 'Bear'
  }

  return {
    title,
    body: md,
    tags,
    archived: info.archived,
    trashed: info.trashed,
    folder,
    created: info.created,
    modified: info.modified,
    assetRefs
  }
}
