import { PortalChannels } from '@memry/contracts/ipc-channels'
import type { PortalUsageChangedEvent } from '@memry/contracts/portals-api'
import {
  getPortalRefsForHost,
  setPortalRefs,
  type PortalRefRow
} from '@main/database/queries/notes'
import { getIndexDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import { derivePortalRefs } from '../../portals/portal-fences'
import { trackMainError } from '../../telemetry/diagnostics'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:PortalRefs')

const rowKey = (row: PortalRefRow): string =>
  JSON.stringify([row.ordinal, row.sourceNoteId, row.anchor, row.hiddenCount, row.kind])

function sameRows(before: PortalRefRow[], after: PortalRefRow[]): boolean {
  if (before.length !== after.length) return false
  const beforeKeys = new Set(before.map(rowKey))
  return after.every((row) => beforeKeys.has(rowKey(row)))
}

/** Sources whose usage differs between two row sets for one host. */
function changedSources(before: PortalRefRow[], after: PortalRefRow[]): string[] {
  const beforeKeys = new Set(before.map(rowKey))
  const afterKeys = new Set(after.map(rowKey))
  const sources = new Set<string>()
  for (const row of before) {
    if (!afterKeys.has(rowKey(row)) && row.sourceNoteId) sources.add(row.sourceNoteId)
  }
  for (const row of after) {
    if (!beforeKeys.has(rowKey(row)) && row.sourceNoteId) sources.add(row.sourceNoteId)
  }
  return [...sources]
}

function announce(noteIds: string[]): void {
  if (noteIds.length === 0) return
  const event: PortalUsageChangedEvent = { noteIds }
  broadcastToAllWindows(PortalChannels.events.USAGE_CHANGED, event)
}

/**
 * Derives a host note's `portal_refs` rows from its `memry-portal` fences. The
 * note body is the source of truth, so rows are replaced wholesale per host.
 */
export function createPortalRefsProjector(): ProjectionProjector {
  return {
    name: 'portal-refs',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted' || event.type === 'note.deleted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      try {
        const db = getIndexDatabase()
        if (event.type === 'note.deleted') {
          const before = getPortalRefsForHost(db, event.noteId)
          if (before.length === 0) return
          setPortalRefs(db, event.noteId, [])
          announce(changedSources(before, []))
          return
        }
        if (event.type !== 'note.upserted' || event.note.kind !== 'markdown') return
        // Tier 0 of ingest has not read the body; its fences are unknown, not gone.
        if (event.note.parsedContent === null) return

        const before = getPortalRefsForHost(db, event.note.noteId)
        const after = derivePortalRefs(event.note.noteId, event.note.parsedContent)
        if (sameRows(before, after)) return
        const sources = changedSources(before, after)
        setPortalRefs(db, event.note.noteId, after)
        announce(sources)
      } catch (err) {
        // A failure must not stall the queue behind it. Usage then lags the
        // note body until the host is next saved.
        logger.error('Failed to project portal refs', err)
        trackMainError('notes', 'portal_refs_project', err)
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
