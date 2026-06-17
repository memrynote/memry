import { describe, expect, test } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import { initialState, mapError, reducer, selectPhase } from './popup-state'

const draft: ArticleCapture = {
  url: 'https://x.com/p',
  mode: 'article',
  contentMarkdown: '# Hi',
  excerpt: 'Hi',
  extractionStatus: 'full',
  properties: { title: 'Hi', source: 'https://x.com/p', created: 'now', tags: ['clippings'] }
}

test('starts in extracting until both draft and status resolve', () => {
  let s = initialState
  expect(selectPhase(s)).toBe('extracting')
  s = reducer(s, { type: 'DRAFT_READY', draft })
  expect(selectPhase(s)).toBe('extracting') // still waiting on status
  s = reducer(s, { type: 'STATUS', connection: 'ready', port: 7849 })
  expect(selectPhase(s)).toBe('ready')
})

test('app-closed renders even without a draft', () => {
  let s = reducer(initialState, { type: 'STATUS', connection: 'app-closed', port: null })
  s = reducer(s, { type: 'DRAFT_READY', draft: null })
  expect(selectPhase(s)).toBe('app-closed')
})

test('ready connection shows ready', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'ready', port: 7849 })
  expect(selectPhase(s)).toBe('ready')
})

test('unpaired connection still shows ready (pairing happens inline on save)', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  expect(selectPhase(s)).toBe('ready')
})

test('approve then save lifecycle', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  s = reducer(s, { type: 'APPROVE_START' })
  expect(selectPhase(s)).toBe('approving')
  s = reducer(s, { type: 'APPROVE_DONE', ok: true })
  s = reducer(s, { type: 'SAVE_START' })
  expect(selectPhase(s)).toBe('saving')
  s = reducer(s, { type: 'SAVE_DONE', result: { ok: true, itemId: 'i1' } })
  expect(selectPhase(s)).toBe('saved')
})

test('declined approval surfaces an error', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  s = reducer(s, { type: 'APPROVE_START' })
  s = reducer(s, { type: 'APPROVE_DONE', ok: false })
  expect(selectPhase(s)).toBe('error')
  expect(s.errorMessage).toContain('Memry')
})

test('save lifecycle: saving -> saved', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'ready', port: 7849 })
  s = reducer(s, { type: 'SAVE_START' })
  expect(selectPhase(s)).toBe('saving')
  s = reducer(s, { type: 'SAVE_DONE', result: { ok: true, itemId: 'i1' } })
  expect(selectPhase(s)).toBe('saved')
  expect(s.itemId).toBe('i1')
})

test('save failure then retry returns to ready', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'ready', port: 7849 })
  s = reducer(s, { type: 'SAVE_START' })
  s = reducer(s, { type: 'SAVE_DONE', result: { ok: false, error: 'invalid-capture' } })
  expect(selectPhase(s)).toBe('error')
  expect(s.errorMessage).toContain('read this capture')
  s = reducer(s, { type: 'RETRY' })
  expect(selectPhase(s)).toBe('ready')
})

test('EDIT replaces the draft', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'ready', port: 7849 })
  const edited = { ...draft, properties: { ...draft.properties, title: 'New' } }
  s = reducer(s, { type: 'EDIT', draft: edited })
  expect(s.draft?.properties.title).toBe('New')
})

describe('mapError', () => {
  test('maps known server codes to human copy', () => {
    expect(mapError('bad-token')).toContain('pair')
    expect(mapError('payload-too-large')).toContain('too large')
    expect(mapError('whatever')).toContain('reach Memry')
  })
})
