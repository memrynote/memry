import type { VercelRequest, VercelResponse } from '@vercel/node'

const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/memrynote/memry/releases/latest'
const RELEASES_PAGE_URL = 'https://github.com/memrynote/memry/releases/latest'

// ponytail: release asset filenames embed the version (MemryNote-<ver>-arm64.dmg, ...),
// so a static latest/download/<file> link is impossible and CSP blocks a browser-side
// GitHub API fetch — this endpoint resolves the versioned asset server-side and 302s to it.
const ASSET_MATCHERS: Record<string, (name: string) => boolean> = {
  'mac-arm64': (name) => name.endsWith('-arm64.dmg'),
  'mac-x64': (name) => name.endsWith('-x64.dmg'),
  windows: (name) => name.endsWith('-setup.exe'),
  linux: (name) => name.endsWith('.AppImage'),
  'linux-deb': (name) => name.endsWith('.deb')
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export function resolveAssetUrl(platform: string, assets: ReleaseAsset[]): string | null {
  const match = ASSET_MATCHERS[platform]
  if (!match) return null
  return assets.find((asset) => match(asset.name))?.browser_download_url ?? null
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
