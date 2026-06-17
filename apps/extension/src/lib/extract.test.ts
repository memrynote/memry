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
  expect(capture.properties.tags).toEqual(['clippings'])
  expect(typeof capture.contentMarkdown).toBe('string')
  expect(['full', 'partial', 'failed']).toContain(capture.extractionStatus)
})
