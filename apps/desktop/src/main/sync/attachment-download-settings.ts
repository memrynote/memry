import { getSetting } from '../database/queries/settings'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database'

const log = createLogger('AttachmentDownloadSettings')

/**
 * Whether background attachment downloads (eager pull fan-out + failure
 * re-driver) are enabled. `sync.attachmentAutoDownload === false` means
 * on-demand only.
 *
 * Read straight from the settings row rather than through the IPC layer's
 * group reader: this is consulted from the sync layer, which must not import
 * from `main/ipc`. Fails open — a blob written by an older version has no key,
 * and only an explicit `false` (never a missing or unreadable value) turns the
 * background paths off, so existing installs keep today's eager behaviour.
 */
export function isAttachmentAutoDownloadEnabled(db: DataDb): boolean {
  try {
    const raw = getSetting(db, 'sync')
    if (!raw) return true
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse / response.json / require returns any; the asserted type is the wire or persisted contract and a runtime guard here would change behavior
    const parsed = JSON.parse(raw) as { attachmentAutoDownload?: unknown }
    return parsed.attachmentAutoDownload !== false
  } catch (err) {
    log.warn('Could not read sync settings; keeping attachment auto-download on', { error: err })
    return true
  }
}
