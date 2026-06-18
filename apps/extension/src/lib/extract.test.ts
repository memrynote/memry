import { expect, test } from 'vitest'
import { extractFromDocument } from '@memry/article-extract/browser'

test('extractFromDocument returns an article-mode capture from a live document', () => {
  document.title = 'Local models'
  document.body.innerHTML = `
    <article>
      <h1>Local models</h1>
      <p>${'I have been working with local models and the results are encouraging. '.repeat(20)}</p>
    </article>`

  const capture = extractFromDocument(document, 'https://example.com/post', {
    now: '2026-06-17T00:00:00.000Z'
  })

  expect(capture.mode).toBe('article')
  expect(capture.url).toBe('https://example.com/post')
  expect(capture.properties.source).toBe('https://example.com/post')
  expect(capture.properties.created).toBe('2026-06-17T00:00:00.000Z')
  expect(capture.tags).toEqual(['clippings'])
  expect(typeof capture.contentMarkdown).toBe('string')
  expect(['full', 'partial', 'failed']).toContain(capture.extractionStatus)
})

test('extractFromDocument returns markdown body, not raw HTML', () => {
  document.title = 'Markdown body'
  document.body.innerHTML = `
    <article>
      <h1>Markdown body</h1>
      <h2>Section heading</h2>
      <p>${'A readable paragraph with enough words to count as a real article body. '.repeat(20)}
        See <a href="https://example.com/more">the link</a> for more.</p>
    </article>`

  const capture = extractFromDocument(document, 'https://example.com/post')

  // The note editor renders markdown — defuddle must convert content to markdown,
  // not leave it as HTML (the editor drops block HTML, so the body shows empty).
  expect(capture.contentMarkdown).toContain('## Section heading')
  expect(capture.contentMarkdown).toContain('[the link](https://example.com/more)')
  expect(capture.contentMarkdown).not.toMatch(/<(h1|h2|p|a|article)[ >]/)
})
