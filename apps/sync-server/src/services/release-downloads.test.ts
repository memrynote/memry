import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncReleaseDownloadCounts, type ReleaseDownloadsEnv } from './release-downloads'

interface GithubAsset {
  id: number
  name: string
  download_count: number
}

const releasesPayload = (releases: Array<{ tag_name: string; assets: GithubAsset[] }>): unknown =>
  releases

const githubResponse = (payload: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))

// D1 double: `all()` answers the stored-counts read, `batch()` records the upserts as
// the argument tuples each statement was bound with.
function createDb(stored: Array<{ asset_id: string; download_count: number }>) {
  const binds: unknown[][] = []
  const batch = vi.fn().mockResolvedValue([])
  const prepare = vi.fn(() => ({
    all: vi.fn().mockResolvedValue({ results: stored }),
    bind: vi.fn((...args: unknown[]) => {
      binds.push(args)
      return { args }
    })
  }))

  return { db: { prepare, batch } as unknown as D1Database, prepare, batch, binds }
}

function createEnv(
  db: D1Database,
  githubFetch: ReturnType<typeof vi.fn>,
  overrides: Partial<ReleaseDownloadsEnv> = {}
): ReleaseDownloadsEnv {
  return {
    DB: db,
    ENVIRONMENT: 'production',
    POSTHOG_KEY: 'phc_test',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    fetch: githubFetch as unknown as typeof fetch,
    ...overrides
  }
}

const capturedEvents = (postHogFetch: ReturnType<typeof vi.fn>) =>
  postHogFetch.mock.calls.flatMap(
    ([, init]) =>
      JSON.parse((init as RequestInit).body as string).batch as Array<{
        event: string
        distinct_id: string
        properties: Record<string, unknown>
      }>
  )

