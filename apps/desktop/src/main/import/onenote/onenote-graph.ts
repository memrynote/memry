/**
 * Microsoft Graph client for the OneNote importer: notebooks → section groups →
 * sections → pages (paginated), page HTML+InkML content, and authenticated
 * binary downloads for attachments/images. Cooperative cancellation, 429
 * (rate-limit) backoff honouring `Retry-After`, one 401 refresh retry, and a
 * small transient-error retry for flaky resource downloads.
 *
 * Network is fully injectable via the {@link GraphFetch} seam so tests can mock
 * responses without live auth.
 *
 * @module main/import/onenote/onenote-graph
 */

import type {
  OneNoteNotebook,
  OneNoteNotebookTreeNode,
  OneNotePage,
  OneNoteSection,
  OneNoteSectionGroupTreeNode,
  OneNoteSectionSummary
} from '@memry/importers/onenote'
import type { ImportMessage } from '@memry/importers/messages'
import { createLogger } from '../../lib/logger'

const logger = createLogger('OneNoteImport')

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
/** Cap on 429 backoff waits so a stuck import still yields to cancellation. */
const MAX_BACKOFF_MS = 60_000
/** OneNote rarely sends `Retry-After`; its limits reset per minute. */
const DEFAULT_BACKOFF_SECONDS = 60
/** Give up after this many rate-limit rounds on a single request. */
const MAX_BACKOFF_ROUNDS = 10
/** Transient (network / 5xx) retries per request. */
const MAX_TRANSIENT_RETRIES = 4
/** Guard against a pathological section-group cycle. */
const MAX_GROUP_DEPTH = 10

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
interface RawSectionGroup {
  id: string
  displayName?: string
}
interface RawPage {
  id: string
  title?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  level?: number
}

