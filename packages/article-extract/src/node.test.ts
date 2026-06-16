import { describe, it, expect } from 'vitest'
import { extractFromHtml } from './node.ts'

const FIXTURE = `<!doctype html>
<html>
  <head>
    <title>Running local models is good now</title>
    <meta name="author" content="Vicki Boykis" />
    <meta name="description" content="Local agentic coding has gotten good." />
  </head>
  <body>
    <nav>home about</nav>
    <article>
      <h1>Running local models is good now</h1>
      <p>I have been working with local models since they came out and they are good.</p>
      <p>With recent releases I can do agentic coding locally at about seventy five percent quality.</p>
    </article>
    <footer>copyright</footer>
  </body>
</html>`

describe('extractFromHtml', () => {
  it('extracts the article body and title from raw HTML', async () => {
    const capture = await extractFromHtml(FIXTURE, 'https://example.com/article', {
      now: '2026-06-17T00:00:00.000Z'
    })

    expect(capture.properties.title).toContain('Running local models')
    expect(capture.properties.source).toBe('https://example.com/article')
    expect(capture.contentMarkdown).toContain('local models')
    expect(capture.extractionStatus).not.toBe('failed')
  })

  it('returns failed status for empty HTML', async () => {
    const capture = await extractFromHtml('<html><body></body></html>', 'https://e.com/x')
    expect(capture.extractionStatus).toBe('failed')
  })
})
