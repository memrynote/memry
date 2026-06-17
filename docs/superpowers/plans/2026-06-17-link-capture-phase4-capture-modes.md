# Link Capture Phase 4 — Selection + Screenshot Capture Modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the popup's disabled "Selection" and "Shot" segments into working capture modes — selection clips text as a markdown note, Shot captures a full-page screenshot as an image note — both landing in the inbox via the existing `/capture` → `ingestArticleCapture` path.

**Architecture:** Selection is extension-only (content script runs the same defuddle engine on the selected fragment, produces `contentMarkdown`; desktop ingests unchanged). Screenshot adds a wire field `screenshotDataUrl`: the background orchestrates a scroll+capture loop, stitches slices with `OffscreenCanvas`, and the desktop decodes the data URL into an inbox attachment and embeds it. Pure data transforms (envelope builders, stitch geometry, base64, data-URL parse) are isolated into testable helpers; DOM/canvas/React surfaces are manual-QA.

**Tech Stack:** WXT MV3 + React 19 (extension), defuddle 0.19 via `@memry/article-extract`, Electron main (desktop), Zod contracts, Vitest.

## Global Constraints

- Prettier: single quotes, NO semicolons, 100-char width, no trailing commas — copy verbatim from `CLAUDE.md`.
- Tailwind logical properties only: `ms/me`, `ps/pe`, `start/end`, `text-start/text-end` — never `ml/mr/pl/pr/left/right`.
- NO `Co-Authored-By` trailer on commits.
- Commit ONLY the task's files by explicit path. NEVER `git add -A` (an untracked `import-prompt/` dir must not be committed).
- Import the capture contract via the subpath `@memry/contracts/capture-api`, never the barrel.
- No new dependencies. No new extension permissions (`activeTab` already authorizes `captureVisibleTab`; selection/scroll need none).
- Branch: `feat/link-capture-capture-modes` (already created off main; the spec commit is the first commit).
- Spec: `docs/superpowers/specs/2026-06-17-link-capture-phase4-capture-modes-design.md`.

---

## File Structure

**Desktop / contracts (screenshot only — selection needs nothing here):**

- `packages/contracts/src/capture-api.ts` — add `screenshotDataUrl` to `ArticleCaptureSchema`.
- `packages/contracts/src/capture-api.test.ts` — NEW, schema parse test.
- `packages/article-extract/src/map.ts` — add `force?` + `screenshotDataUrl?` to the `ArticleCapture` envelope type (shared by extension + desktop ingest).
- `apps/desktop/src/main/inbox/parse-data-url.ts` — NEW pure helper.
- `apps/desktop/src/main/inbox/parse-data-url.test.ts` — NEW.
- `apps/desktop/src/main/inbox/ingest.ts` — decode + store + embed screenshot in the create-path.
- `apps/desktop/src/main/capture/server.test.ts` — add a screenshot pass-through case.

**Extension:**

- `apps/extension/src/lib/messages.ts` — `CaptureMode`, new message variants + response types.
- `apps/extension/src/lib/popup-state.ts` — `mode` + `capturing` in state, `SET_MODE` action, `capturing` phase.
- `apps/extension/src/lib/popup-state.test.ts` — reducer tests for the new action/phase.
- `apps/extension/src/lib/capture-modes.ts` — NEW pure helpers (`toSelectionCapture`, `buildScreenshotDraft`, `planStitch`, `bytesToDataUrl`).
- `apps/extension/src/lib/capture-modes.test.ts` — NEW.
- `apps/extension/src/entrypoints/content.ts` — `GRAB_SELECTION`, `GET_PAGE_METRICS`, `SCROLL_TO` handlers.
- `apps/extension/src/entrypoints/background.ts` — `GRAB_SCREENSHOT` orchestration + stitch.
- `apps/extension/src/components/ModeSegmented.tsx` — interactive segments.
- `apps/extension/src/components/ScreenshotPreview.tsx` — NEW image miniature.
- `apps/extension/src/entrypoints/popup/App.tsx` — mode switching, capturing/empty states, per-mode body.

---

## Task 1: Contract field + shared envelope type (desktop foundation)

**Files:**

- Modify: `packages/contracts/src/capture-api.ts:13-23`
- Test: `packages/contracts/src/capture-api.test.ts` (create)
- Modify: `packages/article-extract/src/map.ts:11-19`

**Interfaces:**

- Produces: `ArticleCaptureSchema` accepting optional `screenshotDataUrl: string`; the `ArticleCapture` envelope type carrying optional `force?: boolean` and `screenshotDataUrl?: string` (consumed by Tasks 3, 5, 7, 8).

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/capture-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ArticleCaptureSchema } from './capture-api'

