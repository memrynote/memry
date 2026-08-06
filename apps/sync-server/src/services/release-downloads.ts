import { createLogger } from '../lib/logger'
import { capturePostHogEvents, type PostHogEvent } from './posthog'

// Downloads happen on GitHub Releases, which PostHog cannot observe — the landing
// site's "download click" measures intent, not a download. A daily cron reads the
// Releases API and emits one event per asset per day.
//
// `assets[].download_count` is CUMULATIVE per asset, so shipping it raw yields a
// monotonically increasing counter that is useless as an event stream. The previous
// total lives in D1 (`release_download_counts`) and only the DELTA is emitted; the
// first run for an asset seeds its row and emits nothing.
//
// These events cannot be joined to activation: an anonymous downloader shares no key
// with a desktop install. They stand alone as a volume metric — do not try to build a
// download → activation funnel out of them.

const logger = createLogger('ReleaseDownloads')

const GITHUB_API = 'https://api.github.com'
const RELEASES_REPO = 'memrynote/memry'
// GitHub rejects API requests that send no User-Agent.
const USER_AGENT = 'memry-sync-server'
// Only recent releases still accrue downloads; totals for older ones stop moving and
// their stored rows simply go quiet.
const RELEASES_PER_PAGE = 30
const EVENT_NAME = 'release_asset_downloaded'
const SERVER_SURFACE = 'server'

export interface ReleaseDownloadsEnv {
  DB: D1Database
  ENVIRONMENT?: string
  GITHUB_TOKEN?: string
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
  fetch?: typeof fetch
}

interface AssetSnapshot {
  assetId: string
  releaseTag: string
  name: string
  downloadCount: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// electron-builder publishes auto-update metadata (`latest*.yml`) and delta
// `.blockmap` files as release assets. Every installed app polls those on its update
// schedule, so counting them as downloads would swamp the number that matters.
const assetKind = (name: string): string =>
  /\.(?:blockmap|ya?ml)$/i.test(name) ? 'update_metadata' : 'installer'

const platformOf = (name: string): string => {
  const base = name.replace(/\.blockmap$/i, '').toLowerCase()
  if (/\.(?:exe|msi|appx)$/.test(base) || base.includes('win')) return 'windows'
  if (/\.dmg$/.test(base) || base.includes('mac') || base.includes('darwin')) return 'macos'
  if (/\.(?:deb|rpm|appimage|snap|tar\.gz|tar\.xz)$/.test(base) || base.includes('linux')) {
    return 'linux'
  }
  // electron-builder's macOS update artifact. A Windows zip is named `-win.zip` and
  // is already claimed above.
  if (/\.zip$/.test(base)) return 'macos'
  return 'unknown'
}

// Not person-scoped: an anonymous GitHub downloader has no identity to key on. One
// fixed service actor per environment, mirroring services/analytics.ts, so the staging
// and production crons — both polling the same public repo on the same schedule —
// never blend into a single series.
const serviceDistinctId = (env: ReleaseDownloadsEnv): string =>
  `memry_releases_${env.ENVIRONMENT ?? 'unknown'}`

const parseAssets = (payload: unknown): AssetSnapshot[] => {
  if (!Array.isArray(payload)) return []

  const assets: AssetSnapshot[] = []
  for (const release of payload) {
    if (!isRecord(release) || !Array.isArray(release.assets)) continue
    const releaseTag = typeof release.tag_name === 'string' ? release.tag_name : 'unknown'

    for (const asset of release.assets) {
      if (!isRecord(asset)) continue
      const id = asset.id
      const name = asset.name
      const downloadCount = asset.download_count
      if (typeof id !== 'number' || typeof name !== 'string') continue
      if (typeof downloadCount !== 'number' || !Number.isFinite(downloadCount)) continue

      assets.push({ assetId: String(id), releaseTag, name, downloadCount })
    }
  }
  return assets
}

const fetchReleaseAssets = async (env: ReleaseDownloadsEnv): Promise<AssetSnapshot[]> => {
  const response = await (env.fetch ?? fetch)(
    `${GITHUB_API}/repos/${RELEASES_REPO}/releases?per_page=${RELEASES_PER_PAGE}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
        // Optional: unauthenticated GitHub API calls are limited to 60/hour per IP,
        // and Workers egress from shared addresses.
        ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {})
      }
    }
  )

  if (!response.ok) {
    throw new Error(`GitHub releases request failed with status ${response.status}`)
  }

  return parseAssets(await response.json())
}

const readStoredCounts = async (db: D1Database): Promise<Map<string, number>> => {
  const stored = await db
    .prepare('SELECT asset_id, download_count FROM release_download_counts')
    .all<{ asset_id: string; download_count: number }>()

  return new Map((stored.results ?? []).map((row) => [row.asset_id, row.download_count]))
}

const persistCounts = async (db: D1Database, assets: AssetSnapshot[]): Promise<void> => {
  const now = Math.floor(Date.now() / 1000)
  const statement = db.prepare(
    `INSERT INTO release_download_counts (asset_id, release_tag, asset_name, download_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       release_tag = excluded.release_tag,
       asset_name = excluded.asset_name,
       download_count = excluded.download_count,
       updated_at = excluded.updated_at`
  )

  await db.batch(
    assets.map((asset) =>
      statement.bind(asset.assetId, asset.releaseTag, asset.name, asset.downloadCount, now)
    )
  )
}

export const syncReleaseDownloadCounts = async (env: ReleaseDownloadsEnv): Promise<number> => {
  const assets = await fetchReleaseAssets(env)
  if (assets.length === 0) {
    logger.warn('No release assets returned', { repo: RELEASES_REPO })
    return 0
  }

  const previous = await readStoredCounts(env.DB)
  const distinctId = serviceDistinctId(env)
  const events: PostHogEvent[] = []

  for (const asset of assets) {
    const before = previous.get(asset.assetId)
    // No baseline yet — a cumulative counter carries no meaningful delta until it has
    // been seen once, so seed silently. A total that went DOWN means GitHub recounted
    // or the asset was replaced; reseed rather than emit a negative delta.
    if (before === undefined || asset.downloadCount <= before) continue

    events.push({
      event: EVENT_NAME,
      distinct_id: distinctId,
      properties: {
        release_tag: asset.releaseTag,
        asset_name: asset.name,
        platform: platformOf(asset.name),
        asset_kind: assetKind(asset.name),
        downloads: asset.downloadCount - before,
        cumulative_downloads: asset.downloadCount,
        surface: SERVER_SURFACE,
        environment: env.ENVIRONMENT
      }
    })
  }

  // Persist BEFORE emitting. A D1 write failure throws, the cron reports it, and the
  // baseline is untouched — tomorrow's run emits the full delta. Emitting first and
  // then failing to persist would double-count that same delta on the next run.
  await persistCounts(env.DB, assets)
  await capturePostHogEvents(env, events)

  logger.info('Release download counts synced', {
    assets: assets.length,
    emitted: events.length
  })

  return events.length
}
