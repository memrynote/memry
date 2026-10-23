/**
 * A stateful stand-in for `GET /api/v2/export/`, with the semantics the sync
 * engine depends on (#1408 "The API we use"): `updatedAfter` returns only the
 * highlights updated after the date, grouped by book; `ids` returns the whole
 * books; deleted highlights and books appear only with `includeDeleted`; pages
 * go through `pageCursor`. Tests mutate `books` between runs, as Readwise would.
 */
import type { ReadwiseBook, ReadwiseHighlight } from '@memry/importers/readwise'

/** A book whose highlights are always there, so a test can push to them. */
export type StubBook = ReadwiseBook & { highlights: ReadwiseHighlight[] }

export class ReadwiseStub {
  books: StubBook[] = []
  pageSize = 2
  requests: URL[] = []
  /** Answer the request with this status instead (a crash, a rate limit). */
  failWhen: ((url: URL) => number | null) | null = null

  handle = async (input: string): Promise<Response> => {
    const url = new URL(input)
    this.requests.push(url)
    const status = this.failWhen?.(url) ?? null
    if (status !== null) return new Response('', { status })

    const includeDeleted = url.searchParams.get('includeDeleted') === 'true'
    const after = url.searchParams.get('updatedAfter')
    const ids = url.searchParams.get('ids')?.split(',').map(Number)

    const selected: StubBook[] = []
    for (const book of this.books) {
      if (ids && !ids.includes(book.user_book_id)) continue
      if (book.is_deleted && !includeDeleted) continue
      let highlights: ReadwiseHighlight[] = book.highlights.filter(
        (h) => includeDeleted || !h.is_deleted
      )
      if (after) {
        highlights = highlights.filter((h) => Date.parse(h.updated_at ?? '') > Date.parse(after))
        if (highlights.length === 0) continue
      }
      selected.push({ ...book, highlights })
    }

    const index = Number(url.searchParams.get('pageCursor') ?? '0')
    const results = selected.slice(index * this.pageSize, (index + 1) * this.pageSize)
    const more = (index + 1) * this.pageSize < selected.length
    return new Response(
      JSON.stringify({ nextPageCursor: more ? String(index + 1) : null, results }),
      { status: 200 }
    )
  }

  /** Requests since `mark`, by kind. */
  since(mark: number): { all: URL[]; ids: URL[]; windowed: URL[]; full: URL[] } {
    const all = this.requests.slice(mark)
    return {
      all,
      ids: all.filter((u) => u.searchParams.has('ids')),
      windowed: all.filter((u) => u.searchParams.has('updatedAfter')),
      full: all.filter((u) => !u.searchParams.has('ids') && !u.searchParams.has('updatedAfter'))
    }
  }
}