describe('syncReleaseDownloadCounts', () => {
  let postHogFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    postHogFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', postHogFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('seeds the store and emits nothing on the first run', async () => {
    // #given an empty store and a release whose assets already carry a cumulative total
    const { db, batch, binds } = createDb([])
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v2026-08-06',
          assets: [
            { id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 120 },
            { id: 2, name: 'MemryNote-1.0.0-setup.exe', download_count: 80 }
          ]
        }
      ])
    )

    // #when the cron runs for the first time
    const emitted = await syncReleaseDownloadCounts(createEnv(db, githubFetch))

    // #then nothing is emitted — a cumulative counter has no delta without a baseline
    expect(emitted).toBe(0)
    expect(postHogFetch).not.toHaveBeenCalled()

    // #and the totals are stored so the next run has one
    expect(batch).toHaveBeenCalledTimes(1)
    expect(binds).toEqual([
      ['1', 'v2026-08-06', 'MemryNote-1.0.0-arm64.dmg', 120, 1_700_000_000],
      ['2', 'v2026-08-06', 'MemryNote-1.0.0-setup.exe', 80, 1_700_000_000]
    ])
  })

  it('emits the delta, never the cumulative total, on the second run', async () => {
    // #given yesterday's totals in the store
    const { db, binds } = createDb([
      { asset_id: '1', download_count: 120 },
      { asset_id: '2', download_count: 80 }
    ])
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v2026-08-06',
          assets: [
            { id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 137 },
            { id: 2, name: 'MemryNote-1.0.0-setup.exe', download_count: 80 }
          ]
        }
      ])
    )

    // #when today's counts come back higher for one asset and unchanged for the other
    const emitted = await syncReleaseDownloadCounts(createEnv(db, githubFetch))

    // #then only the moved asset emits, and it carries the difference
    expect(emitted).toBe(1)
    const events = capturedEvents(postHogFetch)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('release_asset_downloaded')
    expect(events[0].distinct_id).toBe('memry_releases_production')
    expect(events[0].properties).toMatchObject({
      release_tag: 'v2026-08-06',
      asset_name: 'MemryNote-1.0.0-arm64.dmg',
      platform: 'macos',
      asset_kind: 'installer',
      downloads: 17,
      cumulative_downloads: 137,
      surface: 'server',
      environment: 'production'
    })

    // #and both totals are rewritten, including the one that did not move
    expect(binds).toEqual([
      ['1', 'v2026-08-06', 'MemryNote-1.0.0-arm64.dmg', 137, 1_700_000_000],
      ['2', 'v2026-08-06', 'MemryNote-1.0.0-setup.exe', 80, 1_700_000_000]
    ])
  })

  it('never emits a negative delta when a count drops or resets', async () => {
    // #given a stored total higher than the one GitHub now reports
    const { db, binds } = createDb([{ asset_id: '1', download_count: 500 }])
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v2026-08-06',
          assets: [{ id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 12 }]
        }
      ])
    )

    // #when the cron runs
    const emitted = await syncReleaseDownloadCounts(createEnv(db, githubFetch))

    // #then the drop is swallowed rather than shipped as negative downloads
    expect(emitted).toBe(0)
    expect(postHogFetch).not.toHaveBeenCalled()

    // #and the store is reseeded to the new baseline so growth from here is correct
    expect(binds).toEqual([['1', 'v2026-08-06', 'MemryNote-1.0.0-arm64.dmg', 12, 1_700_000_000]])
  })

  it('seeds a newly published asset without emitting its whole history', async () => {
    // #given a store that knows one asset, and a release that added a second
    const { db, binds } = createDb([{ asset_id: '1', download_count: 120 }])
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v2026-08-07',
          assets: [
            { id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 130 },
            { id: 9, name: 'MemryNote-1.1.0-x86_64.AppImage', download_count: 44 }
          ]
        }
      ])
    )

    // #when the cron runs
    const emitted = await syncReleaseDownloadCounts(createEnv(db, githubFetch))

    // #then only the known asset emits; the new one seeds silently at 44
    expect(emitted).toBe(1)
    const events = capturedEvents(postHogFetch)
    expect(events).toHaveLength(1)
    expect(events[0].properties).toMatchObject({
      asset_name: 'MemryNote-1.0.0-arm64.dmg',
      downloads: 10
    })
    expect(binds).toEqual([
      ['1', 'v2026-08-07', 'MemryNote-1.0.0-arm64.dmg', 130, 1_700_000_000],
      ['9', 'v2026-08-07', 'MemryNote-1.1.0-x86_64.AppImage', 44, 1_700_000_000]
    ])
  })

  it('labels platform and separates auto-update metadata from installers', async () => {
    // #given one of every asset shape a release actually publishes, all with a baseline
    const names = [
      'MemryNote-1.0.0-arm64.dmg',
      'MemryNote-1.0.0-arm64.zip',
      'MemryNote-1.0.0-win.zip',
      'MemryNote-1.0.0-setup.exe',
      'MemryNote-1.0.0-amd64.deb',
      'MemryNote-1.0.0-x86_64.AppImage',
      'MemryNote-1.0.0-arm64.dmg.blockmap',
      'latest-mac.yml',
      'latest-linux.yml',
      'latest.yml'
    ]
    const { db } = createDb(
      names.map((_, index) => ({ asset_id: String(index), download_count: 1 }))
    )
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v2026-08-06',
          assets: names.map((name, index) => ({ id: index, name, download_count: 3 }))
        }
      ])
    )

    // #when the cron runs
    await syncReleaseDownloadCounts(createEnv(db, githubFetch))

    // #then each asset is labelled, and the updater's own polling traffic is
    // distinguishable from real installer downloads
    const byName = new Map(
      capturedEvents(postHogFetch).map((event) => [
        event.properties.asset_name as string,
        event.properties
      ])
    )
    expect(byName.get('MemryNote-1.0.0-arm64.dmg')).toMatchObject({
      platform: 'macos',
      asset_kind: 'installer'
    })
    expect(byName.get('MemryNote-1.0.0-arm64.zip')).toMatchObject({ platform: 'macos' })
    expect(byName.get('MemryNote-1.0.0-win.zip')).toMatchObject({ platform: 'windows' })
    expect(byName.get('MemryNote-1.0.0-setup.exe')).toMatchObject({ platform: 'windows' })
    expect(byName.get('MemryNote-1.0.0-amd64.deb')).toMatchObject({ platform: 'linux' })
    expect(byName.get('MemryNote-1.0.0-x86_64.AppImage')).toMatchObject({ platform: 'linux' })
    expect(byName.get('MemryNote-1.0.0-arm64.dmg.blockmap')).toMatchObject({
      platform: 'macos',
      asset_kind: 'update_metadata'
    })
    expect(byName.get('latest-mac.yml')).toMatchObject({
      platform: 'macos',
      asset_kind: 'update_metadata'
    })
    expect(byName.get('latest-linux.yml')).toMatchObject({
      platform: 'linux',
      asset_kind: 'update_metadata'
    })
    expect(byName.get('latest.yml')).toMatchObject({
      platform: 'unknown',
      asset_kind: 'update_metadata'
    })
  })

  it('authenticates with GITHUB_TOKEN when one is configured', async () => {
    const { db } = createDb([])
    const githubFetch = githubResponse(releasesPayload([]))

    await syncReleaseDownloadCounts(createEnv(db, githubFetch, { GITHUB_TOKEN: 'ghp_test' }))

    const [url, init] = githubFetch.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/memrynote/memry/releases?per_page=30')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ghp_test')
    expect(headers['user-agent']).toBe('memry-sync-server')
  })

  it('omits the authorization header when no token is configured', async () => {
    const { db } = createDb([])
    const githubFetch = githubResponse(releasesPayload([]))

    await syncReleaseDownloadCounts(createEnv(db, githubFetch))

    const headers = (githubFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('throws when the GitHub API rejects the request so the cron reports it', async () => {
    const { db } = createDb([])
    const githubFetch = vi.fn().mockResolvedValue(new Response('rate limited', { status: 403 }))

    await expect(syncReleaseDownloadCounts(createEnv(db, githubFetch))).rejects.toThrow(
      'GitHub releases request failed with status 403'
    )
  })

  it('does nothing when the API returns no usable assets', async () => {
    const { db, batch } = createDb([])
    // A malformed body (an object rather than an array) and assets missing the fields
    // the delta depends on must not throw, and must not reach D1 or PostHog.
    const githubFetch = githubResponse({ message: 'Not Found' })

    await expect(syncReleaseDownloadCounts(createEnv(db, githubFetch))).resolves.toBe(0)
    expect(batch).not.toHaveBeenCalled()
    expect(postHogFetch).not.toHaveBeenCalled()
  })

  it('skips malformed releases and assets but keeps the well-formed ones', async () => {
    const { db, binds } = createDb([{ asset_id: '1', download_count: 5 }])
    const githubFetch = githubResponse([
      null,
      { tag_name: 'v-no-assets' },
      {
        assets: [
          null,
          { id: 'not-a-number', name: 'x.dmg', download_count: 1 },
          { id: 7, download_count: 1 },
          { id: 8, name: 'y.dmg', download_count: 'lots' },
          { id: 9, name: 'z.dmg', download_count: Number.NaN },
          { id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 9 }
        ]
      }
    ])

    const emitted = await syncReleaseDownloadCounts(createEnv(db, githubFetch))

    // #then the release with no tag falls back to 'unknown' rather than being dropped
    expect(emitted).toBe(1)
    expect(capturedEvents(postHogFetch)[0].properties).toMatchObject({
      release_tag: 'unknown',
      downloads: 4
    })
    expect(binds).toEqual([['1', 'unknown', 'MemryNote-1.0.0-arm64.dmg', 9, 1_700_000_000]])
  })

  it('falls back to an unknown environment in the service distinct id', async () => {
    const { db } = createDb([{ asset_id: '1', download_count: 1 }])
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v1',
          assets: [{ id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 2 }]
        }
      ])
    )

    await syncReleaseDownloadCounts(createEnv(db, githubFetch, { ENVIRONMENT: undefined }))

    expect(capturedEvents(postHogFetch)[0].distinct_id).toBe('memry_releases_unknown')
  })

  it('tolerates a stored-counts read that returns no results array', async () => {
    const batch = vi.fn().mockResolvedValue([])
    const prepare = vi.fn(() => ({
      all: vi.fn().mockResolvedValue({}),
      bind: vi.fn(() => ({}))
    }))
    const db = { prepare, batch } as unknown as D1Database
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v1',
          assets: [{ id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 2 }]
        }
      ])
    )

    await expect(syncReleaseDownloadCounts(createEnv(db, githubFetch))).resolves.toBe(0)
  })

  it('leaves the stored baseline untouched when the D1 write fails', async () => {
    // #given a store whose batch write rejects
    const prepare = vi.fn(() => ({
      all: vi.fn().mockResolvedValue({ results: [{ asset_id: '1', download_count: 1 }] }),
      bind: vi.fn(() => ({}))
    }))
    const db = {
      prepare,
      batch: vi.fn().mockRejectedValue(new Error('D1 down'))
    } as unknown as D1Database
    const githubFetch = githubResponse(
      releasesPayload([
        {
          tag_name: 'v1',
          assets: [{ id: 1, name: 'MemryNote-1.0.0-arm64.dmg', download_count: 50 }]
        }
      ])
    )

    // #when the cron runs
    // #then it throws for the cron to report, and nothing was emitted — the delta is
    // re-derived from the unchanged baseline on the next run instead of double-counting
    await expect(syncReleaseDownloadCounts(createEnv(db, githubFetch))).rejects.toThrow('D1 down')
    expect(postHogFetch).not.toHaveBeenCalled()
  })
})
