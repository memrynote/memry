/**
 * Link Capture — Article Extraction E2E
 *
 * Proves the spec behaviour end-to-end in the REAL bundled Electron main:
 * pasting a URL enriches the inbox item with the readable article (defuddle
 * markdown) + a property set, and filing carries those properties into the
 * note frontmatter with the article as the body.
 *
 * This must run in the packaged main bundle, not vitest — the original defect
 * (`require('defuddle/node')` → ERR_PACKAGE_PATH_NOT_EXPORTED, because the
 * `./node` subpath is import-only while main bundles to CommonJS) only surfaces
 * once the main process actually loads the extractor. vitest resolves the TS
 * source directly and cannot reproduce a bundling/module-resolution gap.
 *
 * The page HTML is served from a localhost server so the test is deterministic
 * and offline; the production path against a live URL is verified manually.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const ARTICLE_TITLE = 'Running Local Models Is Good Now'
const BODY_MARKER = 'agentic coding locally'

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${ARTICLE_TITLE}</title>
    <meta property="og:title" content="${ARTICLE_TITLE}" />
    <meta name="author" content="Vicki Boykis" />
    <meta name="description" content="Local agentic coding has gotten good enough for day to day work." />
    <meta property="article:published_time" content="2026-06-15T00:00:00.000Z" />
  </head>
  <body>
    <nav>home about archive</nav>
    <article>
      <h1>${ARTICLE_TITLE}</h1>
      <p>I have been working with local models since they first came out and they keep
        getting noticeably better with every single monthly release without fail.</p>
      <p>With the most recent open-weight releases I can now do real ${BODY_MARKER} at
        roughly seventy five percent of frontier quality, which is more than enough for
        most of the day to day refactors and code review passes that fill an afternoon.</p>
      <p>The tooling around them has matured just as quickly: quantized weights, fast
        local inference servers, and editor integrations that feel native rather than
        bolted on as an afterthought to an existing cloud product.</p>
    </article>
    <footer>copyright 2026</footer>
  </body>
</html>`

interface JobSnapshot {
  status: string
  lastError: string | null
}

interface CaptureSnapshot {
  content: string | null
  extractionStatus?: string
  source?: unknown
  tags?: unknown
}

test.describe('Link capture article extraction', () => {
  let server: http.Server
  let articleUrl: string

  test.beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(FIXTURE_HTML)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    articleUrl = `http://127.0.0.1:${port}/article`
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('enriches the inbox item with the article + properties and files them into the note', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    // Paste the URL into the inbox.
    const itemId = await page.evaluate(async (url) => {
      const res = await window.api.inbox.captureLink({ url })
      if (!res.success || !res.item) {
        throw new Error(res.error ?? 'captureLink failed')
      }
      return res.item.id
    }, articleUrl)

    // Wait for the article-extract job to reach a terminal state, then assert it
    // succeeded — surfacing lastError in the message so a regression reproduces
    // the real failure (the swallowed ERR_PACKAGE_PATH_NOT_EXPORTED).
    let job: JobSnapshot = { status: 'missing', lastError: null }
    await expect
      .poll(
        async () => {
          job = await page.evaluate(async (id) => {
            const { jobs } = await window.api.inbox.getJobs({ itemIds: [id] })
            const found = jobs.find((j) => j.type === 'article-extract')
            return { status: found?.status ?? 'missing', lastError: found?.lastError ?? null }
          }, itemId)
          return job.status
        },
        { timeout: 30_000, message: 'article-extract job never reached a terminal state' }
      )
      .toMatch(/^(complete|failed)$/)

    expect(job.status, `article-extract failed: ${job.lastError ?? 'unknown error'}`).toBe(
      'complete'
    )

    // The inbox item now carries the readable article body + the captured props.
    const capture = await page.evaluate(async (id) => {
      const item = await window.api.inbox.get(id)
      const metadata = (item?.metadata ?? {}) as {
        extractionStatus?: string
        properties?: { source?: unknown; tags?: unknown }
      }
      return {
        content: item?.content ?? null,
        extractionStatus: metadata.extractionStatus,
        source: metadata.properties?.source,
        tags: metadata.properties?.tags
      } satisfies CaptureSnapshot
    }, itemId)

    expect(capture.content ?? '').toContain(BODY_MARKER)
    expect(['full', 'partial']).toContain(capture.extractionStatus)
    expect(capture.source).toBe(articleUrl)
    expect(capture.tags).toContain('clippings')

    // File the item to a folder → it becomes a note; properties land in the
    // frontmatter and the article becomes the note body.
    const filed = await page.evaluate(
      (id) => window.api.inbox.file({ itemId: id, destination: { type: 'folder', path: '' } }),
      itemId
    )
    expect(filed.success, filed.error ?? 'file failed').toBe(true)
    expect(filed.filedTo).toBeTruthy()

    const noteMarkdown = fs.readFileSync(path.join(testVaultPath, filed.filedTo as string), 'utf8')
    expect(noteMarkdown).toContain('clippings')
    expect(noteMarkdown).toContain(articleUrl)
    expect(noteMarkdown).toContain(ARTICLE_TITLE)
    expect(noteMarkdown).toContain(BODY_MARKER)
  })
})
