/**
 * Writes for accepted agent-fill proposals. One `properties:set` per note,
 * merged over the stored values read just before, so accepting several
 * proposals never races a stale record.
 */
import { formatRelationUri } from '@memry/contracts/relation-uri'
import type { FieldFillProposal } from '@memry/contracts/tag-fill-api'
import { notesService } from '@/services/notes-service'
import { propertiesService } from '@/services/properties-service'

/** The value to store; a relation to a new object creates that note first (the @ menu's create). */
async function valueOf(proposal: FieldFillProposal): Promise<unknown> {
  if (!proposal.create) return proposal.value
  const created = await notesService.create({
    title: proposal.create.title,
    content: '',
    tags: [proposal.create.tag]
  })
  if (!created.success || !created.note) {
    throw new Error(created.error ?? `Could not create ${proposal.create.title}`)
  }
  return [formatRelationUri('note', created.note.id)]
}

export async function writeProposals(
  noteId: string,
  proposals: readonly FieldFillProposal[]
): Promise<void> {
  if (proposals.length === 0) return
  const values: Record<string, unknown> = {}
  for (const proposal of proposals) values[proposal.field] = await valueOf(proposal)
  const stored = await propertiesService.get(noteId)
  const record: Record<string, unknown> = {}
  for (const property of stored) record[property.name] = property.value
  const result = await propertiesService.set(noteId, { ...record, ...values })
  if (!result.success) throw new Error(result.error ?? 'Failed to save fields')
}
