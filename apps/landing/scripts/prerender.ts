import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { buildLlmsTxt, buildRobotsTxt, buildSitemapXml } from '../src/lib/crawl-files.ts'
import { buildIndexNowKeyFile, INDEXNOW_KEY_FILENAME } from '../src/lib/indexnow.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.resolve(ROOT, 'dist')

const SEO_TAG_PATTERNS = [
  /<title[^>]*>.*?<\/title>/gi,
  /<meta[^>]*(?:name|property)=["'](?:description|og:|twitter:)[^>]*\/?>/gi,
  /<link[^>]*rel=["']canonical["'][^>]*\/?>/gi,
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>.*?<\/script>/gi
]

function extractSeoTags(html: string): { cleaned: string; headTags: string } {
  const extracted: string[] = []
  let cleaned = html

  for (const pattern of SEO_TAG_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match) => {
      extracted.push(match)
      return ''
    })
  }

  return { cleaned, headTags: extracted.join('\n    ') }
}

function stripSeoTags(html: string): string {
  let cleaned = html

  for (const pattern of SEO_TAG_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }

  return cleaned
}

function markHelmetManagedHeadTags(headTags: string): string {
  return headTags.replace(/<(title|meta|link|script)\b(?![^>]*\bdata-rh=)/g, '<$1 data-rh="true"')
}

async function prerender() {
  const vite = await createServer({
    root: ROOT,
    server: {
      hmr: false,
      middlewareMode: true
    },
    appType: 'custom'
  })

  try {
    const { render, ROUTES } = await vite.ssrLoadModule('/src/entry-server.tsx')
    const template = fs.readFileSync(path.resolve(DIST, 'index.html'), 'utf-8')
    const templateWithoutSeo = stripSeoTags(template)

    for (const route of ROUTES as string[]) {
      const { html: appHtml } = render(route)
      const { cleaned: cleanedAppHtml, headTags: embeddedHeadTags } = extractSeoTags(appHtml)
      const headTags = markHelmetManagedHeadTags(embeddedHeadTags)

      let page = templateWithoutSeo.replace(
        '<div id="root"></div>',
        `<div id="root">${cleanedAppHtml}</div>`
      )

      if (headTags) {
        page = page.replace('</head>', `    ${headTags}\n  </head>`)
      }

      const dir = path.resolve(DIST, route === '/' ? '' : route.slice(1))
      fs.mkdirSync(dir, { recursive: true })

      const outFile =
        route === '/' ? path.resolve(DIST, 'index.html') : path.resolve(dir, 'index.html')

      fs.writeFileSync(outFile, page)

      if (route !== '/') {
        const flatOutFile = path.resolve(DIST, `${route.slice(1)}.html`)
        fs.mkdirSync(path.dirname(flatOutFile), { recursive: true })
        fs.writeFileSync(flatOutFile, page)
      }

      console.log(`  prerendered: ${route} -> ${path.relative(ROOT, outFile)}`)
    }

    fs.writeFileSync(path.resolve(DIST, 'sitemap.xml'), buildSitemapXml())
    fs.writeFileSync(path.resolve(DIST, 'robots.txt'), buildRobotsTxt())
    fs.writeFileSync(path.resolve(DIST, 'llms.txt'), buildLlmsTxt())
    fs.writeFileSync(path.resolve(DIST, INDEXNOW_KEY_FILENAME), buildIndexNowKeyFile())
    console.log('  wrote: dist/sitemap.xml')
    console.log('  wrote: dist/robots.txt')
    console.log('  wrote: dist/llms.txt')
    console.log(`  wrote: dist/${INDEXNOW_KEY_FILENAME}`)

    console.log(`\n  ${ROUTES.length} routes prerendered.`)
  } finally {
    await vite.close()
  }
}

prerender().catch((err) => {
  console.error('Prerender failed:', err)
  process.exit(1)
})
