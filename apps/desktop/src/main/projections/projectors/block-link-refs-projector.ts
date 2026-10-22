import { PortalChannels } from '@memry/contracts/ipc-channels'
import type { PortalUsageChangedEvent } from '@memry/contracts/portals-api'
import { extractBlockLinks } from '@memry/shared/wiki-target'
import { getBlockLinkRefsForSource, setBlockLinkRefs } from '@main/database/queries/notes'
import { getIndexDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import { trackMainError } from '../../telemetry/diagnostics'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:BlockLinkRefs')

/**
 * Derives a note's `[[Note#^anchor]]` rows for block usage counts. The body is
 * the source of truth, so rows are replaced wholesale per source note. A
 * changed set announces `portals:usage-changed` for the linked notes (the
 * usage chips refresh on that event); a target is matched by name key, so the
 * announcement carries every note id the chips could be showing for it.
 */
export function createBlockLinkRefsProjector(): ProjectionProjector {
  return {
    name: 'block-link-refs',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted' || event.type === 'note.deleted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      try {
        const db = getIndexDatabase()
        if (event.type === 'note.deleted') {
          if (getBlockLinkRefsForSource(db, event.noteId).length > 0) {
            setBlockLinkRefs(db, event.noteId, [])
            broadcast()
          }
          return
        }
        if (event.type !== 'note.upserted' || event.note.kind !== 'markdown') return
        // Tier 0 of ingest has not read the body; its links are unknown, not gone.
        if (event.note.parsedContent === null) return

        const noteId = event.note.noteId
        const before = getBlockLinkRefsForSource(db, noteId)
        setBlockLinkRefs(db, noteId, extractBlockLinks(event.note.parsedContent))
        const after = getBlockLinkRefsForSource(db, noteId)
        const key = (row: { targetKey: string; anchor: string }): string =>
          `${row.targetKey}\u0000${row.anchor}`
        const was = new Set(before.map(key))
        const now = new Set(after.map(key))
        if (was.size !== now.size || [...now].some((entry) => !was.has(entry))) broadcast()
      } catch (err) {
        // A failure must not stall the queue behind it. Link counts then lag
        // the note body until the note is next saved.
        logger.error('Block link projection failed', err)
        trackMainError('notes', 'block_link_refs_project', err)
      }
    },

    async rebuild(): Promise<void> {
      // Rows derive per note.upserted event; nothing to rebuild independently.
    },

    async reconcile(): Promise<void> {
      // See rebuild().
    }
  }
}

function broadcast(): void {
  // A link names its target by text, so the affected note ids are not known
  // here. '*' tells every usage listener to look again.
  const event: PortalUsageChangedEvent = { noteIds: ['*'] }
  broadcastToAllWindows(PortalChannels.events.USAGE_CHANGED, event)
}
