/**
 * The entry payload for a journal file changed outside the editor. Its `tags`
 * are the header tags only: the renderer reads inline `#tags` from the body,
 * so merging them here would show each one twice.
 */
export function externalJournalEntry(entry: {
  id?: string
  date: string
  content: string
  metadata: { headerTags: string[]; wordCount: number; characterCount: number }
  modified: Date
  created: Date
}) {
  const { metadata, ...rest } = entry
  return {
    ...rest,
    tags: metadata.headerTags,
    wordCount: metadata.wordCount,
    characterCount: metadata.characterCount
  }
}
