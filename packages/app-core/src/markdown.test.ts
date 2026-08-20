import assert from 'node:assert/strict'
import test from 'node:test'

import { snippet } from './markdown.ts'

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

test('snippet: a wiki link reads as its note half, or its alias (issue #1556)', () => {
  const content = 'see [[Sprint Notes#Retro]], [[Sprint Notes|retro]] and [[Plain]]'
  assert.equal(snippet(content), 'see Sprint Notes, retro and Plain')
})
