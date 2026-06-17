import { expect, test } from 'vitest'
import { renderMarkdown } from './render-markdown'

test('renders benign markdown to html', () => {
  const html = renderMarkdown('# Title\n\nHello **world**')
  expect(html).toContain('<h1')
  expect(html).toContain('<strong>world</strong>')
})

test('strips event-handler attributes from raw html', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">')
  expect(html).not.toContain('onerror')
})

test('strips javascript: links', () => {
  const html = renderMarkdown('[click](javascript:alert(1))')
  expect(html.toLowerCase()).not.toContain('javascript:')
})
