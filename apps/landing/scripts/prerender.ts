import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { buildLlmsTxt, buildRobotsTxt, buildSitemapXml } from '../src/lib/crawl-files.ts'
import { buildIndexNowKeyFile, INDEXNOW_KEY_FILENAME } from '../src/lib/indexnow.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.resolve(ROOT, 'dist')

// Tags Helmet renders into the tree that belong in <head> instead. React 19 treats
// title/meta/link as hoistable — it re-creates them in <head> itself on mount, so
// lifting them out of the body here costs hydration nothing and gets them in front of
// crawlers that only read <head>.
//
// A <script type="application/ld+json"> is deliberately NOT in this list. React does
// not hoist script elements, so it stays a real node in the hydrated tree; moving it
// out of the body left hydration looking for a <script> and finding the next section,
// which failed the whole page's hydration and made React rebuild it from scratch.
// JSON-LD is valid anywhere in the document, so it stays where Helmet put it.
const SEO_TAG_PATTERNS = [
  /<title[^>]*>.*?<\/title>/gi,
  /<meta[^>]*(?:name|property)=["'](?:description|og:|twitter:)[^>]*\/?>/gi,
  /<link[^>]*rel=["']canonical["'][^>]*\/?>/gi
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

/**
 * Hoist React's image preloads out of the body and into <head>.
 *
 * React works out which images the first render needs and emits
 * `<link rel="preload" as="image">` for them, but renderToString can only put them
 * where the tree is — at the top of <div id="root">, after every script and stylesheet
 * in <head>. The preload scanner therefore queues the whole JS graph first and the LCP
 * image contends with it for bandwidth. In <head>, ahead of the module scripts, the
 * request goes out in the first round trip instead.
 *
 * These are resource hints, not rendered nodes: React re-issues them on mount and does
 * not try to match them during hydration, so moving them changes nothing about the tree.
 */
function hoistImagePreloads(html: string): { cleaned: string; preloads: string } {
  const found: string[] = []
  const cleaned = html.replace(/<link rel="preload" as="image"[^>]*\/?>/g, (match) => {
    found.push(match)
    return ''
  })

  return { cleaned, preloads: found.join('\n    ') }
}

/**
 * Build the <link rel="modulepreload"> set for the app chunk.
 *
 * main.tsx waits for the first paint before it imports ./boot, which keeps React's
 * module evaluation off the critical path — but it also means Vite emits no preload
 * links for that half of the graph, and the download would not start until the wait was
 * over. These links start it immediately without evaluating anything, so the wait is
 * free: by the time the frame is composited the chunk is already in memory.
 */
function bootModulePreloads(): string {
  const manifestPath = path.resolve(DIST, '.vite/manifest.json')
  if (!fs.existsSync(manifestPath)) return ''

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<
    string,
    { file: string; imports?: string[] }
  >
  // boot is a dynamic import, so its manifest key is the emitted chunk, not the source
  // path an entry would get. Vite names it after the module, hence the prefix match.
  const bootKey = Object.keys(manifest).find((key) =>
    manifest[key]?.file?.startsWith('assets/boot-')
  )
  if (!bootKey) return ''

  const files = new Set<string>()
  const walk = (key: string) => {
    const entry = manifest[key]
    // `imports` also lists index.html, the entry that owns the graph; it is not a chunk.
    if (!entry || !entry.file.endsWith('.js') || files.has(entry.file)) return
    files.add(entry.file)
    entry.imports?.forEach(walk)
  }
  walk(bootKey)

  return [...files]
    .map((file) => `<link rel="modulepreload" crossorigin href="/${file}">`)
    .join('\n    ')
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
    const bootPreloads = bootModulePreloads()

    for (const route of ROUTES as string[]) {
      const { html: appHtml } = render(route)
      const { cleaned: withoutSeo, headTags: embeddedHeadTags } = extractSeoTags(appHtml)
      const { cleaned: cleanedAppHtml, preloads } = hoistImagePreloads(withoutSeo)
      const headTags = markHelmetManagedHeadTags(embeddedHeadTags)

      let page = templateWithoutSeo.replace(
        '<div id="root"></div>',
        `<div id="root">${cleanedAppHtml}</div>`
      )

      // Ahead of the <script>/<link> block Vite appends, so the LCP image is requested
      // in the same round trip as the JS rather than behind it.
      page = page.replace('<!--image-preloads-->', preloads)
      page = page.replace('<!--boot-modulepreloads-->', bootPreloads)

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
