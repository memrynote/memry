/**
 * Journal section of the vault service handles.
 *
 * Split out of handles-adapter.ts, which is at its max-lines ceiling. Body
 * writes go through writeAgentBody so the agent's checkbox lines follow the
 * owner's agent checklist setting.
 *
 * @module agent/mcp/tools/journal-handles
 */

import { generateJournalId } from '@memry/contracts/journal-api'

import type { IndexDb } from '../../../database'
import { listJournalEntriesInRange } from '../../../database/queries/notes'
import { deleteJournalEntryFile, readJournalEntry, writeJournalEntry } from '../../../vault/journal'
import { createdTasksReply, writeAgentBody } from './agent-checklists'
import type { VaultServiceHandles } from './handles'
import { readStoredJournalEntry, withDroppedJournalKeys } from './stored-records'

export function createJournalHandles(indexDb: IndexDb): VaultServiceHandles['journal'] {
  return {
    async getByDate(date) {
      const entry = await readJournalEntry(date)
      if (!entry) return null
      return {
        id: entry.id,
        date: entry.date,
        content_markdown: entry.content
      }
    },
    async listInRange({ from, to }) {
      return listJournalEntriesInRange(indexDb, from, to).map((entry) => ({
        id: entry.id,
        date: entry.date ?? '',
        title: entry.title
      }))
    },
    async createIfMissing({ date, content_markdown }) {
      const existing = await readJournalEntry(date)
      if (existing) return { id: existing.id, created: false }

      const { result: created, createdTasks } = await writeAgentBody(
        generateJournalId(date),
        content_markdown,
        '',
        (content) => writeJournalEntry(date, content)
      )
      return { id: created.id, created: true, ...createdTasksReply(createdTasks) }
    },
    async update({ date, content_markdown, tags, properties }) {
      const existing = await readJournalEntry(date)
      const write = (content: string): ReturnType<typeof writeJournalEntry> =>
        writeJournalEntry(date, content, tags ?? existing?.tags, properties ?? existing?.properties)
      if (content_markdown === undefined) {
        return withDroppedJournalKeys(date, () => write(existing?.content ?? ''))
      }
      let createdTasks: Parameters<typeof createdTasksReply>[0] = []
      const updated = await withDroppedJournalKeys(date, async () => {
        const body = await writeAgentBody(
          generateJournalId(date),
          content_markdown,
          existing?.content ?? '',
          write
        )
        createdTasks = body.createdTasks
        return body.result
      })
      return { ...updated, ...createdTasksReply(createdTasks) }
    },
    async delete(date) {
      return { date, deleted: await deleteJournalEntryFile(date) }
    },
    async stored(date) {
      return readStoredJournalEntry(date)
    }
  }
}
