import { buildAssetServiceContext } from '../canvas/assets/asset-service-context'
import { getAttachmentChunkHashes } from '../ipc/sync-attachment-handlers'
import { createLogger } from '../lib/logger'
import { isVaultReachable } from '../vault/init'
import { releaseExpiredDeletedAssets } from './deleted-asset-release'

const log = createLogger('DeletedAssetReleaseRunner')

const RUN_INTERVAL_MS = 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * One pass of the deleted-asset release (#3015) over the open vault. Skips a
 * vault that is unreachable, where every live canvas would read as unreadable.
 */
async function run(): Promise<void> {
  if (running) return
  const ctx = buildAssetServiceContext()
  if (!ctx || !isVaultReachable(ctx.vaultPath)) return
  running = true
  try {
    const settled = await releaseExpiredDeletedAssets({
      db: ctx.db,
      vaultPath: ctx.vaultPath,
      now: Date.now,
      chunkHashesOf: getAttachmentChunkHashes,
      dereference: ctx.dereference,
      markWritebackIgnored: ctx.markWritebackIgnored
    })
    if (settled > 0) log.info('Freed the assets of deleted items', { settled })
  } catch (error) {
    log.warn('Deleted-asset release pass failed', { error })
  } finally {
    running = false
  }
}

/** Runs at sync start and hourly while the runtime is up. */
function start(): void {
  stop()
  void run()
  timer = setInterval(() => void run(), RUN_INTERVAL_MS)
  timer.unref?.()
}

function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export const deletedAssetReleaseRunner = { start, stop }
