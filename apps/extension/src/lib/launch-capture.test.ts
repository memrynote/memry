import { describe, expect, it } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import { launchAndCapture, type LaunchCaptureDeps } from './launch-capture'
import type { CaptureResponse, PairResponse } from './messages'

const article: ArticleCapture = {
  url: 'https://example.com/post',
  mode: 'article',
  contentMarkdown: '# Post',
  excerpt: 'Post',
  extractionStatus: 'full',
  properties: { title: 'Post', source: 'https://example.com/post', created: 'now' },
  tags: ['clippings']
}

const pdf: ArticleCapture = {
  ...article,
  url: 'https://example.com/a.pdf',
  mode: 'pdf',
  pdfDataUrl: 'data:application/pdf;base64,JVBERi0='
}

interface Desktop {
  serverUp: boolean
  vaultOpen: boolean
  pair: PairResponse
}

// A background worker talking to a fake desktop app. `openApp` is the moment the
// browser closes the popup, so `storedWhenAppOpened` is everything that survives it.
function world(desktop: Desktop) {
  const stored: { id: string; capture: ArticleCapture }[] = []
  const inbox: string[] = []
  let storedWhenAppOpened: string[] = []
  const post = async (capture: ArticleCapture): Promise<CaptureResponse> => {
    if (!desktop.vaultOpen) return { ok: false, error: 'vault-closed' }
    inbox.push(capture.url)
    return { ok: true, itemId: `item-${inbox.length}` }
  }
  const deps: LaunchCaptureDeps = {
    enqueue: async (capture) => {
      const id = `q${stored.length + 1}`
      stored.push({ id, capture })
      return id
    },
    openApp: async () => {
      storedWhenAppOpened = stored.map((s) => s.capture.url)
    },
    waitForServer: async () => desktop.serverUp,
    ensurePaired: async () => desktop.pair,
    deliverQueued: async (id) => {
      const index = stored.findIndex((s) => s.id === id)
      const res = await post(stored[index].capture)
      if (res.ok) stored.splice(index, 1)
      return res
    },
    send: post
  }
  return {
    deps,
    inbox,
    stored: () => stored.map((s) => s.capture.url),
    storedWhenAppOpened: () => storedWhenAppOpened
  }
}

describe('launchAndCapture', () => {
  it('persists the capture before the app launch closes the popup, then delivers it', async () => {
    const w = world({ serverUp: true, vaultOpen: true, pair: { ok: true } })

    const res = await launchAndCapture(article, w.deps)

    expect(w.storedWhenAppOpened()).toEqual(['https://example.com/post'])
    expect(res).toEqual({ ok: true, itemId: 'item-1' })
    expect(w.inbox).toEqual(['https://example.com/post'])
    expect(w.stored()).toEqual([])
  })

  it('keeps the capture queued when the app is still opening its vault after the wait', async () => {
    const w = world({ serverUp: false, vaultOpen: true, pair: { ok: true } })

    const res = await launchAndCapture(article, w.deps)

    expect(res).toEqual({ ok: false, error: 'queued' })
    expect(w.stored()).toEqual(['https://example.com/post'])
  })

  it('keeps the capture queued and says why when the app opened onto the vault picker', async () => {
    const w = world({ serverUp: true, vaultOpen: false, pair: { ok: true } })

    const res = await launchAndCapture(article, w.deps)

    expect(res).toEqual({ ok: false, error: 'queued-vault-closed' })
    expect(w.stored()).toEqual(['https://example.com/post'])
  })

  it('reports a declined pairing and keeps the capture for the next send', async () => {
    const w = world({ serverUp: true, vaultOpen: true, pair: { ok: false, error: 'pair-denied' } })

    const res = await launchAndCapture(article, w.deps)

    expect(res).toEqual({ ok: false, error: 'pair-denied' })
    expect(w.stored()).toEqual(['https://example.com/post'])
    expect(w.inbox).toEqual([])
  })

  it('sends a PDF directly because its bytes are too large to queue', async () => {
    const w = world({ serverUp: true, vaultOpen: true, pair: { ok: true } })

    const res = await launchAndCapture(pdf, w.deps)

    expect(res).toEqual({ ok: true, itemId: 'item-1' })
    expect(w.storedWhenAppOpened()).toEqual([])
    expect(w.inbox).toEqual(['https://example.com/a.pdf'])
  })

  it('reports app-closed for a PDF when the app never comes up', async () => {
    const w = world({ serverUp: false, vaultOpen: true, pair: { ok: true } })

    expect(await launchAndCapture(pdf, w.deps)).toEqual({ ok: false, error: 'app-closed' })
  })
})
