import assert from 'node:assert/strict'
import test from 'node:test'

import { snippet, writeMarkdownNote } from './markdown.ts'

test('writeMarkdownNote: empty-null value emits `key:` with no trailing space', () => {
  const result = writeMarkdownNote({ empty: null }, 'body')
  assert.equal(result, '---\nempty:\n---\nbody')
  assert.ok(!/empty: \n/.test(result), 'must not emit a trailing space after the key')
})

test('writeMarkdownNote: date-only Date emits YYYY-MM-DD (local components)', () => {
  const date = new Date(2026, 6, 5) // local midnight, July 5 2026
  const result = writeMarkdownNote({ date }, 'body')
  assert.equal(result, '---\ndate: 2026-07-05\n---\nbody')
})

test('writeMarkdownNote: Date with time emits YYYY-MM-DDTHH:MM:SS (no millis/Z)', () => {
  const date = new Date(2026, 6, 5, 9, 8, 7)
  const result = writeMarkdownNote({ when: date }, 'body')
  assert.equal(result, '---\nwhen: 2026-07-05T09:08:07\n---\nbody')
})

test('writeMarkdownNote: normalizes Dates nested in arrays and objects', () => {
  const result = writeMarkdownNote({ dates: [new Date(2026, 6, 5)] }, 'body')
  assert.equal(result, '---\ndates:\n  - 2026-07-05\n---\nbody')
})

test('writeMarkdownNote: strips trailing newlines, keeps no trailing newline', () => {
  const result = writeMarkdownNote({ title: 'Foo' }, 'body\n\n')
  assert.equal(result, '---\ntitle: Foo\n---\nbody')
})

test('writeMarkdownNote: no frontmatter keys → trimmed content only', () => {
  assert.equal(writeMarkdownNote({}, '  body  '), 'body')
})

test('snippet: strips memry block-nesting comment markers (issue #518)', () => {
  const content = [
    '#test',
    '<!-- memry:block-nesting-level=1 -->',
    'asdasdf',
    '<!-- memry:block-nesting-level=2 -->',
    'adfasdfa'
  ].join('\n')
  const result = snippet(content)
  assert.equal(result, '#test asdasdf adfasdfa')
  assert.ok(!result.includes('<!--'))
  assert.ok(!result.includes('memry:block-nesting'))
})

test('snippet: strips colors and file HTML comment markers', () => {
  const content =
    'text <!-- colors:{"textColor":"red"} --> more <!-- file:{"url":"x","name":"y"} -->'
  assert.equal(snippet(content), 'text more')
})

test('snippet: strips markdown syntax to plain prose', () => {
  const content = [
    '# Heading',
    'This is **bold** and *italic* and ~~strike~~.',
    'A [label](https://example.com) link and ![alt text](img.png) image.',
    'Some `inline code` here.',
    'See [[Other Note]] and [[Target|Alias]].',
    '> a quote',
    '- bullet one',
    '1. numbered one'
  ].join('\n')
  const result = snippet(content)
  assert.equal(
    result,
    'Heading This is bold and italic and strike. A label link and alt text image. Some inline code here. See Other Note and Alias. a quote bullet one numbered one'
  )
})

test('snippet: collapses whitespace and caps length at 180 chars', () => {
  const content = `${'word '.repeat(100)}`
  const result = snippet(content)
  assert.ok(result.length <= 180)
  assert.ok(!/\s{2,}/.test(result))
})
