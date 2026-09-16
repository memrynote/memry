import type { VercelRequest, VercelResponse } from '@vercel/node'

const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/memrynote/memry/releases/latest'
const RELEASES_PAGE_URL = 'https://github.com/memrynote/memry/releases/latest'
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/memrynote/memry/releases/download/'

// ponytail: release asset filenames embed the version (MemryNote-<ver>-arm64.dmg, ...),
// so a static latest/download/<file> link is impossible and CSP blocks a browser-side
// GitHub API fetch — this endpoint resolves the versioned asset server-side and 302s to it.
// ponytail: a release carries two Windows installers. `MemryNote-win-Setup.exe` is the
// Velopack one, Authenticode-signed on the release Mac; the electron-builder
// `-setup.exe` comes straight off the CI runner with no certificate, so SmartScreen
// refuses to unblock it. Prefer the signed one; the unsigned fallback exists only for
// tags published before the Velopack switchover, which carry no Velopack asset at all.
export const VELOPACK_WINDOWS_SETUP_ASSET = 'MemryNote-win-Setup.exe'

// Matchers are ordered by preference: the first one that hits an asset wins.
const ASSET_MATCHERS: Record<string, ReadonlyArray<(name: string) => boolean>> = {
  'mac-arm64': [(name) => name.endsWith('-arm64.dmg')],
  'mac-x64': [(name) => name.endsWith('-x64.dmg')],
  windows: [(name) => name === VELOPACK_WINDOWS_SETUP_ASSET, (name) => name.endsWith('-setup.exe')],
  linux: [(name) => name.endsWith('.AppImage')],
  'linux-deb': [(name) => name.endsWith('.deb')]
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export function resolveAssetUrl(platform: string, assets: ReleaseAsset[]): string | null {
  const matchers = ASSET_MATCHERS[platform]
  if (!matchers) return null

  for (const match of matchers) {
    const asset = assets.find((candidate) => match(candidate.name))
    // The URL ends up in a 302 Location, so it is allowlisted here rather than
    // trusted because it arrived in the GitHub payload.
    if (asset?.browser_download_url.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
      return asset.browser_download_url
    }
  }

  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const platform = String(req.query.platform ?? '')

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'memrynote-landing'
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  try {
    const response = await fetch(LATEST_RELEASE_API_URL, { headers })
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`)
    }

    const release = (await response.json()) as { assets?: ReleaseAsset[] }
    const url = resolveAssetUrl(platform, release.assets ?? [])

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600')
    return res.redirect(302, url ?? RELEASES_PAGE_URL)
  } catch (error) {
    console.error('[download] request failed:', error instanceof Error ? error.message : error)
    res.setHeader('Cache-Control', 's-maxage=60')
    return res.redirect(302, RELEASES_PAGE_URL)
  }
}
