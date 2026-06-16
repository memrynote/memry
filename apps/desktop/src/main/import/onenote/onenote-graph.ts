/**
 * Thin Microsoft Graph client for the OneNote importer: paginate notebooks →
 * sections → pages, fetch a page's HTML content, with cooperative cancellation
 * and 429 (rate-limit) backoff mirroring the obsidian-importer approach.
 *
 * Network is fully injectable via the {@link GraphFetch} seam so tests can mock
 * responses without live auth.
 *
 * @module main/import/onenote/onenote-graph
 */

import type { OneNoteNotebook, OneNotePage, OneNoteSection } from '@memry/onenote-import'
import { createLogger } from '../../lib/logger'

const logger = createLogger('OneNoteImport')

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
/** Cap on 429 backoff waits so a stuck import still yields to cancellation. */
const MAX_BACKOFF_MS = 60_000

export type GraphFetch = (url: string, init: RequestInit) => Promise<Response>

interface GraphListResponse<T> {
  value: T[]
  '@odata.nextLink'?: string
}

interface RawNotebook {
  id: string
  displayName?: string
}
interface RawSection {
  id: string
  displayName?: string
}
interface RawPage {
  id: string
  title?: string
  createdDateTime?: string
}

export interface GraphClientDeps {
  /** Resolve a bearer token (refreshing as needed). */
  getAccessToken(): Promise<string>
  /** Network seam (defaults to global fetch). */
  fetch?: GraphFetch
  /** Cooperative cancellation check. */
  isCancelled(): boolean
  /** Status reporter for user-facing progress text. */
  status(message: string): void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createOneNoteGraphClient(deps: GraphClientDeps) {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init))

  async function request(url: string): Promise<Response> {
    let attempt = 0
    let authRetried = false
    // Loop only for 401 refresh + 429 backoff; other errors throw immediately.
    for (;;) {
      if (deps.isCancelled()) throw new Error('cancelled')
      const token = await deps.getAccessToken()
      const response = await doFetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      })

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 30
        const waitMs = Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        deps.status('OneNote is rate-limiting; waiting before retrying…')
        logger.warn('OneNote rate-limited', { waitMs, url })
        // Sleep in short slices so cancellation is honoured promptly.
        const slices = Math.ceil(waitMs / 1000)
        for (let i = 0; i < slices; i++) {
          if (deps.isCancelled()) throw new Error('cancelled')
          await sleep(Math.min(1000, waitMs - i * 1000))
        }
        attempt++
        if (attempt > 10) throw new Error('OneNote kept rate-limiting; giving up')
        continue
      }

      // A 401 usually means the access token expired mid-import; refresh + retry
      // once (getAccessToken re-mints the token on the next iteration).
      if (response.status === 401 && !authRetried) {
        authRetried = true
        continue
      }

      return response
    }
  }

  async function listAll<TRaw, TOut>(firstUrl: string, map: (raw: TRaw) => TOut): Promise<TOut[]> {
    const out: TOut[] = []
    let url: string | undefined = firstUrl
    while (url) {
      if (deps.isCancelled()) break
      const response = await request(url)
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Graph request failed (${response.status}): ${body.slice(0, 200)}`)
      }
      const json = (await response.json()) as GraphListResponse<TRaw>
      for (const raw of json.value ?? []) out.push(map(raw))
      url = json['@odata.nextLink']
    }
    return out
  }

  return {
    listNotebooks(): Promise<OneNoteNotebook[]> {
      return listAll<RawNotebook, OneNoteNotebook>(
        `${GRAPH_BASE}/me/onenote/notebooks?$select=id,displayName`,
        (n) => ({ id: n.id, displayName: n.displayName ?? 'Untitled Notebook' })
      )
    },

    listSections(notebookId: string): Promise<OneNoteSection[]> {
      return listAll<RawSection, OneNoteSection>(
        `${GRAPH_BASE}/me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections?$select=id,displayName`,
        (s) => ({ id: s.id, displayName: s.displayName ?? 'Untitled Section', notebookId })
      )
    },

    listPages(sectionId: string): Promise<OneNotePage[]> {
      return listAll<RawPage, OneNotePage>(
        `${GRAPH_BASE}/me/onenote/sections/${encodeURIComponent(sectionId)}/pages?$select=id,title,createdDateTime`,
        (p) => ({
          id: p.id,
          title: p.title ?? 'Untitled',
          sectionId,
          createdDateTime: p.createdDateTime
        })
      )
    },

    async getPageHtml(pageId: string): Promise<string> {
      const response = await request(
        `${GRAPH_BASE}/me/onenote/pages/${encodeURIComponent(pageId)}/content`
      )
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Failed to fetch page content (${response.status}): ${body.slice(0, 200)}`)
      }
      return response.text()
    }
  }
}

export type OneNoteGraphClient = ReturnType<typeof createOneNoteGraphClient>
