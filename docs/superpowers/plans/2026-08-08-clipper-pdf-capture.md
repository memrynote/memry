# Clipper PDF Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the active browser tab is a PDF, the web clipper saves the actual PDF file into the Memry inbox as a `pdf` item instead of showing "Couldn't read this page".

**Architecture:** Content scripts never inject into Chrome's or Firefox's built-in PDF viewer, so the popup's `EXTRACT` message rejects on a PDF tab. We treat "`EXTRACT` failed on an `http(s)` tab" as "this is a PDF" and build a provisional draft from tab metadata. On Send, the popup requests the PDF origin's host permission in the same `permissions.request` call that already asks for loopback, then the background service worker fetches the PDF with cookies, verifies the `%PDF-` magic bytes, enforces a 16 MB cap, and base64-encodes it into a new optional `pdfDataUrl` field on the existing `/capture` payload. The desktop decodes it exactly the way it already decodes `screenshotDataUrl` and stores it through `storeInboxAttachment`, producing a `pdf` inbox row identical in shape to the existing drag-and-drop path.

**Tech Stack:** TypeScript, WXT (extension build), React 19 (popup), Vitest (all tests), Zod v4 (contracts), Drizzle ORM + better-sqlite3 (desktop), Electron main process.

**Spec:** `docs/superpowers/specs/2026-08-08-clipper-pdf-capture-design.md`
**Issue:** https://github.com/memrynote/memry/issues/1160

## Global Constraints

- **Backward compatibility is mandatory.** Real users run this on real data. All contract fields added here are optional; the `mode` enum is only ever extended, never narrowed. An older extension posting to a newer desktop must keep working unchanged.
- **Release ordering:** the desktop change (Tasks 1–2) must ship **before or with** the extension change (Tasks 3–6). A newer extension against an older desktop gets a 422 `invalid-capture` for every PDF clip.
- **Raw PDF size cap: exactly `16 * 1024 * 1024` bytes.** Enforced client-side before base64 encoding. The desktop `/capture` body cap is 25 MB (`apps/desktop/src/main/capture/server.ts:38`) and base64 inflates by ~4/3; 16 MB leaves headroom for the JSON envelope. Do not change the server's 25 MB cap.
- **PDF MIME is exactly `'application/pdf'`.** It is the only member of `ALLOWED_DOCUMENT_TYPES` (`apps/desktop/src/main/inbox/attachments.ts:69`).
- **Logging:** desktop code uses `createLogger('Scope')`, never raw `console.*`. Extension code already uses `console.warn` in `background.ts`; match the file you are in.
- **Cross-browser:** no Chrome-only APIs. No `chrome.pdfViewerPrivate`, no `downloads` permission. Everything used here (`permissions.request` from a popup gesture, `fetch` with `credentials: 'include'`, `optional_host_permissions`) works on Chrome, Edge, and Firefox MV3 (manifest pins `strict_min_version: '140.0'`).
- **Out of scope, do not implement:** PDFs embedded via `<embed>`/`<iframe>` inside a normal page; raising `MAX_INBOX_FILE_SIZE`; offline queueing of PDF captures.
- **Tailwind logical properties:** any new popup markup uses `ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`/`text-start`, never `ml-*`/`mr-*`/`left-*`/`text-left`.
- **Commits:** no `Co-Authored-By` trailers.

## File Structure

