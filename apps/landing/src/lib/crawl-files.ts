import { BASE_URL, PAGE_META } from './seo'

function toAbsoluteUrl(path: string) {
  return path === '/' ? `${BASE_URL}/` : `${BASE_URL}${path}`
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function getIndexablePaths(): string[] {
  return Object.values(PAGE_META).map((meta) => meta.path)
}

export function buildSitemapXml(paths: readonly string[] = getIndexablePaths()): string {
  const urls = paths
    .map((path) => `  <url>\n    <loc>${escapeXml(toAbsoluteUrl(path))}</loc>\n  </url>`)
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    ''
  ].join('\n')
}

export function buildRobotsTxt(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}/sitemap.xml\n`
}