export interface GraphClientDeps {
  /** Resolve a bearer token; `forceRefresh` re-mints it after a 401. */
  getAccessToken(forceRefresh?: boolean): Promise<string>
  /** Network seam (defaults to global fetch). */
  fetch?: GraphFetch
  /** Cooperative cancellation check. */
  isCancelled(): boolean
  /** Status reporter for user-facing progress text. */
  status(message: string | ImportMessage): void
  /** Emitted when a request enters rate-limit backoff. */
  onRateLimited?(): void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createOneNoteGraphClient(deps: GraphClientDeps) {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init))

  async function request(url: string): Promise<Response> {
    let backoffRounds = 0
    let transientRetries = 0
    let authRetried = false
    // Consumed by the next attempt only: leaving it set would re-mint the token
    // on every later backoff round of the same request.
    let forceRefresh = false
    for (;;) {
      if (deps.isCancelled()) throw new Error('cancelled')
      const token = await deps.getAccessToken(forceRefresh)
      forceRefresh = false

      let response: Response
      try {
        response = await doFetch(url, {
          headers: { Authorization: `Bearer ${token}` }
        })
      } catch (error) {
        // Resource downloads occasionally drop mid-import on healthy networks;
        // retry a few times before failing the item.
        transientRetries++
        if (transientRetries > MAX_TRANSIENT_RETRIES) throw error
        logger.warn('OneNote request failed, retrying', { url, attempt: transientRetries })
        await sleep(1000 * transientRetries)
        continue
      }

      if (response.status === 429) {
        // `Retry-After: 0` means "retry now"; only a missing or non-numeric
        // (HTTP-date) header falls back to the default minute.
        const header = response.headers.get('Retry-After')
        const parsed = header === null ? Number.NaN : Number(header)
        const retryAfter = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BACKOFF_SECONDS
        const waitMs = Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        deps.onRateLimited?.()
        logger.warn('OneNote rate-limited', { waitMs, url })
        // Sleep in short slices so cancellation is honoured promptly.
        const slices = Math.ceil(waitMs / 1000)
        for (let i = 0; i < slices; i++) {
          if (deps.isCancelled()) throw new Error('cancelled')
          await sleep(Math.min(1000, waitMs - i * 1000))
        }
        backoffRounds++
        if (backoffRounds > MAX_BACKOFF_ROUNDS) {
          throw new Error('OneNote kept rate-limiting; giving up')
        }
        continue
      }

      // A 401 usually means the access token expired mid-import; force one
      // refresh (the next getAccessToken call re-mints) and retry once.
      if (response.status === 401 && !authRetried) {
        authRetried = true
        forceRefresh = true
        continue
      }

      if (response.status >= 500 && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++
        logger.warn('OneNote server error, retrying', { url, status: response.status })
        await sleep(1000 * transientRetries)
        continue
      }

      return response
    }
  }

  async function requireOk(response: Response, what: string): Promise<Response> {
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`${what} failed (${response.status}): ${body.slice(0, 200)}`)
    }
    return response
  }

  async function listAll<TRaw, TOut>(firstUrl: string, map: (raw: TRaw) => TOut): Promise<TOut[]> {
    const out: TOut[] = []
    let url: string | undefined = firstUrl
    while (url) {
      if (deps.isCancelled()) break
      const response = await requireOk(await request(url), 'Graph request')
      const json = (await response.json()) as GraphListResponse<TRaw>
      for (const raw of json.value ?? []) out.push(map(raw))
      url = json['@odata.nextLink']
    }
    return out
  }

  const toSectionSummary = (s: RawSection): OneNoteSectionSummary => ({
    id: s.id,
    displayName: s.displayName ?? 'Untitled Section'
  })

  function listNotebookSections(notebookId: string): Promise<OneNoteSectionSummary[]> {
    return listAll<RawSection, OneNoteSectionSummary>(
      `${GRAPH_BASE}/me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections?$select=id,displayName`,
      toSectionSummary
    )
  }

  function listGroupSections(groupId: string): Promise<OneNoteSectionSummary[]> {
    return listAll<RawSection, OneNoteSectionSummary>(
      `${GRAPH_BASE}/me/onenote/sectionGroups/${encodeURIComponent(groupId)}/sections?$select=id,displayName`,
      toSectionSummary
    )
  }

  function listChildGroups(parent: {
    kind: 'notebook' | 'group'
    id: string
  }): Promise<RawSectionGroup[]> {
    const base =
      parent.kind === 'notebook'
        ? `${GRAPH_BASE}/me/onenote/notebooks/${encodeURIComponent(parent.id)}/sectionGroups`
        : `${GRAPH_BASE}/me/onenote/sectionGroups/${encodeURIComponent(parent.id)}/sectionGroups`
    return listAll<RawSectionGroup, RawSectionGroup>(`${base}?$select=id,displayName`, (g) => g)
  }

  async function buildGroupTree(
    group: RawSectionGroup,
    depth: number
  ): Promise<OneNoteSectionGroupTreeNode> {
    const node: OneNoteSectionGroupTreeNode = {
      id: group.id,
      displayName: group.displayName ?? 'Untitled Group',
      sections: await listGroupSections(group.id),
      sectionGroups: []
    }
    if (depth < MAX_GROUP_DEPTH && !deps.isCancelled()) {
      for (const child of await listChildGroups({ kind: 'group', id: group.id })) {
        if (deps.isCancelled()) break
        node.sectionGroups.push(await buildGroupTree(child, depth + 1))
      }
    }
    return node
  }

  return {
    listNotebooks(): Promise<OneNoteNotebook[]> {
      return listAll<RawNotebook, OneNoteNotebook>(
        `${GRAPH_BASE}/me/onenote/notebooks?$select=id,displayName`,
        (n) => ({ id: n.id, displayName: n.displayName ?? 'Untitled Notebook' })
      )
    },

    /** Full notebook → section-group → section tree (for the picker + import). */
    async listNotebookTrees(): Promise<OneNoteNotebookTreeNode[]> {
      const notebooks = await this.listNotebooks()
      const trees: OneNoteNotebookTreeNode[] = []
      for (const notebook of notebooks) {
        if (deps.isCancelled()) break
        const tree: OneNoteNotebookTreeNode = {
          id: notebook.id,
          displayName: notebook.displayName,
          sections: await listNotebookSections(notebook.id),
          sectionGroups: []
        }
        for (const group of await listChildGroups({ kind: 'notebook', id: notebook.id })) {
          if (deps.isCancelled()) break
          tree.sectionGroups.push(await buildGroupTree(group, 1))
        }
        trees.push(tree)
      }
      return trees
    },

    listPages(sectionId: string): Promise<OneNotePage[]> {
      const params = new URLSearchParams({
        $select: 'id,title,createdDateTime,lastModifiedDateTime,level',
        $orderby: 'order',
        pagelevel: 'true'
      })
      return listAll<RawPage, OneNotePage>(
        `${GRAPH_BASE}/me/onenote/sections/${encodeURIComponent(sectionId)}/pages?${params.toString()}`,
        (p) => ({
          id: p.id,
          title: p.title ?? 'Untitled',
          sectionId,
          createdDateTime: p.createdDateTime,
          lastModifiedDateTime: p.lastModifiedDateTime,
          level: p.level
        })
      )
    },

    /** Page content as multipart HTML + InkML (ink included when present). */
    async getPageContent(pageId: string): Promise<string> {
      const response = await requireOk(
        await request(
          `${GRAPH_BASE}/me/onenote/pages/${encodeURIComponent(pageId)}/content?includeInkML=true`
        ),
        'Fetching page content'
      )
      return response.text()
    },

    /** Download an authenticated Graph resource (image / file attachment). */
    async fetchBinary(url: string): Promise<Buffer> {
      const response = await requireOk(await request(url), 'Downloading attachment')
      return Buffer.from(await response.arrayBuffer())
    }
  }
}

export type OneNoteGraphClient = ReturnType<typeof createOneNoteGraphClient>

/** Flatten a notebook tree into the flat section list `mapTree` consumes. */
export function flattenNotebookSections(tree: OneNoteNotebookTreeNode): OneNoteSection[] {
  const sections: OneNoteSection[] = []
  const visit = (
    groups: OneNoteSectionGroupTreeNode[],
    ownSections: OneNoteSectionSummary[],
    groupPath: string[]
  ): void => {
    for (const section of ownSections) {
      sections.push({
        id: section.id,
        displayName: section.displayName,
        notebookId: tree.id,
        ...(groupPath.length > 0 ? { groupPath } : {})
      })
    }
    for (const group of groups) {
      visit(group.sectionGroups, group.sections, [...groupPath, group.displayName])
    }
  }
  visit(tree.sectionGroups, tree.sections, [])
  return sections
}
