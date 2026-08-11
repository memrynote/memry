import { describe, expect, it, test } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import { initialState, mapError, reducer, selectPhase } from './popup-state'

const draft: ArticleCapture = {
  url: 'https://x.com/p',
  mode: 'article',
  contentMarkdown: '# Hi',
  excerpt: 'Hi',
  extractionStatus: 'full',
  properties: { title: 'Hi', source: 'https://x.com/p', created: 'now' },
  tags: ['clippings']
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

describe('launch lifecycle', () => {
  test('LAUNCH_START transitions to launching phase', () => {
    let s = reducer(initialState, { type: 'DRAFT_READY', draft: null })
    s = reducer(s, { type: 'STATUS', connection: 'app-closed', port: null })
    s = reducer(s, { type: 'LAUNCH_START' })
    expect(selectPhase(s)).toBe('launching')
  })

  test('LAUNCH_DONE ok:true leaves launching', () => {
    let s = reducer(initialState, { type: 'DRAFT_READY', draft: null })
    s = reducer(s, { type: 'STATUS', connection: 'app-closed', port: null })
    s = reducer(s, { type: 'LAUNCH_START' })
    s = reducer(s, { type: 'LAUNCH_DONE', ok: true })
    expect(selectPhase(s)).toBe('app-closed')
  })

  test('LAUNCH_DONE ok:false surfaces error with message', () => {
    let s = reducer(initialState, { type: 'STATUS', connection: 'app-closed', port: null })
    s = reducer(s, { type: 'LAUNCH_START' })
    s = reducer(s, { type: 'LAUNCH_DONE', ok: false })
    expect(selectPhase(s)).toBe('error')
    expect(s.errorMessage).toBe('Open Memry, then try again.')
  })
})

describe('mapError', () => {
  test('maps known server codes to human copy', () => {
    expect(mapError('bad-token')).toContain('pair')
    expect(mapError('payload-too-large')).toContain('too large')
    expect(mapError('whatever')).toContain('reach Memry')
  })

  test('a denied host permission asks the user to allow what Memry requested', () => {
    expect(mapError('permission-denied')).toBe('Allow the access Memry asked for, then save again.')
  })
})

describe('offline queue state', () => {
  it('SAVE_DONE with a queued result is a terminal queued state, not an error', () => {
    const mid = reducer(initialState, { type: 'SAVE_START' })
    const s = reducer(mid, { type: 'SAVE_DONE', result: { ok: false, error: 'queued' } })
    expect(s.action).toBe('queued')
    expect(s.errorMessage).toBeNull()
    expect(selectPhase(s)).toBe('queued')
  })

  it('SAVE_DONE with a real error still maps to error', () => {
    const s = reducer(initialState, {
      type: 'SAVE_DONE',
      result: { ok: false, error: 'bad-token' }
    })
    expect(s.action).toBe('error')
    expect(selectPhase(s)).toBe('error')
  })
})

describe('mode switching', () => {
  it('SET_MODE to selection starts capturing and resets draftReady', () => {
    const s = reducer(
      { ...initialState, draftReady: true },
      { type: 'SET_MODE', mode: 'selection' }
    )
    expect(s.mode).toBe('selection')
    expect(s.capturing).toBe(true)
    expect(s.draftReady).toBe(false)
  })

  it('SET_MODE to article does not enter capturing', () => {
    const s = reducer(initialState, { type: 'SET_MODE', mode: 'article' })
    expect(s.mode).toBe('article')
    expect(s.capturing).toBe(false)
  })

  it('DRAFT_READY clears capturing', () => {
    const mid = reducer(initialState, { type: 'SET_MODE', mode: 'screenshot' })
    const done = reducer(mid, { type: 'DRAFT_READY', draft: null })
    expect(done.capturing).toBe(false)
    expect(done.draftReady).toBe(true)
  })

  it('selectPhase returns capturing while a grab is in flight', () => {
    expect(selectPhase({ ...initialState, capturing: true })).toBe('capturing')
  })
})

describe('mapError — pdf codes', () => {
  it('explains a failed PDF download', () => {
    expect(mapError('pdf-fetch-failed')).toBe(
      "Couldn't download this PDF. Open it directly, then try again."
    )
  })

  it('explains a response that was not a PDF', () => {
    expect(mapError('not-a-pdf')).toBe("This isn't a PDF — nothing to save.")
  })

  it('names the size limit', () => {
    expect(mapError('pdf-too-large')).toBe('This PDF is too large to clip (limit 16 MB).')
  })

  it('still maps the pre-existing codes', () => {
    expect(mapError('bad-token')).toBe('Pairing expired — pair with Memry again.')
  })
})
