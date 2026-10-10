import { buildAssetServiceContext } from '../canvas/assets/asset-service-context'
import { getAttachmentChunkHashes } from '../ipc/sync-attachment-handlers'
import { createLogger } from '../lib/logger'
import { isVaultReachable } from '../vault/init'
import { releaseExpiredDeletedAssets } from './deleted-asset-release'

const log = createLogger('DeletedAssetReleaseRunner')

const RUN_INTERVAL_MS = 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let running = false
let caughtUp: () => boolean = () => false

/**
 * One pass of the deleted-asset release (#3015) over the open vault. Skips
 * until a full sync has delivered this session and while sync is paused or
 * offline: a stale local view misses a peer's new reference to the same asset.
 * Skips a vault that is unreachable, where every live canvas would read as
 * unreadable.
 */
async function run(): Promise<void> {
  if (running || !caughtUp()) return
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
      releaseHolds: ctx.releaseHolds,
      markWritebackIgnored: ctx.markWritebackIgnored
    })
    if (settled > 0) log.info('Freed the assets of deleted items', { settled })
  } catch (error) {
    log.warn('Deleted-asset release pass failed', { error })
  } finally {
    running = false
  }
}

/** Tries at sync start and hourly while the runtime is up. */
function start(isCaughtUpWithServer: () => boolean): void {
  stop()
  caughtUp = isCaughtUpWithServer
  void run()
  timer = setInterval(() => void run(), RUN_INTERVAL_MS)
  timer.unref?.()
}

function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
  caughtUp = () => false
}

export const deletedAssetReleaseRunner = { start, stop }
