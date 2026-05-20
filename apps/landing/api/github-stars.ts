import type { VercelRequest, VercelResponse } from '@vercel/node'

const GITHUB_REPO_API_URL = 'https://api.github.com/repos/memrynote/memry'

function getStarCount(data: unknown): number | null {
  if (!data || typeof data !== 'object' || !('stargazers_count' in data)) return null

  const count = data.stargazers_count
  return typeof count === 'number' && Number.isFinite(count) ? count : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'memrynote-landing'
  }

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  try {
    const response = await fetch(GITHUB_REPO_API_URL, { headers })
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`)
    }

    const stars = getStarCount(await response.json())
    if (stars === null) {
      throw new Error('GitHub API response did not include stargazers_count')
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600')
    return res.status(200).json({ stars })
  } catch (error) {
    console.error('[github-stars] request failed:', error instanceof Error ? error.message : error)
    res.setHeader('Cache-Control', 's-maxage=60')
    return res.status(502).json({ error: 'Could not fetch GitHub stars' })
  }
}
