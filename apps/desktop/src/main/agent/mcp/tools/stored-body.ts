import { generateJournalId } from '@memry/contracts/journal-api'
import { createLogger } from '../../../lib/logger'
import { settleWriteback } from '../../../sync/crdt-writeback'
import { readJournalEntry } from '../../../vault/journal'
import { getNoteById } from '../../../vault/notes'
import type { WrittenBody } from './handles'

const log = createLogger('AgentVaultHandles')

/**
 * The body a read returns once the armed write-back has run. The write has
 * landed by now, so a failed read reports no stored body instead of failing
 * the call, which an agent would retry and so append twice.
 */
async function storedBody(
  id: string,
  sent: string,
  read: () => Promise<string | null>
): Promise<WrittenBody> {
  await settleWriteback(id)
  try {
    return { sent, stored: await read() }
  } catch (err) {
    log.warn('Could not read back the body a write stored', { id, error: err })
    return { sent, stored: null }
  }
}

export function storedNoteBody(id: string, sent: string): Promise<WrittenBody> {
  return storedBody(id, sent, async () => {
    const note = await getNoteById(id)
    return note && !note.contentOmitted ? note.content : null
  })
}

export function storedJournalBody(date: string, sent: string): Promise<WrittenBody> {
  return storedBody(
    generateJournalId(date),
    sent,
    async () => (await readJournalEntry(date))?.content ?? null
  )
}
