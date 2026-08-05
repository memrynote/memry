import { ALTERNATIVES } from './alternatives'
import { BASE_URL, PAGE_META } from './seo'

export function toAbsoluteUrl(path: string) {
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

export function buildSitemapXml(
  paths: readonly string[] = getIndexablePaths(),
  lastmod: string = new Date().toISOString().slice(0, 10)
): string {
  const urls = paths
    .map(
      (path) =>
        `  <url>\n    <loc>${escapeXml(toAbsoluteUrl(path))}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`
    )
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

// AI-search discovery file (llms.txt). Crawlers like Perplexity / ChatGPT / Claude read
// this to understand the site without reverse-engineering the HTML.
export function buildLlmsTxt(): string {
  const page = (path: string, desc?: string) =>
    desc ? `- [${path}](${BASE_URL}${path}): ${desc}` : `- [${path}](${BASE_URL}${path})`

  return [
    '# memrynote',
    '',
    '> memrynote is a local-first, end-to-end encrypted personal knowledge management app that combines notes, tasks, a daily journal, and an inbox in one offline-first desktop workspace. Built by Kaan Karaca. Open source. Available for macOS, Windows, and Linux.',
    '',
    'memrynote stores notes as plain Markdown files in a folder you choose on your device. Encrypted sync across devices uses XChaCha20-Poly1305 via libsodium and is zero-knowledge: vault keys never leave your devices. No account is required to use the core app.',
    '',
    'Pricing: Free (local vault), Plus $5/month (1 GB encrypted sync, 1 vault), Pro $10/month (10 GB, 10 vaults), Believer $500 once (50 GB, unlimited vaults).',
    '',
    '## Key pages',
    '',
    page('/', PAGE_META.home.description),
    page('/features', PAGE_META.features.description),
    page('/security', PAGE_META.security.description),
    page('/pricing', PAGE_META.pricing.description),
    page('/use-cases', PAGE_META.useCases.description),
    page('/download/desktop', PAGE_META.downloadDesktop.description),
    page('/cli', PAGE_META.cli.description),
    page('/changelog', PAGE_META.changelog.description),
    page('/roadmap', PAGE_META.roadmap.description),
    '',
    '## Comparisons',
    '',
    page('/compare', PAGE_META.compare.description),
    ...ALTERNATIVES.map((alt) => {
      const meta = PAGE_META[alt.pageKey]
      return page(meta.path, meta.description)
    }),
    '',
    '## Feature pages',
    '',
    page('/features/notes'),
    page('/features/inbox'),
    page('/features/journal'),
    page('/features/tasks'),
    page('/features/calendar'),
    page('/features/ai-agent'),
    page('/features/web-clipper'),
    '',
    '## About',
    '',
    '- Founder: Kaan Karaca (@h4yfans on X and GitHub)',
    '- License: Open source',
    '- Docs: https://docs.memrynote.com',
    ''
  ].join('\n')
}