| File                                            | Responsibility                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/capture-api.ts`         | Zod schema for the `/capture` payload. Gains `'pdf'` mode + two optional fields.                                                                                |
| `packages/article-extract/src/map.ts`           | The `ArticleCapture` TypeScript interface shared by extension and desktop. Mirrors the schema.                                                                  |
| `apps/desktop/src/main/inbox/ingest.ts`         | Turns a capture into an inbox row. Gains a PDF branch beside the existing screenshot branch.                                                                    |
| `apps/extension/src/lib/pdf-capture.ts`         | **New.** All pure PDF logic: origin pattern, filename derivation, magic-byte check, size cap, provisional draft builder. No browser APIs — fully unit-testable. |
| `apps/extension/src/lib/capture-permissions.ts` | Host-permission helpers. Gains a combined loopback + page-origin request.                                                                                       |
| `apps/extension/src/lib/capture-queue.ts`       | Queue predicates. Gains `isQueueable` so PDFs never enter `storage.local`.                                                                                      |
| `apps/extension/src/lib/messages.ts`            | Message-type union between popup, content script, and background. Gains `FETCH_PDF`.                                                                            |
| `apps/extension/src/entrypoints/background.ts`  | Service worker. Gains the `FETCH_PDF` handler, the queue guard, and the shortcut PDF branch.                                                                    |
| `apps/extension/src/entrypoints/popup/App.tsx`  | Popup UI. Gains the provisional-draft fallback and the PDF send path.                                                                                           |
| `apps/extension/src/lib/popup-state.ts`         | Reducer + error-code-to-message mapping. Gains three error codes.                                                                                               |
| `apps/extension/wxt.config.ts`                  | Manifest. Gains `optional_host_permissions`.                                                                                                                    |
| `apps/docs/src/user-guide/inbox/capturing.md`   | User docs for the clipper. Gains a PDF section.                                                                                                                 |

`pdf-capture.ts` is deliberately free of `browser.*` calls: everything with a decision in it is pure, so the tests need no extension runtime, and `background.ts` stays a thin wiring layer.

---

### Task 1: Contract and shared type accept PDF captures

**Files:**

- Modify: `packages/contracts/src/capture-api.ts`
- Modify: `packages/contracts/src/capture-api.test.ts`
- Modify: `packages/article-extract/src/map.ts:9-27`

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `ArticleCaptureSchema` accepting `mode: 'pdf'` plus optional `pdfDataUrl: string` and `pdfFilename: string`.
  - `ArticleCapture` interface with `mode: 'article' | 'selection' | 'screenshot' | 'pdf'`, `pdfDataUrl?: string`, `pdfFilename?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/src/capture-api.test.ts`:

```ts
describe('ArticleCaptureSchema — pdf mode', () => {
  const base = {
    url: 'https://example.com/paper.pdf',
    contentMarkdown: '',
    excerpt: '',
    extractionStatus: 'full' as const,
    properties: {
      title: 'paper',
      source: 'https://example.com/paper.pdf',
      created: '2026-08-08T00:00:00.000Z'
    }
  }

  it('accepts a pdf capture carrying bytes and a filename', () => {
    const parsed = ArticleCaptureSchema.safeParse({
      ...base,
      mode: 'pdf',
      force: true,
      pdfDataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
      pdfFilename: 'paper.pdf'
    })
    expect(parsed.success).toBe(true)
  })

  it('still accepts an article capture with none of the pdf fields (old extensions)', () => {
    const parsed = ArticleCaptureSchema.safeParse({
      ...base,
      mode: 'article',
      contentMarkdown: '# Hello'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown mode', () => {
    const parsed = ArticleCaptureSchema.safeParse({ ...base, mode: 'epub' })
    expect(parsed.success).toBe(false)
  })
})
```

Read the top of the existing file first and reuse its import style rather than adding a second import of the same symbols.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @memry/contracts test -- capture-api
```

Expected: FAIL — the `mode: 'pdf'` case fails because the enum has only three members.

- [ ] **Step 3: Extend the schema**

In `packages/contracts/src/capture-api.ts`, inside `ArticleCaptureSchema`:

```ts
  mode: z.enum(['article', 'selection', 'screenshot', 'pdf']),
```

and add, next to `screenshotDataUrl`:

```ts
  // Base64 data URL of the tab's PDF, set only by the extension's pdf mode.
  // Capped at 16MB raw client-side so it fits the /capture body limit.
  pdfDataUrl: z.string().optional(),
  pdfFilename: z.string().optional(),
```

- [ ] **Step 4: Mirror the change on the shared TypeScript type**

In `packages/article-extract/src/map.ts`, change the `ArticleCapture` interface:

```ts
mode: 'article' | 'selection' | 'screenshot' | 'pdf'
```

and add below `screenshotDataUrl?: string`:

```ts
  pdfDataUrl?: string
  pdfFilename?: string
```

Leave `mapToArticleCapture` alone — it only ever produces `mode: 'article'`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @memry/contracts test -- capture-api
```

Expected: PASS, all three new cases.

- [ ] **Step 6: Verify the contract boundary is still clean**

```bash
pnpm ipc:generate && pnpm ipc:check
```

Expected: no diff and no errors. (Run in this order — `ipc:check` validates what `ipc:generate` emits.)

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/capture-api.ts packages/contracts/src/capture-api.test.ts packages/article-extract/src/map.ts
git commit -m "feat(contracts): accept pdf-mode captures with attached bytes"
```

---

### Task 2: Desktop stores a captured PDF as a `pdf` inbox item

**Files:**

- Modify: `apps/desktop/src/main/inbox/ingest.ts`
- Modify: `apps/desktop/src/main/inbox/ingest.test.ts`

**Interfaces:**

- Consumes: `ArticleCapture.pdfDataUrl` / `.pdfFilename` from Task 1.
- Produces: an inbox row with `type: 'pdf'`, `content: null`, `attachmentPath` set, and metadata shaped `{ originalFilename, fileSize, mimeType, url, excerpt, extractionStatus, heroImage, properties }`.

**Background the implementer needs:**

`ingest.ts` already has a `screenshotDataUrl` branch (lines 89–104) that decodes a data URL and writes an attachment. The PDF branch sits directly after it and follows the same shape. Two existing helpers do the work:

- `parseDataUrl(str)` → `{ mime, buffer } | null` (`./parse-data-url`)
- `storeInboxAttachment(itemId, buffer, filename, mimeType)` → `{ success, path?, error? }` (`./attachments`) — already validates `application/pdf` and enforces `MAX_INBOX_FILE_SIZE` (50 MB)

The `{ originalFilename, fileSize, mimeType }` metadata triple is copied deliberately from `captureImageItem` (`apps/desktop/src/main/inbox/domain.ts:299`), the drag-and-drop path that already produces `pdf` items. Matching it means the inbox list, the in-app PDF viewer, and `fileBinaryToFolder` work with zero changes elsewhere.

`ingest.ts` does not currently set `attachmentPath` on its insert at all — this task threads it through for the first time.

- [ ] **Step 1: Extend the existing `./attachments` mock**

`ingest.test.ts:16-18` mocks `./attachments` with only `getItemAttachmentsDir`, so `storeInboxAttachment` is currently `undefined` inside tests. Replace that mock block with:

```ts
const storeInboxAttachment = vi.fn()
vi.mock('./attachments', () => ({
  getItemAttachmentsDir: vi.fn(() => '/tmp/inbox-item'),
  storeInboxAttachment: (...args: unknown[]) => storeInboxAttachment(...args)
}))
```

and add to the `beforeEach` reset block:

```ts
storeInboxAttachment.mockReset()
storeInboxAttachment.mockResolvedValue({
  success: true,
  path: 'attachments/inbox/x/ab12-paper.pdf'
})
```

- [ ] **Step 2: Write the failing tests**

Append inside the existing `describe('ingestArticleCapture', ...)` block:

```ts
const pdfInput = {
  url: 'https://example.com/paper.pdf',
  mode: 'pdf' as const,
  contentMarkdown: '',
  excerpt: '',
  extractionStatus: 'full' as const,
  force: true,
  pdfDataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
  pdfFilename: 'paper.pdf',
  properties: {
    title: 'paper',
    source: 'https://example.com/paper.pdf',
    created: '2026-08-08T00:00:00.000Z'
  }
}

it('stores the pdf bytes and creates a pdf item', async () => {
  const { ingestArticleCapture } = await import('./ingest')
  await ingestArticleCapture(pdfInput, 'browser-extension')

  expect(storeInboxAttachment).toHaveBeenCalledOnce()
  const [, buffer, filename, mime] = storeInboxAttachment.mock.calls[0]
  expect(filename).toBe('paper.pdf')
  expect(mime).toBe('application/pdf')
  expect((buffer as Buffer).subarray(0, 5).toString()).toBe('%PDF-')

  const [row] = insertSpy.mock.calls[0]
  expect(row.type).toBe('pdf')
  expect(row.content).toBeNull()
  expect(row.attachmentPath).toBe('attachments/inbox/x/ab12-paper.pdf')
  expect(row.sourceUrl).toBe('https://example.com/paper.pdf')
  expect(row.metadata.originalFilename).toBe('paper.pdf')
  expect(row.metadata.mimeType).toBe('application/pdf')
  expect(row.metadata.fileSize).toBeGreaterThan(0)
})

it('falls back to a link item when the data URL is not a pdf', async () => {
  const { ingestArticleCapture } = await import('./ingest')
  await ingestArticleCapture(
    { ...pdfInput, pdfDataUrl: 'data:text/html;base64,PGh0bWw+' },
    'browser-extension'
  )

  expect(storeInboxAttachment).not.toHaveBeenCalled()
  const [row] = insertSpy.mock.calls[0]
  expect(row.type).toBe('link')
  expect(row.attachmentPath).toBeNull()
})

it('falls back to a link item when storing the attachment fails', async () => {
  storeInboxAttachment.mockResolvedValue({ success: false, error: 'File too large' })
  const { ingestArticleCapture } = await import('./ingest')
  await ingestArticleCapture(pdfInput, 'browser-extension')

  const [row] = insertSpy.mock.calls[0]
  expect(row.type).toBe('link')
  expect(row.attachmentPath).toBeNull()
})

it('defaults the filename when the extension sent none', async () => {
  const { ingestArticleCapture } = await import('./ingest')
  const { pdfFilename: _omitted, ...noFilename } = pdfInput
  await ingestArticleCapture(noFilename, 'browser-extension')

  expect(storeInboxAttachment.mock.calls[0][2]).toBe('document.pdf')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm --filter @memry/desktop test:main -- ingest
```

Expected: FAIL — `storeInboxAttachment` is never called and `row.type` is `'link'`.

- [ ] **Step 4: Implement the PDF branch**

In `apps/desktop/src/main/inbox/ingest.ts`, first extend the input type (around line 19):

```ts
export interface IngestArticleCaptureInput extends ArticleCapture {
  itemId?: string
  itemType?: 'link' | 'clip' | 'pdf'
  tags?: string[]
  force?: boolean
}
```

Add the import beside the existing attachments import:

```ts
import { getItemAttachmentsDir, storeInboxAttachment } from './attachments'
```

(That import line already exists — leave it as is if `storeInboxAttachment` is already named.)

Then, directly after the `screenshotDataUrl` block (which ends at the `}` before `const thumbnailPath = ...`), insert:

```ts
// PDF mode: the extension fetched the tab's PDF and base64'd it. Decode into an
// inbox attachment and file it as a `pdf` item — the same row shape the
// drag-and-drop path produces, so the viewer and folder filing need no changes.
// Any failure here degrades to a plain link item rather than losing the clip.
let pdfPath: string | null = null
let pdfMetadata: Record<string, unknown> = {}
if (input.pdfDataUrl) {
  const parsed = parseDataUrl(input.pdfDataUrl)
  if (!parsed || parsed.mime !== 'application/pdf') {
    log.warn('pdf capture had a non-pdf data url', { itemId: id, mime: parsed?.mime })
  } else {
    const filename = input.pdfFilename ?? 'document.pdf'
    const stored = await storeInboxAttachment(id, parsed.buffer, filename, 'application/pdf')
    if (stored.success && stored.path) {
      pdfPath = stored.path
      pdfMetadata = {
        originalFilename: filename,
        fileSize: parsed.buffer.length,
        mimeType: 'application/pdf'
      }
    } else {
      log.warn('pdf attachment failed', { itemId: id, error: stored.error })
    }
  }
}
```

Then change the insert call. Replace the `type`, `content`, and `metadata` fields and add `attachmentPath`:

```ts
      type: input.itemType ?? (pdfPath ? 'pdf' : 'link'),
      title: input.properties.title,
      content: pdfPath ? null : content,
      sourceUrl: input.url,
      attachmentPath: pdfPath,
      thumbnailPath,
      createdAt: now,
      modifiedAt: now,
      processingStatus: 'complete',
      captureSource: source,
      metadata: {
        url: input.url,
        fetchStatus: 'complete',
        excerpt: input.excerpt,
        extractionStatus: input.extractionStatus,
        heroImage: input.heroImage,
        properties: input.properties,
        ...pdfMetadata
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @memry/desktop test:main -- ingest
```

Expected: PASS — all four new cases, and the four pre-existing cases still green (the `link` path is unchanged because `pdfPath` stays `null` when `pdfDataUrl` is absent).

- [ ] **Step 6: Typecheck the main process**

```bash
pnpm --filter @memry/desktop typecheck:node
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/inbox/ingest.ts apps/desktop/src/main/inbox/ingest.test.ts
git commit -m "feat(inbox): file a clipped PDF as a pdf inbox item"
```

---

### Task 3: Pure PDF helpers in the extension

**Files:**

- Create: `apps/extension/src/lib/pdf-capture.ts`
- Create: `apps/extension/src/lib/pdf-capture.test.ts`

**Interfaces:**

- Consumes: `ArticleCapture` from Task 1.
- Produces (all imported by Tasks 4–6):
  - `MAX_PDF_BYTES: number` — `16 * 1024 * 1024`
  - `originPatternOf(url: string): string | null` — `'https://example.com/*'`, or `null` for non-`http(s)`
  - `pdfFilenameFrom(url: string, contentDisposition: string | null): string` — always ends in `.pdf`
  - `isPdfBytes(bytes: Uint8Array): boolean` — `%PDF-` magic-byte check
  - `buildPdfDraft(tab: { url?: string; title?: string }, now?: string): ArticleCapture | null`

**Background the implementer needs:**

This module holds every decision the PDF path makes, and touches no `browser.*` API, so it is testable with plain Vitest. `background.ts` and `App.tsx` become thin callers.

`buildPdfDraft` returns the _provisional_ draft: the popup can show and edit it before any bytes exist, because fetching the bytes needs a host permission that only a user gesture can request. `force: true` is essential — it skips `findDuplicateByUrl` on the desktop, whose enrichment branch only updates `content`/`metadata` and would silently discard the PDF bytes. Screenshot mode sets `force` for the same structural reason.

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/lib/pdf-capture.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildPdfDraft,
  isPdfBytes,
  MAX_PDF_BYTES,
  originPatternOf,
  pdfFilenameFrom
} from './pdf-capture'

describe('originPatternOf', () => {
  it('builds a host pattern for http and https', () => {
    expect(originPatternOf('https://example.com/docs/paper.pdf')).toBe('https://example.com/*')
    expect(originPatternOf('http://files.test:8080/a.pdf')).toBe('http://files.test:8080/*')
  })

  it('returns null for schemes we can never fetch', () => {
    expect(originPatternOf('chrome://settings')).toBeNull()
    expect(originPatternOf('file:///tmp/a.pdf')).toBeNull()
    expect(originPatternOf('blob:https://example.com/abc')).toBeNull()
    expect(originPatternOf('not a url')).toBeNull()
  })
})

describe('pdfFilenameFrom', () => {
  it('prefers a quoted Content-Disposition filename', () => {
    expect(pdfFilenameFrom('https://x.test/dl?id=9', 'attachment; filename="Q3 Report.pdf"')).toBe(
      'Q3 Report.pdf'
    )
  })

  it('reads an unquoted Content-Disposition filename', () => {
    expect(pdfFilenameFrom('https://x.test/dl', 'attachment; filename=report.pdf')).toBe(
      'report.pdf'
    )
  })

  it('falls back to the URL path segment', () => {
    expect(pdfFilenameFrom('https://x.test/docs/paper.pdf?v=2', null)).toBe('paper.pdf')
  })

  it('decodes a percent-encoded path segment', () => {
    expect(pdfFilenameFrom('https://x.test/docs/my%20paper.pdf', null)).toBe('my paper.pdf')
  })

  it('appends .pdf when the source name lacks it', () => {
    expect(pdfFilenameFrom('https://x.test/download', null)).toBe('download.pdf')
  })

  it('falls back to document.pdf when there is no usable name', () => {
    expect(pdfFilenameFrom('https://x.test/', null)).toBe('document.pdf')
  })

  it('strips path separators out of a hostile Content-Disposition', () => {
    expect(pdfFilenameFrom('https://x.test/a.pdf', 'attachment; filename="../../etc/passwd"')).toBe(
      '.._.._etc_passwd.pdf'
    )
  })
})

describe('isPdfBytes', () => {
  it('accepts a real PDF header', () => {
    expect(isPdfBytes(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true)
  })

  it('rejects an HTML login page served with a 200', () => {
    expect(isPdfBytes(new TextEncoder().encode('<!doctype html><html>'))).toBe(false)
  })

  it('rejects a response too short to have a header', () => {
    expect(isPdfBytes(new Uint8Array([0x25, 0x50]))).toBe(false)
  })
})

describe('buildPdfDraft', () => {
  const now = '2026-08-08T00:00:00.000Z'

  it('builds a forced pdf draft titled from the URL filename', () => {
    const draft = buildPdfDraft({ url: 'https://x.test/docs/paper.pdf', title: 'paper.pdf' }, now)
    expect(draft).toEqual({
      url: 'https://x.test/docs/paper.pdf',
      mode: 'pdf',
      contentMarkdown: '',
      excerpt: '',
      extractionStatus: 'full',
      force: true,
      tags: ['clippings'],
      properties: {
        title: 'paper',
        source: 'https://x.test/docs/paper.pdf',
        created: now
      }
    })
  })

  it('falls back to the tab title when the URL yields no name', () => {
    const draft = buildPdfDraft({ url: 'https://x.test/', title: 'Annual Report' }, now)
    expect(draft?.properties.title).toBe('Annual Report')
  })

  it('returns null for a tab we could never fetch', () => {
    expect(buildPdfDraft({ url: 'chrome://settings', title: 'Settings' }, now)).toBeNull()
    expect(buildPdfDraft({ url: undefined, title: 'x' }, now)).toBeNull()
  })
})

describe('MAX_PDF_BYTES', () => {
  it('is 16MB, leaving headroom under the 25MB /capture body cap after base64', () => {
    expect(MAX_PDF_BYTES).toBe(16 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @memry/extension test -- pdf-capture
```

Expected: FAIL — cannot resolve `./pdf-capture`.

- [ ] **Step 3: Implement the module**

Create `apps/extension/src/lib/pdf-capture.ts`:

```ts
import type { ArticleCapture } from '@memry/article-extract'

// Raw cap, enforced before base64 so an oversized PDF fails fast instead of
// 413-ing after we've spent the memory encoding it. The desktop /capture body
// limit is 25MB and base64 inflates by ~4/3, so 16MB leaves envelope headroom.
export const MAX_PDF_BYTES = 16 * 1024 * 1024

const PDF_MAGIC = '%PDF-'

// Host-permission match pattern for a page we may need to re-fetch. Only http(s)
// is fetchable with the user's cookies; blob:, file: and chrome: never are.
export function originPatternOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.origin}/*`
  } catch {
    return null
  }
}

function sanitize(name: string): string {
  return name.replace(/[/\\]/g, '_').trim()
}

function fromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)
  const bare = /filename\s*=\s*([^;]+)/i.exec(header)
  const raw = quoted?.[1] ?? bare?.[1]
  return raw ? sanitize(raw) || null : null
}

function fromUrlPath(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (!last) return null
    return sanitize(decodeURIComponent(last)) || null
  } catch {
    return null
  }
}

// Best available name for the stored file, always ending in .pdf.
export function pdfFilenameFrom(url: string, contentDisposition: string | null): string {
  const name = fromContentDisposition(contentDisposition) ?? fromUrlPath(url) ?? 'document'
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}

// Cheap proof the bytes really are a PDF. An auth-gated URL commonly returns a
// 200 HTML login page; without this we would store that as a corrupt "PDF".
export function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false
  return String.fromCharCode(...bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC
}

// The draft the popup shows before any bytes exist. Fetching them needs a host
// permission that only a user gesture can request, so mount-time we have nothing
// but tab metadata. `force: true` skips the desktop's URL dedup, whose enrichment
// branch would update content/metadata only and drop the PDF bytes.
export function buildPdfDraft(
  tab: { url?: string; title?: string },
  now: string = new Date().toISOString()
): ArticleCapture | null {
  if (!tab.url || !originPatternOf(tab.url)) return null
  const filename = fromUrlPath(tab.url)
  const title = filename?.replace(/\.[^.]+$/, '') || tab.title?.trim() || tab.url
  return {
    url: tab.url,
    mode: 'pdf',
    contentMarkdown: '',
    excerpt: '',
    extractionStatus: 'full',
    force: true,
    tags: ['clippings'],
    properties: { title, source: tab.url, created: now }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @memry/extension test -- pdf-capture
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/lib/pdf-capture.ts apps/extension/src/lib/pdf-capture.test.ts
git commit -m "feat(extension): pure helpers for detecting and naming tab PDFs"
```

---

### Task 4: Request the page origin alongside loopback, in one gesture

**Files:**

- Modify: `apps/extension/src/lib/capture-permissions.ts`
- Modify: `apps/extension/src/lib/capture-permissions.test.ts`
- Modify: `apps/extension/wxt.config.ts:11`

**Interfaces:**

- Consumes: `originPatternOf` from Task 3.
- Produces:
  - `ensureCapturePermissions(pageUrl: string | null, permissions?: PermissionsApi): Promise<boolean>` — **replaces** `ensureHostPermission`. Holds loopback plus, when `pageUrl` is a fetchable `http(s)` URL, that page's origin.
  - `hasOriginPermission(pageUrl: string, permissions?: PermissionsApi): Promise<boolean>` — check-only, for the background shortcut path which cannot prompt.
  - `optional_host_permissions: ['*://*/*']` in the manifest.

**Background the implementer needs:**

`ensureHostPermission` (existing) requests only loopback. Firefox MV3 treats manifest `host_permissions` as opt-in, so the loopback grant already happens on a click.

The critical detail: request **both** origins in a **single** `permissions.request` call. Two `await`-separated requests lose user-gesture attribution on Firefox, and the second prompt silently fails.

`ensureHostPermission` is **replaced**, not kept alongside. Its only caller is `App.tsx:135`, which Task 6 rewrites; leaving it would be dead code that this change created. `ensureCapturePermissions(null, …)` is behaviourally identical to it, so its four existing tests migrate by adding the `null` argument.

`optional_host_permissions` is not shown at install time and prompts per origin at request time, so this adds no new install warning. It is still a manifest change and therefore triggers a Chrome Web Store and AMO re-review — a release-planning cost, noted in the spec.

- [ ] **Step 1: Migrate the existing tests and write the failing new ones**

In `apps/extension/src/lib/capture-permissions.test.ts`, first migrate the four existing cases: rename the `describe('ensureHostPermission')` block to `describe('ensureCapturePermissions — loopback only')`, change the import from `ensureHostPermission` to `ensureCapturePermissions`, and give every call `null` as its first argument, e.g.

```ts
const ok = await ensureCapturePermissions(null, {
  contains: vi.fn().mockResolvedValue(true),
  request
})
```

The `const origins = { origins: [LOOPBACK_ORIGIN] }` fixture at the top stays exactly as it is.

Then append the new cases:

```ts
import { ensureCapturePermissions, hasOriginPermission } from './capture-permissions'

describe('ensureCapturePermissions', () => {
  it('requests loopback and the page origin in ONE call', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const ok = await ensureCapturePermissions('https://example.com/paper.pdf', {
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(ok).toBe(true)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith({
      origins: [LOOPBACK_ORIGIN, 'https://example.com/*']
    })
  })

  it('asks for loopback only when there is no fetchable page url', async () => {
    const request = vi.fn().mockResolvedValue(true)
    await ensureCapturePermissions(null, {
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(request).toHaveBeenCalledWith({ origins: [LOOPBACK_ORIGIN] })
  })

  it('asks for loopback only when the page url is not http(s)', async () => {
    const request = vi.fn().mockResolvedValue(true)
    await ensureCapturePermissions('chrome://settings', {
      contains: vi.fn().mockResolvedValue(false),
      request
    })
    expect(request).toHaveBeenCalledWith({ origins: [LOOPBACK_ORIGIN] })
  })

  it('does not prompt when everything is already granted', async () => {
    const request = vi.fn()
    const ok = await ensureCapturePermissions('https://example.com/a.pdf', {
      contains: vi.fn().mockResolvedValue(true),
      request
    })
    expect(ok).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('returns false when the user denies site access', async () => {
    const ok = await ensureCapturePermissions('https://example.com/a.pdf', {
      contains: vi.fn().mockResolvedValue(false),
      request: vi.fn().mockResolvedValue(false)
    })
    expect(ok).toBe(false)
  })
})

describe('hasOriginPermission', () => {
  it('reports a granted origin without ever prompting', async () => {
    const request = vi.fn()
    const ok = await hasOriginPermission('https://example.com/a.pdf', {
      contains: vi.fn().mockResolvedValue(true),
      request
    })
    expect(ok).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('reports false for a non-http(s) url', async () => {
    const ok = await hasOriginPermission('chrome://settings', {
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn()
    })
    expect(ok).toBe(false)
  })

  it('reports false when the permissions API throws', async () => {
    const ok = await hasOriginPermission('https://example.com/a.pdf', {
      contains: vi.fn().mockRejectedValue(new Error('no api')),
      request: vi.fn()
    })
    expect(ok).toBe(false)
  })
})
```

Merge the new `import` into the file's existing import of `./capture-permissions` rather than adding a second import line.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @memry/extension test -- capture-permissions
```

Expected: FAIL — `ensureCapturePermissions` is not exported.

- [ ] **Step 3: Implement both helpers**

In `apps/extension/src/lib/capture-permissions.ts`, add this import at the **top of the file**, above the `LOOPBACK_ORIGIN` declaration:

```ts
import { originPatternOf } from './pdf-capture'
```

Then **delete** the whole `ensureHostPermission` function (its doc comment included) and put these two in its place. Keep the `LOOPBACK_ORIGIN` constant and the `PermissionsApi` interface exactly as they are.

```ts
// Ensure every origin this capture needs, in ONE request so the user gesture is
// not split — Firefox drops the prompt for a second, await-separated request.
// `pageUrl` is the tab we may need to re-fetch (PDF mode); pass null for captures
// that only talk to the desktop app.
export async function ensureCapturePermissions(
  pageUrl: string | null,
  permissions: PermissionsApi = browser.permissions
): Promise<boolean> {
  const pagePattern = pageUrl ? originPatternOf(pageUrl) : null
  const origins = pagePattern ? [LOOPBACK_ORIGIN, pagePattern] : [LOOPBACK_ORIGIN]
  try {
    if (await permissions.contains({ origins })) return true
    return await permissions.request({ origins })
  } catch {
    return true
  }
}

// Check-only variant for the background service worker, which has no user
// gesture and therefore cannot prompt. Unlike ensureCapturePermissions, an
// unavailable permissions API means "no" — we must not attempt a fetch we
// are not allowed to make.
export async function hasOriginPermission(
  pageUrl: string,
  permissions: PermissionsApi = browser.permissions
): Promise<boolean> {
  const pattern = originPatternOf(pageUrl)
  if (!pattern) return false
  try {
    return await permissions.contains({ origins: [pattern] })
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Migrate the one existing call site**

Deleting `ensureHostPermission` breaks its only caller, so migrate it now — behaviour is identical, and Task 6 refines it to pass the PDF URL.

In `apps/extension/src/entrypoints/popup/App.tsx`, change the import:

```ts
import { ensureCapturePermissions } from '@/lib/capture-permissions'
```

and line 135 inside `onSend`:

```ts
    if (!(await ensureCapturePermissions(null))) {
```

- [ ] **Step 5: Declare the optional permission in the manifest**

In `apps/extension/wxt.config.ts`, directly after the `host_permissions` line:

```ts
    host_permissions: ['http://127.0.0.1/*'],
    // Optional, so it shows no install-time warning: the popup requests just the
    // PDF's own origin on the Send click, per site. Needed to re-fetch a PDF tab
    // with the user's cookies, since content scripts never run in a PDF viewer.
    optional_host_permissions: ['*://*/*'],
```

- [ ] **Step 6: Run the tests and typecheck to verify they pass**

```bash
pnpm --filter @memry/extension test -- capture-permissions && pnpm --filter @memry/extension typecheck
```

Expected: PASS — the new cases and the four migrated loopback-only cases — and no type errors.

Then confirm nothing still references the deleted function:

```bash
grep -rn "ensureHostPermission" apps/extension/src
```

Expected: no matches. Any hit is a call site Step 4 missed — migrate it to `ensureCapturePermissions(null)` before continuing.

- [ ] **Step 7: Verify the manifest builds for both browsers**

```bash
pnpm --filter @memry/extension build && pnpm --filter @memry/extension build:firefox
```

Expected: both succeed. Confirm `optional_host_permissions` is present in `apps/extension/.output/chrome-mv3/manifest.json` and `apps/extension/.output/firefox-mv3/manifest.json`.

- [ ] **Step 8: Commit**

```bash
git add apps/extension/src/lib/capture-permissions.ts apps/extension/src/lib/capture-permissions.test.ts apps/extension/src/entrypoints/popup/App.tsx apps/extension/wxt.config.ts
git commit -m "feat(extension): request the page origin with loopback in one prompt"
```

---

### Task 5: Background fetches the PDF and never queues it

**Files:**

- Modify: `apps/extension/src/lib/capture-queue.ts`
- Modify: `apps/extension/src/lib/capture-queue.test.ts`
- Modify: `apps/extension/src/lib/messages.ts`
- Modify: `apps/extension/src/entrypoints/background.ts`

**Interfaces:**

- Consumes: `MAX_PDF_BYTES`, `isPdfBytes`, `pdfFilenameFrom`, `buildPdfDraft` (Task 3); `hasOriginPermission` (Task 4); `bytesToDataUrl` (existing, `./capture-modes`).
- Produces:
  - `isQueueable(capture: ArticleCapture): boolean` in `capture-queue.ts`
  - `FetchPdfResponse = { ok: true; dataUrl: string; filename: string } | { ok: false; error: string }` in `messages.ts`
  - `PopupMessage` gains `{ type: 'FETCH_PDF'; url: string }`
  - Background handles `FETCH_PDF`; error codes are `pdf-fetch-failed`, `not-a-pdf`, `pdf-too-large`.

**Background the implementer needs:**

The fetch belongs in the background service worker, not the popup: it outlives the popup, it already owns the comparable `grabScreenshot` operation, and it is not subject to page CSP.

Chrome's `storage.local` quota is 10 MB without the `unlimitedStorage` permission. A 16 MB PDF base64-encodes to ~21 MB, so queueing one would blow the quota. The `isQueueable` guard prevents that. The app-closed case is already covered by the popup's `onLaunchAndAdd` flow (opens `memry://open`, waits 20 s); a hard failure after that shows "Try again" with the tab still open.

The `capture-page` shortcut cannot call `permissions.request` — there is no user gesture in a service worker. So it checks `hasOriginPermission` and degrades to today's `!` badge when the origin was never approved through the popup.

- [ ] **Step 1: Write the failing queue test**

Append to `apps/extension/src/lib/capture-queue.test.ts`:

```ts
describe('isQueueable', () => {
  it('queues an ordinary article capture', () => {
    expect(isQueueable({ url: 'https://x.test', mode: 'article' } as ArticleCapture)).toBe(true)
  })

  it('never queues a capture carrying pdf bytes', () => {
    // storage.local is capped at 10MB without unlimitedStorage; a 16MB PDF
    // base64s to ~21MB and would blow the quota.
    expect(
      isQueueable({
        url: 'https://x.test/a.pdf',
        mode: 'pdf',
        pdfDataUrl: 'data:application/pdf;base64,JVBERi0='
      } as ArticleCapture)
    ).toBe(false)
  })
})
```

Add `isQueueable` to the file's existing import from `./capture-queue`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @memry/extension test -- capture-queue
```

Expected: FAIL — `isQueueable` is not exported.

- [ ] **Step 3: Implement the queue guard**

Append to `apps/extension/src/lib/capture-queue.ts`:

```ts
// PDF captures carry megabytes of base64 and are never queued: Chrome caps
// storage.local at 10MB without the unlimitedStorage permission. The popup's
// launch-and-send flow already covers the app-closed case, and the tab is still
// open, so retrying is one click.
export function isQueueable(capture: ArticleCapture): boolean {
  return !capture.pdfDataUrl
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @memry/extension test -- capture-queue
```

Expected: PASS.

- [ ] **Step 5: Add the message types**

In `apps/extension/src/lib/messages.ts`, extend `CaptureMode` and `PopupMessage`, and add the response type:

```ts
export type CaptureMode = 'article' | 'selection' | 'screenshot' | 'pdf'
```

```ts
export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PAIR' }
  | { type: 'CAPTURE'; capture: ArticleCapture }
  | { type: 'WAIT_FOR_SERVER' }
  | { type: 'GRAB_SCREENSHOT' }
  | { type: 'FETCH_PDF'; url: string }
  | { type: 'FLUSH_QUEUE' }
  | { type: 'REVOKE' }
```

```ts
export type FetchPdfResponse =
  | { ok: true; dataUrl: string; filename: string }
  | { ok: false; error: string }
```

- [ ] **Step 6: Implement `fetchPdf` in the background**

In `apps/extension/src/entrypoints/background.ts`, extend the imports:

```ts
import { bytesToDataUrl, planStitch } from '@/lib/capture-modes'
import {
  badgeText,
  dequeueById,
  enqueue,
  isQueueable,
  isRetryable,
  type QueuedCapture
} from '@/lib/capture-queue'
import { buildPdfDraft, isPdfBytes, MAX_PDF_BYTES, pdfFilenameFrom } from '@/lib/pdf-capture'
import { hasOriginPermission } from '@/lib/capture-permissions'
```

and add `FetchPdfResponse` to the existing `@/lib/messages` type import.

Add the function after `grabScreenshot`:

```ts
// Re-fetch the tab's PDF with the user's cookies. Content scripts never run in
// Chrome's or Firefox's PDF viewer, so re-fetching is the only way to reach the
// bytes. Requires the page origin's host permission, which the popup requests on
// the Send click.
async function fetchPdf(url: string): Promise<FetchPdfResponse> {
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) return { ok: false, error: 'pdf-fetch-failed' }
    const bytes = new Uint8Array(await res.arrayBuffer())
    // An auth-gated URL commonly answers 200 with an HTML login page. Without
    // this check we would store that as a corrupt "PDF".
    if (!isPdfBytes(bytes)) return { ok: false, error: 'not-a-pdf' }
    if (bytes.length > MAX_PDF_BYTES) return { ok: false, error: 'pdf-too-large' }
    return {
      ok: true,
      dataUrl: bytesToDataUrl(bytes, 'application/pdf'),
      filename: pdfFilenameFrom(url, res.headers.get('content-disposition'))
    }
  } catch {
    return { ok: false, error: 'pdf-fetch-failed' }
  }
}
```

- [ ] **Step 7: Apply the queue guard**

In `captureOrQueue`, change the retryable branch so a PDF is returned rather than enqueued:

```ts
  if (isRetryable(res.error) && isQueueable(body)) {
    const queue = enqueue(await readQueue(), {
```

Leave the rest of the branch as it is. A PDF whose send fails now falls through to the existing `return res`.

- [ ] **Step 8: Route the message**

In the `browser.runtime.onMessage` switch, beside `GRAB_SCREENSHOT`:

```ts
      case 'FETCH_PDF':
        return fetchPdf(message.url)
```

- [ ] **Step 9: Handle PDFs in the keyboard shortcut**

In the `browser.commands.onCommand` handler, replace the `if (!extracted.ok) { ... }` error-badge block with:

```ts
let capture = extracted.ok ? extracted.capture : null
// The content script is absent on a PDF tab. We cannot prompt for site access
// from a service worker (no user gesture), so this only works for an origin
// the user already approved through the popup.
if (!capture && tab.url && (await hasOriginPermission(tab.url))) {
  const draft = buildPdfDraft({ url: tab.url, title: tab.title })
  const pdf = draft ? await fetchPdf(tab.url) : null
  if (draft && pdf?.ok) {
    capture = { ...draft, pdfDataUrl: pdf.dataUrl, pdfFilename: pdf.filename }
  }
}
if (!capture) {
  await browser.action.setBadgeText({ text: '!' })
  await browser.action.setBadgeBackgroundColor({ color: '#E56458' })
  setTimeout(() => void restoreQueueBadge(), 2000)
  return
}
```

Then change the send line below it from `extracted.capture` to `capture`:

```ts
const res = await captureOrQueue(capture)
```

- [ ] **Step 10: Typecheck and run the full extension suite**

```bash
pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension test
```

Expected: no type errors, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add apps/extension/src/lib/capture-queue.ts apps/extension/src/lib/capture-queue.test.ts apps/extension/src/lib/messages.ts apps/extension/src/entrypoints/background.ts
git commit -m "feat(extension): fetch the tab's PDF bytes in the background"
```

---

### Task 6: Popup offers and sends the PDF

**Files:**

- Modify: `apps/extension/src/lib/popup-state.ts:53-69`
- Modify: `apps/extension/src/lib/popup-state.test.ts`
- Modify: `apps/extension/src/entrypoints/popup/App.tsx`

**Interfaces:**

- Consumes: `buildPdfDraft` (Task 3); `ensureCapturePermissions` (Task 4); `FETCH_PDF` / `FetchPdfResponse` (Task 5).
- Produces: the user-visible flow. No exports other tasks depend on.

**Background the implementer needs:**

`App.tsx` mount currently sends `EXTRACT` and dispatches `DRAFT_READY` with `draft: null` on rejection. The change is to fall back to `buildPdfDraft(tab)` instead of `null`. `buildPdfDraft` returns `null` for any non-`http(s)` tab, so `chrome://`, `file://` and the Web Store keep today's "Couldn't read this page" empty state with no extra branching in the component.

`tab.url` and `tab.title` are readable without a new permission because clicking the browser action grants `activeTab` for that tab.

Task 4 already migrated `onSend` to `ensureCapturePermissions(null)`. This task passes the PDF's URL through instead of `null`, so the site grant is requested in the same single prompt.

The bytes are fetched _before_ the connection status branch, so a failed fetch never opens the desktop app for nothing.

- [ ] **Step 1: Write the failing error-mapping tests**

Append to `apps/extension/src/lib/popup-state.test.ts`:

```ts
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
```

Add `mapError` to the file's existing import from `./popup-state` if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @memry/extension test -- popup-state
```

Expected: FAIL — the three PDF codes fall through to the default "Couldn't reach Memry" message.

- [ ] **Step 3: Add the error codes**

In `apps/extension/src/lib/popup-state.ts`, inside `mapError`, before `default:`:

```ts
    case 'pdf-fetch-failed':
      return "Couldn't download this PDF. Open it directly, then try again."
    case 'not-a-pdf':
      return "This isn't a PDF — nothing to save."
    case 'pdf-too-large':
      return 'This PDF is too large to clip (limit 16 MB).'
```

Also widen the `permission-denied` message so it covers a denied site grant as well as loopback:

```ts
    case 'permission-denied':
      return 'Allow the access Memry asked for, then save again.'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @memry/extension test -- popup-state
```

Expected: PASS. If an existing test asserts the old `permission-denied` string, update that assertion to the new copy.

- [ ] **Step 5: Fall back to a PDF draft at mount**

In `apps/extension/src/entrypoints/popup/App.tsx`, add one import (the `ensureCapturePermissions` import already landed in Task 4):

```ts
import { buildPdfDraft } from '@/lib/pdf-capture'
```

Add `FetchPdfResponse` to the existing type import from `@/lib/messages`.

Replace the mount effect's `browser.tabs.query` block:

```ts
browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.id) return dispatch({ type: 'DRAFT_READY', draft: null })
  // Content scripts never inject into a PDF viewer, so a rejected EXTRACT on
  // an http(s) tab means the browser is showing a binary — treat it as a PDF.
  // buildPdfDraft returns null for chrome://, file:// and the Web Store, which
  // keeps today's "Couldn't read this page" state for those.
  const pdfFallback = () => buildPdfDraft({ url: tab.url, title: tab.title })
  browser.tabs
    .sendMessage(tab.id, { type: 'EXTRACT' })
    .then((r: ExtractResponse) =>
      dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : pdfFallback() })
    )
    .catch(() => dispatch({ type: 'DRAFT_READY', draft: pdfFallback() }))
})
```

- [ ] **Step 6: Thread an explicit draft through the send handlers**

`onAdd` and `onLaunchAndAdd` currently read `state.draft` straight out of the render closure. That value is fixed for the life of this render, so a `dispatch` issued inside `onSend` is **not** visible to them — the PDF bytes would be fetched and then silently dropped. Both handlers therefore take the draft as an argument.

Still in `App.tsx`, change the two lines at the top of `onAdd`:

```ts
  const onAdd = async (
    connectionOverride?: ConnectionState,
    draftOverride?: ArticleCapture
  ): Promise<CaptureResponse | undefined> => {
    const draft = draftOverride ?? state.draft
    if (!draft) return
```

and its `CAPTURE` send, from `capture: state.draft` to:

```ts
      .sendMessage({ type: 'CAPTURE', capture: draft })
```

Then in `onLaunchAndAdd`, add the parameter and resolve the draft once at the top:

```ts
  const onLaunchAndAdd = async (draftOverride?: ArticleCapture) => {
    const draft = draftOverride ?? state.draft
    dispatch({ type: 'LAUNCH_START' })
```

pass it down to `onAdd`:

```ts
await onAdd(status.connection === 'app-closed' ? 'needs-pairing' : status.connection, draft)
```

and replace its two later `state.draft` reads with `draft` — the `if (!state.draft) {` guard becomes `if (!draft) {`, and its `CAPTURE` send becomes `capture: draft`.

- [ ] **Step 7: Fetch the bytes on Send**

Still in `App.tsx`, replace `onSend` with:

```ts
// One button. Request every origin this capture needs in a single prompt — a
// second, await-separated request loses the gesture on Firefox. Then re-probe:
// the mount probe may have been blocked by the missing loopback permission.
const onSend = async () => {
  let draft = state.draft
  if (!(await ensureCapturePermissions(draft?.mode === 'pdf' ? draft.url : null))) {
    dispatch({ type: 'SAVE_DONE', result: { ok: false, error: 'permission-denied' } })
    return
  }
  // Pull the PDF bytes before touching the desktop app, so a failed fetch never
  // launches Memry for a capture that cannot be sent. The result is threaded
  // through as an argument, not dispatched: this closure's `state` is frozen.
  if (draft?.mode === 'pdf' && !draft.pdfDataUrl) {
    dispatch({ type: 'SAVE_START' })
    const pdf: FetchPdfResponse = await browser.runtime
      .sendMessage({ type: 'FETCH_PDF', url: draft.url })
      .catch(() => ({ ok: false, error: 'pdf-fetch-failed' }) as FetchPdfResponse)
    if (!pdf.ok) {
      dispatch({ type: 'SAVE_DONE', result: { ok: false, error: pdf.error } })
      return
    }
    draft = { ...draft, pdfDataUrl: pdf.dataUrl, pdfFilename: pdf.filename }
  }
  const status = await fetchStatus()
  dispatch({ type: 'STATUS', connection: status.connection, port: status.port })
  if (status.connection === 'app-closed') {
    await onLaunchAndAdd(draft ?? undefined)
  } else {
    await onAdd(status.connection, draft ?? undefined)
  }
}
```

The bytes are deliberately not stored in reducer state: a failed send followed by "Try again" re-fetches them, which is both simpler and fresher than caching megabytes in the popup.

- [ ] **Step 8: Show a PDF badge on the card**

Still in `App.tsx`, in the source row inside the `{draft && (` block, after the host `<span>`:

```tsx
{
  draft.mode === 'pdf' && (
    <span className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
      PDF
    </span>
  )
}
```

No other card change is needed: `contentMarkdown` is `''` for a PDF draft, so the Content disclosure already hides itself, and the title and tag editors work as they are.

- [ ] **Step 9: Typecheck and run the full extension suite**

```bash
pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension test
```

Expected: no type errors, all tests pass.

- [ ] **Step 10: Manually verify against a real PDF**

```bash
pnpm --filter @memry/desktop dev
```

In a second terminal:

```bash
pnpm --filter @memry/extension dev
```

Walk through, and record the result of each:

1. Open `https://arxiv.org/pdf/1706.03762` in Chrome's viewer → click the extension → card shows a **PDF** badge and the title `1706.03762`.
2. Click **Send to memrynote** → Chrome prompts for access to `arxiv.org` → Allow → item lands in the inbox as a PDF, opens in the in-app viewer.
3. File that item into a folder → the `.pdf` lands in the vault folder.
4. Repeat step 1–2 on the same URL → a second item is created (`force: true`), not an enriched duplicate.
5. Open a `chrome://settings` tab → popup still shows "Couldn't read this page".
6. Open a normal article → article capture still works unchanged.
7. Press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> on the arxiv PDF (origin now granted) → ✓ badge, item lands.
8. Press it on a PDF from an origin never granted → `!` badge, nothing lands.
9. A PDF larger than 16 MB → "This PDF is too large to clip (limit 16 MB)." and no inbox item.
10. Quit the desktop app, then clip a PDF → the popup opens Memry and sends; it does **not** show "Saved offline".

Repeat steps 1–2 on Firefox with `pnpm --filter @memry/extension dev:firefox`.

- [ ] **Step 11: Commit**

```bash
git add apps/extension/src/lib/popup-state.ts apps/extension/src/lib/popup-state.test.ts apps/extension/src/entrypoints/popup/App.tsx
git commit -m "feat(extension): clip the actual PDF when the tab is a PDF"
```

---

### Task 7: Documentation and full verification

**Files:**

- Modify: `apps/docs/src/user-guide/inbox/capturing.md`

**Interfaces:**

- Consumes: everything above.
- Produces: green gates for the whole branch.

**Background the implementer needs:**

`scripts/docs-impact.mjs` treats `apps/desktop/src/**` and `packages/contracts/**` as docs-relevant (`apps/extension/**` is not). Tasks 1–2 therefore make `pnpm docs:impact --strict` report `missing-docs` until a file under `apps/docs/src/**` changes. The right page is the clipper section of `capturing.md`, which already documents capture modes, the shortcut, and the offline queue — each of which the PDF path touches.

- [ ] **Step 1: Document PDF capture**

In `apps/docs/src/user-guide/inbox/capturing.md`, extend the **Capture modes** list (currently three bullets) with a fourth:

```markdown
- **PDF** — when the tab is a PDF, the actual file. The popup shows a PDF badge instead of a content
  preview; you can still edit the title and tags before saving.
```

and change the line below it to:

```markdown
Article and Selection land as text; Screenshot lands as an image attachment; PDF lands as a PDF file
you can open in memrynote's built-in viewer and file into a folder like any other attachment.
```

Then add a subsection directly after **Capture modes**:

```markdown
### Clipping PDFs

When you open a PDF — a `.pdf` link, or a site that opens one — the browser renders it with its own
viewer, which extensions cannot read text from. So the clipper saves the file itself instead.

The first time you clip a PDF from a given site, your browser asks whether to give memrynote access
to that site. This is needed to download the file with your session, so PDFs behind a login work.
The prompt appears once per site, not once per PDF.

Limits worth knowing:

- PDFs up to **16 MB** can be clipped. Larger ones are better saved to disk and dragged into the
  inbox, which allows up to 50 MB.
- PDFs that can't be downloaded a second time — one-time links, or a file opened by submitting a form
  — can't be clipped. You'll see a message rather than a broken item.
- If you're signed out, the site may return its login page instead of the file. The clipper detects
  this and tells you rather than saving something unreadable.
- PDF clips are **not** queued when memrynote is closed. The popup opens the app and sends; if that
  fails, click again with the tab still open.
```

Finally, correct the shortcut caveat (currently "The shortcut is Article-only"):

```markdown
extension. (The shortcut handles Article and PDF — Selection and Screenshot need the popup. For a
PDF it only works on a site you've already granted access to through the popup, since a keyboard
shortcut can't show a permission prompt.)
```

- [ ] **Step 2: Verify the docs gate**

```bash
pnpm docs:impact --base origin/main --strict
```

Expected: `covered`.

```bash
pnpm docs:build
```

Expected: builds without errors.

- [ ] **Step 3: Run every repo gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm check:architecture && pnpm check:contracts && git diff --check
```

Expected: all green. Two known-noise items from `CLAUDE.md`: pre-existing type errors in `websocket.test.ts` and `folders.test.ts` are not caused by this change. Anything else must be fixed before committing.

- [ ] **Step 4: Confirm both extension builds still produce a valid manifest**

```bash
pnpm --filter @memry/extension build && pnpm --filter @memry/extension build:firefox
```

Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/user-guide/inbox/capturing.md
git commit -m "docs(inbox): document clipping PDFs and the per-site access prompt"
```

- [ ] **Step 6: Confirm the branch is ready**

```bash
git log --oneline origin/main..HEAD
```

Expected: seven commits, one per task, on branch `clipper-pdf-capture`.

---

## Release note for whoever ships this

The desktop half (Tasks 1–2) is inert until an extension sends `mode: 'pdf'`, so it is safe to
release first — and it **must** be. A newer extension against an older desktop 422s on every PDF
clip. Chrome Web Store and AMO review lag makes the correct order the natural one, but do not
publish the extension update ahead of a desktop release that carries the contract change.

The manifest gained `optional_host_permissions`, which triggers a store re-review on both Chrome
and AMO. It adds no new install-time warning, because optional permissions are prompted at request
time rather than at install.
