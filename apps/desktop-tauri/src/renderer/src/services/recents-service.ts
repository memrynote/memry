/**
 * Recents Service
 *
 * The "recently opened" commands of Step 30a (`commands/recents.rs`) in the shapes of Electron's
 * `recents:*` channels. The trail is device-local and never synced.
 */

import type { RecentlyOpenedItem, RecordRecentlyOpenedInput } from '@memry/contracts/recents-api'
import { commands } from '../../../generated/bindings'

export const recentsService = {
  /** The newest opened notes and canvases that still exist, at most `limit` (50 when absent). */
  list: (limit?: number): Promise<RecentlyOpenedItem[]> => commands.recentsList(limit ?? null),

  /** `recorded: false` when the write failed; main logs why. */
  async record(input: RecordRecentlyOpenedInput): Promise<{ recorded: boolean }> {
    return { recorded: await commands.recentsRecord(input) }
  }
}
