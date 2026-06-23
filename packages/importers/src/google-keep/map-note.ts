import type { KeepNote, MappedNote } from './types.ts'

function usecToIso(usec: number): string {
  return new Date(Math.floor(usec / 1000)).toISOString()
}

function buildBody(note: KeepNote): string {
  if (note.listContent && note.listContent.length > 0) {
    const lines = note.listContent
      .filter((item) => item.text.trim() !== '')
      .map((item) => (item.isChecked ? `- [x] ${item.text}` : `- [ ] ${item.text}`))
    return lines.join('\n')
  }
  return note.textContent
}

function buildTags(note: KeepNote): string[] {
  const tags: string[] = []

  if (note.color && note.color !== 'DEFAULT') {
    tags.push(`Keep/Color/${note.color}`)
  }

  for (const label of note.labels) {
    tags.push(`Keep/Label/${label.name}`)
  }

  if (note.isPinned) tags.push('Keep/Pinned')
  if (note.isArchived) tags.push('Keep/Archived')
  if (note.isTrashed) tags.push('Keep/Deleted')
  if (note.attachments.length > 0) tags.push('Keep/Attachment')

  return tags
}

function resolveTitle(note: KeepNote): string {
  if (note.title.trim()) return note.title.trim()

  // Fall back to first non-empty line of textContent
  if (note.textContent.trim()) {
    const firstLine = note.textContent.split('\n')[0].trim()
    if (firstLine) return firstLine
  }

  // Fall back to first non-empty list item
  if (note.listContent && note.listContent.length > 0) {
    const first = note.listContent.find((item) => item.text.trim())
    if (first) return first.text.trim()
  }

  return 'Untitled'
}

/** Maps a parsed KeepNote to the shape needed for note creation. */
export function mapKeepNote(note: KeepNote): MappedNote {
  return {
    title: resolveTitle(note),
    body: buildBody(note),
    tags: buildTags(note),
    created: usecToIso(note.createdTimestampUsec),
    modified: usecToIso(note.userEditedTimestampUsec),
    attachmentPaths: note.attachments.map((a) => a.filePath)
  }
}