describe('ArticleCaptureSchema', () => {
  it('accepts a screenshot payload with screenshotDataUrl + force', () => {
    const r = ArticleCaptureSchema.safeParse({
      url: 'https://example.com/p',
      mode: 'screenshot',
      contentMarkdown: '',
      excerpt: '',
      extractionStatus: 'full',
      properties: {
        title: 't',
        source: 'https://example.com/p',
        created: '2026-06-17T00:00:00.000Z',
        tags: []
      },
      screenshotDataUrl: 'data:image/png;base64,AAAA',
      force: true
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.screenshotDataUrl).toBe('data:image/png;base64,AAAA')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/contracts test -- capture-api`
Expected: FAIL — `r.data.screenshotDataUrl` is `undefined` (Zod strips the unknown key).

- [ ] **Step 3: Add the schema field**

In `packages/contracts/src/capture-api.ts`, add one line to `ArticleCaptureSchema` after `heroImage`:

```ts
export const ArticleCaptureSchema = z.object({
  url: z.string().url(),
  mode: z.enum(['article', 'selection', 'screenshot']),
  contentMarkdown: z.string(),
  excerpt: z.string(),
  extractionStatus: z.enum(['full', 'partial', 'failed']),
  properties: ArticlePropertiesSchema,
  heroImage: z.string().optional(),
  screenshotDataUrl: z.string().optional(),
  tags: z.array(z.string()).optional(),
  force: z.boolean().optional()
})
```

- [ ] **Step 4: Extend the shared envelope type**

In `packages/article-extract/src/map.ts`, add two optional fields to the `ArticleCapture` interface (the cross-boundary capture envelope — `mode` already spans all three modes here):

```ts
export interface ArticleCapture {
  url: string
  mode: 'article' | 'selection' | 'screenshot'
  contentMarkdown: string
  excerpt: string
  extractionStatus: 'full' | 'partial' | 'failed'
  properties: ArticleProperties
  heroImage?: string
  // Capture directives (set by the extension for selection/screenshot; the
  // extraction mapping never sets them).
  force?: boolean
  screenshotDataUrl?: string
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/contracts test -- capture-api`
Expected: PASS.

- [ ] **Step 6: Typecheck both packages**

Run: `pnpm --filter @memry/contracts typecheck && pnpm --filter @memry/article-extract typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/capture-api.ts packages/contracts/src/capture-api.test.ts packages/article-extract/src/map.ts
git commit -m "feat(capture): add screenshotDataUrl to capture contract + envelope"
```

---

## Task 2: `parseDataUrl` helper (desktop, pure)

**Files:**

- Create: `apps/desktop/src/main/inbox/parse-data-url.ts`
- Test: `apps/desktop/src/main/inbox/parse-data-url.test.ts`

**Interfaces:**

- Produces: `parseDataUrl(s: string): { mime: string; buffer: Buffer } | null` (consumed by Task 3). Filename extension is NOT needed — `storeInboxAttachment` derives the stored extension from the MIME type itself.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/inbox/parse-data-url.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseDataUrl } from './parse-data-url'

describe('parseDataUrl', () => {
  it('decodes a base64 png data URL', () => {
    // "hi" base64 = aGk=
    const r = parseDataUrl('data:image/png;base64,aGk=')
    expect(r).not.toBeNull()
    expect(r?.mime).toBe('image/png')
    expect(r?.buffer.toString('utf8')).toBe('hi')
  })

  it('returns null for a non-data string', () => {
    expect(parseDataUrl('https://example.com/x.png')).toBeNull()
  })

  it('returns null for a data URL that is not base64', () => {
    expect(parseDataUrl('data:image/png,plain')).toBeNull()
  })

  it('returns null for an empty payload', () => {
    expect(parseDataUrl('data:image/png;base64,')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main parse-data-url`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/inbox/parse-data-url.ts`:

```ts
// Parse a base64 data URL ("data:<mime>;base64,<payload>") into its MIME type
// and decoded bytes. Returns null for anything that is not a non-empty base64
// data URL (callers fall through to leaving the capture image-less).
export function parseDataUrl(input: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(input.trim())
  if (!match) return null
  const mime = match[1].toLowerCase()
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0) return null
  return { mime, buffer }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main parse-data-url`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/inbox/parse-data-url.ts apps/desktop/src/main/inbox/parse-data-url.test.ts
git commit -m "feat(inbox): add parseDataUrl helper for screenshot decoding"
```

---

## Task 3: Screenshot ingest + server pass-through test (desktop)

**Files:**

- Modify: `apps/desktop/src/main/inbox/ingest.ts:12-13` (imports), `:83-114` (create-path)
- Modify: `apps/desktop/src/main/capture/server.test.ts` (add a case)

**Interfaces:**

- Consumes: `parseDataUrl` (Task 2), `storeInboxAttachment(itemId, data: Buffer, filename, mimeType) → { success; path? }` (existing, `./attachments`), `input.screenshotDataUrl` (Task 1).
- Produces: when `screenshotDataUrl` is present and decodes + stores, the new inbox item's `content` is `![screenshot](<vault-relative path>)` and its `thumbnailPath` is that path.

- [ ] **Step 1: Write the failing test (server pass-through)**

In `apps/desktop/src/main/capture/server.test.ts`, add this case inside the `describe('capture server', ...)` block, after the existing `'claims a token ... then serves /capture'` test:

```ts
it('passes a screenshot capture through to ingest', async () => {
  origins.add('chrome-extension://abc')
  const cap = await req(port, '/capture', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'chrome-extension://abc',
      'X-Memry-Capture': '1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: 'https://example.com/p',
      mode: 'screenshot',
      contentMarkdown: '',
      excerpt: '',
      extractionStatus: 'full',
      properties: {
        title: 'x',
        source: 'https://example.com/p',
        created: '2026-06-17T00:00:00.000Z',
        tags: ['clippings']
      },
      screenshotDataUrl: 'data:image/png;base64,aGk=',
      force: true
    })
  })
  expect(cap.status).toBe(200)
  expect(ingestSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: 'screenshot',
      screenshotDataUrl: 'data:image/png;base64,aGk=',
      force: true
    }),
    'browser-extension'
  )
})
```

- [ ] **Step 2: Run test to verify it passes already (contract pass-through)**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts`
Expected: PASS — Task 1 already added the schema field, so `screenshotDataUrl` survives validation and reaches the (mocked) ingest. (If it FAILS with `screenshotDataUrl: undefined`, Task 1 was not applied — stop and fix Task 1.)

This test guards the wire contract. The decode/store/embed below is covered by `parseDataUrl` (Task 2) plus manual QA, since the embed is DB- and vault-bound.

- [ ] **Step 3: Add imports to ingest.ts**

In `apps/desktop/src/main/inbox/ingest.ts`, extend the attachments import (line 13) and add the helper import:

```ts
import { getItemAttachmentsDir, storeInboxAttachment } from './attachments'
import { parseDataUrl } from './parse-data-url'
```

- [ ] **Step 4: Decode + store + embed in the create-path**

In `ingest.ts`, replace the create-path block (currently lines 83-111, from `// Create a new item` through the `insertItemWithTags(...)` call) with:

```ts
// Create a new item (extension path).
const id = generateId()
const now = new Date().toISOString()
const tags = input.tags ?? input.properties.tags ?? []

// Screenshot mode: decode the data URL into an inbox attachment and make the
// image the note body. The extension sends contentMarkdown:'' for screenshots.
let content = input.contentMarkdown
let screenshotPath: string | null = null
if (input.screenshotDataUrl) {
  const parsed = parseDataUrl(input.screenshotDataUrl)
  if (parsed) {
    const stored = await storeInboxAttachment(id, parsed.buffer, 'screenshot', parsed.mime)
    if (stored.success && stored.path) {
      screenshotPath = stored.path
      content = `![screenshot](${stored.path})`
    } else {
      log.warn('screenshot attachment failed', { itemId: id, error: stored.error })
    }
  }
}

const thumbnailPath = screenshotPath ?? (await downloadHero(id, input.heroImage))
const { row, tags: appliedTags } = insertItemWithTags(
  db,
  {
    id,
    type: input.itemType ?? 'link',
    title: input.properties.title,
    content,
    sourceUrl: input.url,
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
      properties: input.properties
    }
  },
  tags
)
```

(The `emitCapturedAndSync(row, appliedTags)` / `log.info` / `return { itemId: id }` lines below stay unchanged.)

- [ ] **Step 5: Re-run the desktop capture test + typecheck**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS; 0 type errors. (If `better-sqlite3` raises `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node` and retry — the server test mocks ingest so it should not load it, but typecheck compiles ingest.ts.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/inbox/ingest.ts apps/desktop/src/main/capture/server.test.ts
git commit -m "feat(inbox): ingest screenshot captures as inbox image attachments"
```

---

## Task 4: Extension messages + reducer (mode + capturing)

**Files:**

- Modify: `apps/extension/src/lib/messages.ts`
- Modify: `apps/extension/src/lib/popup-state.ts`
- Test: `apps/extension/src/lib/popup-state.test.ts`

**Interfaces:**

- Produces:
  - `CaptureMode = 'article' | 'selection' | 'screenshot'`
  - `ContentMessage` += `{ type: 'GRAB_SELECTION' }`, `{ type: 'GET_PAGE_METRICS' }`, `{ type: 'SCROLL_TO'; y: number }`
  - `PopupMessage` += `{ type: 'GRAB_SCREENSHOT' }`
  - `PageMetrics = { scrollHeight; innerHeight; innerWidth; dpr; scrollY }`
  - `ScreenshotResponse = { ok: true; dataUrl: string } | { ok: false; error: string }`
  - `PopupState` gains `mode: CaptureMode` and `capturing: boolean`; `PopupAction` gains `{ type: 'SET_MODE'; mode: CaptureMode }`; `Phase` gains `'capturing'`.
  - Consumed by Tasks 6, 7, 8.

- [ ] **Step 1: Extend messages.ts**

Replace the message section of `apps/extension/src/lib/messages.ts` (from `export type PopupMessage` to end of file) with:

```ts
export type CaptureMode = 'article' | 'selection' | 'screenshot'

export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PAIR' }
  | { type: 'CAPTURE'; capture: ArticleCapture }
  | { type: 'WAIT_FOR_SERVER' }
  | { type: 'GRAB_SCREENSHOT' }

export type ContentMessage =
  | { type: 'EXTRACT' }
  | { type: 'GRAB_SELECTION' }
  | { type: 'GET_PAGE_METRICS' }
  | { type: 'SCROLL_TO'; y: number }

export type ExtractResponse = { ok: true; capture: ArticleCapture } | { ok: false; error: string }

export interface PageMetrics {
  scrollHeight: number
  innerHeight: number
  innerWidth: number
  dpr: number
  scrollY: number
}

export type ScreenshotResponse = { ok: true; dataUrl: string } | { ok: false; error: string }
```

- [ ] **Step 2: Write the failing reducer tests**

In `apps/extension/src/lib/popup-state.test.ts`, add (the file already imports `reducer`, `initialState`, `selectPhase` — reuse those imports; if `selectPhase` is not yet imported there, add it):

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @memry/extension test -- popup-state`
Expected: FAIL — `SET_MODE` not handled, `capturing`/`mode` undefined, `'capturing'` phase missing.

- [ ] **Step 4: Update popup-state.ts**

In `apps/extension/src/lib/popup-state.ts`:

Add `'capturing'` to the `Phase` union and import `CaptureMode`:

```ts
import type { CaptureMode, ConnectionState } from './messages'

export type Phase =
  | 'extracting'
  | 'capturing'
  | 'app-closed'
  | 'launching'
  | 'ready'
  | 'approving'
  | 'saving'
  | 'saved'
  | 'error'
```

Add `mode` + `capturing` to `PopupState` and `initialState`:

```ts
export interface PopupState {
  draft: ArticleCapture | null
  draftReady: boolean
  mode: CaptureMode
  capturing: boolean
  connection: 'unknown' | ConnectionState
  port: number | null
  action: 'idle' | 'launching' | 'approving' | 'saving' | 'saved' | 'error'
  itemId: string | null
  errorMessage: string | null
}
```

```ts
export const initialState: PopupState = {
  draft: null,
  draftReady: false,
  mode: 'article',
  capturing: false,
  connection: 'unknown',
  port: null,
  action: 'idle',
  itemId: null,
  errorMessage: null
}
```

Add `SET_MODE` to `PopupAction`:

```ts
  | { type: 'SET_MODE'; mode: CaptureMode }
```

In `reducer`, update `DRAFT_READY` to clear `capturing` and add the `SET_MODE` case:

```ts
    case 'DRAFT_READY':
      return { ...state, draft: action.draft, draftReady: true, capturing: false }
    case 'SET_MODE':
      return {
        ...state,
        mode: action.mode,
        capturing: action.mode !== 'article',
        draftReady: false,
        errorMessage: null
      }
```

In `selectPhase`, add the capturing check right after the `extracting` precondition group — place it so an in-flight grab wins over `ready` but not over an active save/error:

```ts
export function selectPhase(state: PopupState): Phase {
  if (state.action === 'saved') return 'saved'
  if (state.action === 'error') return 'error'
  if (state.action === 'saving') return 'saving'
  if (state.action === 'approving') return 'approving'
  if (state.action === 'launching') return 'launching'
  if (state.connection === 'unknown' || !state.draftReady) return 'extracting'
  if (state.capturing) return 'capturing'
  if (state.connection === 'app-closed') return 'app-closed'
  return 'ready'
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/extension test -- popup-state`
Expected: PASS (existing + 4 new).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @memry/extension typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/extension/src/lib/messages.ts apps/extension/src/lib/popup-state.ts apps/extension/src/lib/popup-state.test.ts
git commit -m "feat(extension): add capture-mode state + messages"
```

---

## Task 5: Pure capture-mode helpers (extension)

**Files:**

- Create: `apps/extension/src/lib/capture-modes.ts`
- Test: `apps/extension/src/lib/capture-modes.test.ts`

**Interfaces:**

- Consumes: `ArticleCapture` (`@memry/article-extract`).
- Produces:
  - `toSelectionCapture(base: ArticleCapture, selectionText: string, title: string): ArticleCapture` (Task 6)
  - `buildScreenshotDraft(base: ArticleCapture, screenshotDataUrl: string): ArticleCapture` (Task 8)
  - `planStitch(opts: { scrollHeight; innerHeight; innerWidth; dpr; maxHeight }): { width; height; slices: { scrollY; drawY }[] }` (Task 7)
  - `bytesToDataUrl(bytes: Uint8Array, mime: string): string` (Task 7)

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/lib/capture-modes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import {
  bytesToDataUrl,
  buildScreenshotDraft,
  planStitch,
  toSelectionCapture
} from './capture-modes'

const base: ArticleCapture = {
  url: 'https://example.com/p',
  mode: 'article',
  contentMarkdown: '# Real markdown',
  excerpt: 'x',
  extractionStatus: 'full',
  properties: {
    title: 'Page',
    source: 'https://example.com/p',
    created: 'now',
    tags: ['clippings']
  }
}

describe('toSelectionCapture', () => {
  it('keeps defuddle markdown when present and marks the capture as a forced selection', () => {
    const c = toSelectionCapture(base, 'plain selected text', 'Page')
    expect(c.mode).toBe('selection')
    expect(c.force).toBe(true)
    expect(c.contentMarkdown).toBe('# Real markdown')
    expect(c.extractionStatus).toBe('full')
  })

  it('falls back to plain selection text when markdown is empty', () => {
    const c = toSelectionCapture({ ...base, contentMarkdown: '   ' }, 'plain selected text', 'Page')
    expect(c.contentMarkdown).toBe('plain selected text')
  })
})

describe('buildScreenshotDraft', () => {
  it('builds a forced screenshot capture with an empty body', () => {
    const c = buildScreenshotDraft(base, 'data:image/png;base64,AAAA')
    expect(c.mode).toBe('screenshot')
    expect(c.force).toBe(true)
    expect(c.contentMarkdown).toBe('')
    expect(c.screenshotDataUrl).toBe('data:image/png;base64,AAAA')
    expect(c.properties.title).toBe('Page')
  })
})

describe('planStitch', () => {
  it('returns a single bottom-clipped slice for a short page', () => {
    const p = planStitch({
      scrollHeight: 500,
      innerHeight: 800,
      innerWidth: 1000,
      dpr: 1,
      maxHeight: 15000
    })
    expect(p.slices).toEqual([{ scrollY: 0, drawY: 0 }])
    expect(p.height).toBe(500)
    expect(p.width).toBe(1000)
  })

  it('bottom-aligns the final slice on a non-multiple page', () => {
    const p = planStitch({
      scrollHeight: 2000,
      innerHeight: 800,
      innerWidth: 1000,
      dpr: 1,
      maxHeight: 15000
    })
    expect(p.slices.map((s) => s.scrollY)).toEqual([0, 800, 1200])
    expect(p.height).toBe(2000)
  })

  it('applies devicePixelRatio to canvas size and draw offsets', () => {
    const p = planStitch({
      scrollHeight: 1600,
      innerHeight: 800,
      innerWidth: 500,
      dpr: 2,
      maxHeight: 15000
    })
    expect(p.width).toBe(1000)
    expect(p.height).toBe(3200)
    expect(p.slices).toEqual([
      { scrollY: 0, drawY: 0 },
      { scrollY: 800, drawY: 1600 }
    ])
  })

  it('clamps total height to maxHeight', () => {
    const p = planStitch({
      scrollHeight: 99999,
      innerHeight: 800,
      innerWidth: 100,
      dpr: 1,
      maxHeight: 1600
    })
    expect(p.height).toBe(1600)
    expect(p.slices[p.slices.length - 1].scrollY).toBe(800)
  })
})

describe('bytesToDataUrl', () => {
  it('encodes bytes as a base64 data URL', () => {
    expect(bytesToDataUrl(new Uint8Array([104, 105]), 'image/png')).toBe(
      'data:image/png;base64,aGk='
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/extension test -- capture-modes`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/extension/src/lib/capture-modes.ts`:

```ts
import type { ArticleCapture } from '@memry/article-extract'

// Turn a defuddle extraction of the selected fragment into a forced selection
// capture. Falls back to the raw selection text when defuddle yields nothing.
export function toSelectionCapture(
  base: ArticleCapture,
  selectionText: string,
  title: string
): ArticleCapture {
  const contentMarkdown = base.contentMarkdown.trim() ? base.contentMarkdown : selectionText
  return {
    ...base,
    mode: 'selection',
    contentMarkdown,
    excerpt: selectionText.slice(0, 200),
    extractionStatus: 'full',
    force: true,
    properties: { ...base.properties, title: title || base.properties.title }
  }
}

// Build a forced screenshot capture. The body is empty; the desktop decodes
// screenshotDataUrl into an attachment and writes the real markdown body.
export function buildScreenshotDraft(
  base: ArticleCapture,
  screenshotDataUrl: string
): ArticleCapture {
  return {
    url: base.url,
    mode: 'screenshot',
    contentMarkdown: '',
    excerpt: '',
    extractionStatus: 'full',
    force: true,
    screenshotDataUrl,
    properties: { ...base.properties }
  }
}

export interface StitchSlice {
  scrollY: number
  drawY: number
}

export interface StitchPlan {
  width: number
  height: number
  slices: StitchSlice[]
}

// Plan a full-page screenshot: which scroll positions to capture and where to
// paint each viewport-tall slice on the stitched canvas. The final slice is
// bottom-aligned so it never captures blank space below the page. Total height
// is clamped to maxHeight to keep the encoded PNG under the /capture cap.
export function planStitch(opts: {
  scrollHeight: number
  innerHeight: number
  innerWidth: number
  dpr: number
  maxHeight: number
}): StitchPlan {
  const { scrollHeight, innerHeight, innerWidth, dpr, maxHeight } = opts
  const total = Math.min(scrollHeight, maxHeight)
  const tops: number[] = []
  for (let y = 0; y < total; y += innerHeight) tops.push(y)
  if (tops.length === 0) tops.push(0)
  const lastTop = Math.max(0, total - innerHeight)
  if (tops[tops.length - 1] < lastTop) tops.push(lastTop)
  else tops[tops.length - 1] = lastTop
  const unique = tops.filter((y, i) => i === 0 || y !== tops[i - 1])
  return {
    width: Math.round(innerWidth * dpr),
    height: Math.round(total * dpr),
    slices: unique.map((scrollY) => ({ scrollY, drawY: Math.round(scrollY * dpr) }))
  }
}

// Encode bytes to a base64 data URL. Chunked to avoid blowing the call stack on
// large screenshots when spreading into String.fromCharCode.
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/extension test -- capture-modes`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @memry/extension typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/lib/capture-modes.ts apps/extension/src/lib/capture-modes.test.ts
git commit -m "feat(extension): pure selection/screenshot/stitch helpers"
```

---

## Task 6: Selection + scroll/metrics handlers in content script (extension, manual QA)

**Files:**

- Modify: `apps/extension/src/entrypoints/content.ts`

**Interfaces:**

- Consumes: `toSelectionCapture` (Task 5), `extractFromDocument` (`@memry/article-extract/browser`), `ContentMessage`/`ExtractResponse`/`PageMetrics` (Task 4).
- Produces: content script responds to `GRAB_SELECTION` (→ `ExtractResponse`), `GET_PAGE_METRICS` (→ `PageMetrics`), `SCROLL_TO` (→ `{ ok: true }`).

- [ ] **Step 1: Rewrite content.ts**

Replace `apps/extension/src/entrypoints/content.ts` with:

```ts
import type { ContentMessage, ExtractResponse, PageMetrics } from '@/lib/messages'
import { extractFromDocument } from '@memry/article-extract/browser'
import { toSelectionCapture } from '@/lib/capture-modes'

function grabSelection(): ExtractResponse {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return { ok: false, error: 'no-selection' }
  }
  // ponytail: first range only — multi-range (Ctrl-click) selections are rare;
  // upgrade path = concat cloneContents() of every range.
  const fragment = sel.getRangeAt(0).cloneContents()
  const doc = document.implementation.createHTMLDocument(document.title)
  doc.body.appendChild(fragment)
  const base = extractFromDocument(doc, location.href)
  return { ok: true, capture: toSelectionCapture(base, sel.toString(), document.title) }
}

function pageMetrics(): PageMetrics {
  return {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    scrollY: window.scrollY
  }
}

export default defineContentScript({
  // ponytail: declared on all web pages (standard clipper pattern); inert until messaged.
  matches: ['*://*/*'],
  main() {
    browser.runtime.onMessage.addListener((message: ContentMessage) => {
      switch (message.type) {
        case 'EXTRACT':
          try {
            return Promise.resolve<ExtractResponse>({
              ok: true,
              capture: extractFromDocument(document, location.href)
            })
          } catch (err) {
            return Promise.resolve<ExtractResponse>({ ok: false, error: String(err) })
          }
        case 'GRAB_SELECTION':
          try {
            return Promise.resolve(grabSelection())
          } catch (err) {
            return Promise.resolve<ExtractResponse>({ ok: false, error: String(err) })
          }
        case 'GET_PAGE_METRICS':
          return Promise.resolve(pageMetrics())
        case 'SCROLL_TO':
          window.scrollTo(0, message.y)
          return Promise.resolve({ ok: true })
        default:
          return Promise.resolve<ExtractResponse>({ ok: false, error: 'unknown-message' })
      }
    })
  }
})
```

- [ ] **Step 2: Typecheck + build the extension**

Run: `pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension build`
Expected: 0 type errors; build succeeds (WXT entrypoints compile).

- [ ] **Step 3: Run the extension unit suite (no regressions)**

Run: `pnpm --filter @memry/extension test`
Expected: PASS (content.ts has no unit tests — the selection envelope logic is covered by `capture-modes.test.ts`; this confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add apps/extension/src/entrypoints/content.ts
git commit -m "feat(extension): content-script selection grab + scroll/metrics"
```

---

## Task 7: Screenshot orchestration in background (extension, manual QA)

**Files:**

- Modify: `apps/extension/src/entrypoints/background.ts`

**Interfaces:**

- Consumes: `planStitch`, `bytesToDataUrl` (Task 5); `GRAB_SCREENSHOT` message, `PageMetrics`, `ScreenshotResponse` (Task 4).
- Produces: background responds to `GRAB_SCREENSHOT` with a `ScreenshotResponse` carrying the stitched full-page PNG data URL.

- [ ] **Step 1: Add the screenshot orchestration to background.ts**

In `apps/extension/src/entrypoints/background.ts`, update imports and add the helper + message case.

Update the imports at the top:

```ts
import type {
  CaptureResponse,
  PageMetrics,
  PairResponse,
  PopupMessage,
  ScreenshotResponse,
  StatusResponse
} from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import { claimToken, pollUntil, postCapture, probeServer, requestPair } from '@/lib/capture-client'
import { bytesToDataUrl, planStitch } from '@/lib/capture-modes'
```

Add constants + the `grabScreenshot` function above `export default defineBackground`:

```ts
const MAX_SHOT_HEIGHT = 15000 // ponytail: cap full-page height so the PNG stays under /capture's 25MB cap
const SETTLE_MS = 400 // wait between scroll and capture; also honors captureVisibleTab's ~2/sec limit

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function grabScreenshot(): Promise<ScreenshotResponse> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || tab.windowId == null) return { ok: false, error: 'no-tab' }
  const tabId = tab.id
  const windowId = tab.windowId
  try {
    const metrics = (await browser.tabs.sendMessage(tabId, {
      type: 'GET_PAGE_METRICS'
    })) as PageMetrics
    const plan = planStitch({ ...metrics, maxHeight: MAX_SHOT_HEIGHT })
    const canvas = new OffscreenCanvas(plan.width, plan.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return { ok: false, error: 'no-canvas' }
    try {
      for (const slice of plan.slices) {
        await browser.tabs.sendMessage(tabId, { type: 'SCROLL_TO', y: slice.scrollY })
        await sleep(SETTLE_MS)
        const shot = await browser.tabs.captureVisibleTab(windowId, { format: 'png' })
        const bmp = await createImageBitmap(await (await fetch(shot)).blob())
        ctx.drawImage(bmp, 0, slice.drawY)
        bmp.close()
      }
    } finally {
      // Always restore the user's scroll position, even if a capture threw.
      await browser.tabs
        .sendMessage(tabId, { type: 'SCROLL_TO', y: metrics.scrollY })
        .catch(() => {})
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return { ok: true, dataUrl: bytesToDataUrl(bytes, 'image/png') }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
```

Add the case to the message switch (inside `browser.runtime.onMessage.addListener`):

```ts
      case 'GRAB_SCREENSHOT':
        return grabScreenshot()
```

- [ ] **Step 2: Typecheck + build**

Run: `pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension build`
Expected: 0 type errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/src/entrypoints/background.ts
git commit -m "feat(extension): full-page screenshot scroll+stitch in background"
```

---

## Task 8: Popup mode switching + previews (extension, manual QA)

**Files:**

- Modify: `apps/extension/src/components/ModeSegmented.tsx`
- Create: `apps/extension/src/components/ScreenshotPreview.tsx`
- Modify: `apps/extension/src/entrypoints/popup/App.tsx`

**Interfaces:**

- Consumes: `buildScreenshotDraft` (Task 5); `SET_MODE`/`capturing`/`mode` (Task 4); `GRAB_SELECTION`/`GRAB_SCREENSHOT` messages; `ExtractResponse`/`ScreenshotResponse` (Task 4); `CaptureMode`.
- Produces: interactive 3-mode popup. Article re-uses the initial extraction; Selection grabs from the content script; Shot triggers background capture. Read-only body for selection, image miniature for screenshot, empty-state hints, capturing spinner.

- [ ] **Step 1: Make ModeSegmented interactive**

Replace `apps/extension/src/components/ModeSegmented.tsx` with:

```tsx
import type { CaptureMode } from '@/lib/messages'

const MODES: { id: CaptureMode; label: string }[] = [
  { id: 'article', label: 'Article' },
  { id: 'selection', label: 'Selection' },
  { id: 'screenshot', label: 'Shot' }
]

export function ModeSegmented({
  mode,
  disabled,
  onSelect
}: {
  mode: CaptureMode
  disabled: boolean
  onSelect: (mode: CaptureMode) => void
}) {
  return (
    <div className="flex gap-1 rounded-md bg-surface p-1">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(m.id)}
          className={
            'flex-1 rounded px-2 py-1 text-[12px] font-medium transition-colors disabled:opacity-50 ' +
            (m.id === mode ? 'bg-background text-foreground shadow-sm' : 'text-text-tertiary')
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add the screenshot preview component**

Create `apps/extension/src/components/ScreenshotPreview.tsx`:

```tsx
export function ScreenshotPreview({ dataUrl }: { dataUrl: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      <img
        src={dataUrl}
        alt="Page screenshot"
        className="max-h-48 w-full object-contain object-top"
      />
    </div>
  )
}
```

- [ ] **Step 3: Wire mode switching into App.tsx**

In `apps/extension/src/entrypoints/popup/App.tsx`:

Update imports (add `useRef`, `CaptureMode`, `ScreenshotResponse`, the screenshot helper, the new component):

```tsx
import { useEffect, useReducer, useRef } from 'react'
import type { ArticleCapture } from '@memry/article-extract'
import type {
  CaptureResponse,
  CaptureMode,
  ConnectionState,
  ExtractResponse,
  PairResponse,
  ScreenshotResponse,
  StatusResponse
} from '@/lib/messages'
import { initialState, reducer, selectPhase } from '@/lib/popup-state'
import { buildScreenshotDraft } from '@/lib/capture-modes'
import { StatusStrip } from '@/components/StatusStrip'
import { EditableTitle } from '@/components/EditableTitle'
import { PropertyRows } from '@/components/PropertyRows'
import { TagEditor } from '@/components/TagEditor'
import { BodyPreview } from '@/components/BodyPreview'
import { ModeSegmented } from '@/components/ModeSegmented'
import { ScreenshotPreview } from '@/components/ScreenshotPreview'
import { PrimaryButton } from '@/components/PrimaryButton'
```

Inside the component, cache the article draft as it arrives. Change the mount effect's `DRAFT_READY` dispatch to also store the article draft in a ref:

```tsx
const [state, dispatch] = useReducer(reducer, initialState)
const phase = selectPhase(state)
const articleDraftRef = useRef<ArticleCapture | null>(null)
```

In the mount effect, replace the `EXTRACT` `.then` so the article draft is cached:

```tsx
browser.tabs
  .sendMessage(tab.id, { type: 'EXTRACT' })
  .then((r: ExtractResponse) => {
    articleDraftRef.current = r.ok ? r.capture : null
    dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : null })
  })
  .catch(() => dispatch({ type: 'DRAFT_READY', draft: null }))
```

Add the `onSelectMode` handler (after `setDraft`):

```tsx
const onSelectMode = async (mode: CaptureMode) => {
  if (mode === state.mode) return
  dispatch({ type: 'SET_MODE', mode })
  if (mode === 'article') {
    dispatch({ type: 'DRAFT_READY', draft: articleDraftRef.current })
    return
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return dispatch({ type: 'DRAFT_READY', draft: null })
  if (mode === 'selection') {
    const r: ExtractResponse = await browser.tabs
      .sendMessage(tab.id, { type: 'GRAB_SELECTION' })
      .catch(() => ({ ok: false, error: 'network' }))
    dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : null })
  } else {
    const base = articleDraftRef.current
    const r: ScreenshotResponse = await browser.runtime
      .sendMessage({ type: 'GRAB_SCREENSHOT' })
      .catch(() => ({ ok: false, error: 'network' }))
    dispatch({
      type: 'DRAFT_READY',
      draft: r.ok && base ? buildScreenshotDraft(base, r.dataUrl) : null
    })
  }
}
```

- [ ] **Step 4: Render the new states**

In the JSX, render `ModeSegmented` with props and branch the preview per mode. Replace the `<ModeSegmented />` + `<BodyPreview ... />` lines (currently inside the `{draft && (<> ... </>)}` block) with:

```tsx
;<ModeSegmented mode={state.mode} disabled={!editable} onSelect={onSelectMode} />
{
  state.mode === 'screenshot' && draft?.screenshotDataUrl ? (
    <ScreenshotPreview dataUrl={draft.screenshotDataUrl} />
  ) : (
    <BodyPreview markdown={draft.contentMarkdown} />
  )
}
```

Add a `capturing` branch and a per-mode empty state. After the `{phase === 'extracting' && ...}` block, add:

```tsx
{
  phase === 'capturing' && (
    <div className="px-4 py-8 text-center text-[13px] text-text-tertiary">
      {state.mode === 'screenshot' ? 'Capturing full page…' : 'Reading selection…'}
    </div>
  )
}
```

The main editable block currently renders only when `phase !== 'extracting' && phase !== 'saved'`. Change that guard to also exclude `capturing`, and handle the no-draft case (empty selection / failed shot) with a hint. Replace the opening of that block and its inner `{draft && (` with:

```tsx
{
  phase !== 'extracting' && phase !== 'capturing' && phase !== 'saved' && (
    <div
      className={
        'flex flex-col gap-2 px-4 py-3 ' +
        (phase === 'ready' || phase === 'error' ? '' : 'opacity-60')
      }
    >
      <ModeSegmented mode={state.mode} disabled={!editable} onSelect={onSelectMode} />
      {!draft && state.mode === 'selection' && (
        <p className="py-6 text-center text-[12px] text-text-tertiary">
          Select text on the page, then reopen the popup.
        </p>
      )}
      {!draft && state.mode === 'screenshot' && (
        <p className="py-6 text-center text-[12px] text-text-tertiary">
          Couldn't capture this page.
        </p>
      )}
      {draft && (
        <>
          <EditableTitle
            value={draft.properties.title}
            disabled={!editable}
            onChange={(title) => setDraft({ ...draft, properties: { ...draft.properties, title } })}
          />
          {draft.extractionStatus === 'failed' && (
            <p className="text-[12px] text-text-tertiary">
              Couldn't read this page — saving the link and title.
            </p>
          )}
          <PropertyRows
            properties={draft.properties}
            disabled={!editable}
            onChange={(properties) => setDraft({ ...draft, properties })}
          />
          <TagEditor
            tags={draft.properties.tags}
            disabled={!editable}
            onChange={(tags) => setDraft({ ...draft, properties: { ...draft.properties, tags } })}
          />
          {state.mode === 'screenshot' && draft.screenshotDataUrl ? (
            <ScreenshotPreview dataUrl={draft.screenshotDataUrl} />
          ) : (
            <BodyPreview markdown={draft.contentMarkdown} />
          )}
        </>
      )}
    </div>
  )
}
```

NOTE: `ModeSegmented` now lives at the top of this block (outside the `{draft && ...}` so it shows even in the empty state). Remove the earlier duplicated `<ModeSegmented ... />` you added in Step 3's snippet so it appears exactly once. The "Add to Memry" button already keys off `phase === 'ready'` and is disabled when `!draft` — selection/screenshot empty states therefore can't be submitted.

- [ ] **Step 5: Typecheck + build + unit suite**

Run: `pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension build && pnpm --filter @memry/extension test`
Expected: 0 type errors; build succeeds; all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/components/ModeSegmented.tsx apps/extension/src/components/ScreenshotPreview.tsx apps/extension/src/entrypoints/popup/App.tsx
git commit -m "feat(extension): wire selection + screenshot modes into the popup"
```

---

## Task 9: Full gate + whole-branch review

**Files:** none (verification only).

- [ ] **Step 1: Extension gate**

Run: `pnpm --filter @memry/extension test && pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension lint && pnpm --filter @memry/extension build`
Expected: all green.

- [ ] **Step 2: Desktop capture gate**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts && pnpm --filter @memry/desktop test:main parse-data-url && pnpm --filter @memry/desktop typecheck:node`
Expected: all green. (If `better-sqlite3` `ERR_DLOPEN_FAILED`: `pnpm --filter @memry/desktop rebuild:node`, retry.)

- [ ] **Step 3: Contracts + article-extract gate**

Run: `pnpm --filter @memry/contracts test && pnpm --filter @memry/article-extract test`
Expected: green.

- [ ] **Step 4: Formatting**

Run: `git diff --check`
Expected: no whitespace errors. Confirm single-quote / no-semicolon / no-trailing-comma style in every changed file.

- [ ] **Step 5: Whole-branch review (opus)**

Dispatch a final review over the full branch diff (`git diff main...HEAD`) against the spec. Confirm: no `git add -A` slipped in `import-prompt/`; contract subpath import only; logical Tailwind classes; Phase 3.1 pairing/launch flow untouched; the screenshot height cap + scroll-restore are present.

- [ ] **Step 6: Manual GUI QA — HUMAN-REQUIRED (acceptance gate)**

This cannot be automated. The human must:

1. `pnpm dev` (desktop) running.
2. Load the unpacked extension (`apps/extension/.output/chrome-mv3`) in Chrome.
3. **Selection:** select text on a real article → open popup → "Selection" → confirm read-only body shows the selection → "Add to Memry" → confirm a text note lands in the inbox with the selection as markdown.
4. **Shot:** open popup → "Shot" → watch "Capturing full page…" → confirm the stitched miniature → "Add to Memry" → confirm an image note lands in the inbox showing the screenshot.
5. **Regression:** Article mode + in-app pairing (Phase 3.1) still work; switching back to Article is instant.

---

## Self-Review

**Spec coverage:**

- Selection mode (defuddle on fragment, force, read-only preview, empty state) → Tasks 5, 6, 8. ✓
- Screenshot full-page scroll+stitch → Tasks 5 (`planStitch`/`bytesToDataUrl`), 7 (background loop). ✓
- Desktop screenshot ingest (schema field, parseDataUrl, embed) → Tasks 1, 2, 3. ✓
- Messages/state/permissions (no new perms) → Task 4 (state/messages); permissions unchanged (asserted in Task 9 review). ✓
- Tests (pure logic unit-tested; entrypoints/React/canvas manual) → parseDataUrl (T2), reducer (T4), capture-modes incl. planStitch (T5); manual QA (T6,7,8,9). ✓
- Acceptance GUI QA flagged human-required → Task 9 Step 6. ✓

**Type consistency:** `ArticleCapture` envelope (`force?`, `screenshotDataUrl?`) added in Task 1 and used identically in Tasks 3/5/8. `planStitch` signature/return matches its test (T5) and caller (T7). `ScreenshotResponse`/`PageMetrics`/`CaptureMode` defined in T4, consumed with the same shapes in T6/T7/T8. `toSelectionCapture(base, selectionText, title)` and `buildScreenshotDraft(base, dataUrl)` arities match between T5 definition, T6/T8 calls.

**Placeholder scan:** none — every code step shows full content.
