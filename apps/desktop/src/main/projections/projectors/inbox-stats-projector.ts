import { rebuildInboxStatsTable } from '../../inbox/stats'
import type { ProjectionEvent, ProjectionProjector } from '../types'

export function createInboxStatsProjector(): ProjectionProjector {
  return {
    name: 'inbox-stats',

    handles(event: ProjectionEvent): boolean {
      return event.type.startsWith('inbox.')
    },

    async project(): Promise<void> {
      rebuildInboxStatsTable()
    },

    async rebuild(): Promise<{ rows: number }> {
      return rebuildInboxStatsTable()
    },

    async reconcile(): Promise<{ rows: number }> {
      return rebuildInboxStatsTable()
    }
  }
}
