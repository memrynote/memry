import { tokensToFrontmatter } from './metadata.ts'
import type { JournalEntryInput, JournalEntryPlan } from './types.ts'

/**
 * Assemble a `JournalEntryPlan` from already-extracted entry data.
 * Title = ISO date when available, otherwise the raw filename stem.
 * Reflection (if any) is appended as a blockquote after the body.
 */
export function mapEntry(input: JournalEntryInput): JournalEntryPlan {
  const { date, bodyMarkdown, reflection, overlayValues, filenameStem } = input

  const title = date ?? filenameStem

  const parts: string[] = []
  if (bodyMarkdown.trim()) parts.push(bodyMarkdown.trim())
  if (reflection && reflection.trim()) parts.push(`> ${reflection.trim()}`)
  const content = parts.join('\n\n')

  const properties: Record<string, unknown> = {}
  if (date) properties['date'] = date
  Object.assign(properties, tokensToFrontmatter(overlayValues))

  return {
    title,
    folder: 'Apple Journal',
    content,
    properties,
    created: date ?? undefined
  }
}
