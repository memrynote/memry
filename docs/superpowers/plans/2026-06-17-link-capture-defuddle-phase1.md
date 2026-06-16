# Link Capture + defuddle — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste a URL in-app → the inbox item is enriched with the full readable article (defuddle markdown) plus a property set that flows into note frontmatter when filed.

**Architecture:** A new pure package `@memry/article-extract` wraps defuddle (node entry, via linkedom) and maps its output to a shared `ArticleCapture` shape + property set. A new `article-extract` inbox job fetches raw HTML for a captured link, runs the extractor, and writes the markdown body + properties onto the inbox item. `convertToNote` passes the item's stored properties into note creation so they land as frontmatter.

**Tech Stack:** TypeScript (ESM, `.ts` import extensions), Vitest, Drizzle (better-sqlite3), `defuddle` + `linkedom` (new deps), Electron main process.

## Global Constraints

- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- Package imports use explicit `.ts` extensions (`allowImportingTsExtensions`).
- `InboxJobType` is declared in **4 places** and MUST stay in sync: `packages/contracts/src/inbox-api.ts`, `packages/rpc/src/inbox.ts`, `packages/domain-inbox/src/types.ts`, `packages/db-schema/src/schema/inbox.ts` (a const object + derived type).
- After editing contract types run `pnpm ipc:generate` then `pnpm ipc:check`.
- Node-side vitest needs native modules built for Node: run `pnpm --filter @memry/desktop rebuild:node` before running main/shared tests if you hit `ERR_DLOPEN_FAILED`.
- Desktop test invocation: `pnpm --filter @memry/desktop test:main` (main project) and the shared project picks up `packages/**` test files via `apps/desktop/config/vitest.config.ts`.
- Git commit messages: do NOT add `Co-Authored-By`.
- Logging in main: `createLogger('Scope')` from electron-log, never `console.*`.
- Branch already exists: `feat/link-capture-defuddle`. Commit each task on it.
- Phase 1 builds the **node** extractor entry only. The **browser** entry (`extractFromDocument`, for the extension) is deferred to Phase 3.

---

### Task 1: Scaffold `@memry/article-extract` + property mapping (pure)

**Files:**

- Create: `packages/article-extract/package.json`
- Create: `packages/article-extract/tsconfig.json`
- Create: `packages/article-extract/src/map.ts`
- Create: `packages/article-extract/src/index.ts`
- Test: `packages/article-extract/src/map.test.ts`
- Modify: `apps/desktop/config/vitest.config.ts` (add package to the shared `include` array ~lines 19-41 and the coverage `include` array ~lines 106-130)

**Interfaces:**

- Produces:
  - `interface ArticleProperties { title: string; source: string; author?: string[]; published?: string; created: string; description?: string; tags: string[] }`
  - `interface ArticleCapture { url: string; mode: 'article' | 'selection' | 'screenshot'; contentMarkdown: string; excerpt: string; extractionStatus: 'full' | 'partial' | 'failed'; properties: ArticleProperties; heroImage?: string }`
  - `interface DefuddleLikeResult { content?: string; title?: string; author?: string; published?: string; description?: string; image?: string; wordCount?: number }`
  - `function mapToArticleCapture(result: DefuddleLikeResult, url: string, opts?: { now?: string }): ArticleCapture`

- [ ] **Step 1: Create the package manifest**

`packages/article-extract/package.json`:

```json
{
  "name": "@memry/article-extract",
  "version": "0.1.0",
  "private": true,
  "license": "GPL-3.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./node": "./src/node.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "defuddle": "^0.6.4",
    "linkedom": "^0.18.5"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*"
  }
}
```

> Note: `./node` is referenced now so the manifest is stable; `src/node.ts` is added in Task 4. Pin the latest published versions of `defuddle` and `linkedom` at install time if these ranges are stale.

- [ ] **Step 2: Create the tsconfig**

`packages/article-extract/tsconfig.json`:

```json
{
  "extends": "@memry/typescript-config/node.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]
}
```

- [ ] **Step 3: Write the failing test**

`packages/article-extract/src/map.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mapToArticleCapture } from './map.ts'

const NOW = '2026-06-17T00:00:00.000Z'

describe('mapToArticleCapture', () => {
  it('maps defuddle fields to the property set', () => {
    const capture = mapToArticleCapture(
      {
        content: 'Body text '.repeat(60),
        title: 'Running local models is good now',
        author: 'Vicki Boykis',
        published: '2026-06-15',
        description: 'Local agentic coding has gotten good.',
        image: 'https://example.com/hero.png',
        wordCount: 120
      },
      'https://example.com/article',
      { now: NOW }
    )

    expect(capture.url).toBe('https://example.com/article')
    expect(capture.mode).toBe('article')
    expect(capture.extractionStatus).toBe('full')
    expect(capture.heroImage).toBe('https://example.com/hero.png')
    expect(capture.properties).toEqual({
      title: 'Running local models is good now',
      source: 'https://example.com/article',
      author: ['Vicki Boykis'],
      published: '2026-06-15',
      created: NOW,
      description: 'Local agentic coding has gotten good.',
      tags: ['clippings']
    })
  })

  it('flags thin content as partial and empty content as failed', () => {
    const partial = mapToArticleCapture(
      { content: 'tiny', title: 'T', wordCount: 5 },
      'https://e.com/p',
      { now: NOW }
    )
    expect(partial.extractionStatus).toBe('partial')

    const failed = mapToArticleCapture({ content: '', title: 'T' }, 'https://e.com/f', {
      now: NOW
    })
    expect(failed.extractionStatus).toBe('failed')
  })

  it('omits optional properties when defuddle returns nothing', () => {
    const capture = mapToArticleCapture(
      { content: 'words '.repeat(200), title: 'Only title', wordCount: 200 },
      'https://e.com/x',
      { now: NOW }
    )
    expect(capture.properties.author).toBeUndefined()
    expect(capture.properties.published).toBeUndefined()
    expect(capture.properties.description).toBeUndefined()
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared ../../packages/article-extract/src/map.test.ts`
Expected: FAIL — cannot resolve `./map.ts` (module not found).

> If the package's test files are not yet collected, complete Step 6 first, then re-run.

- [ ] **Step 5: Implement `map.ts`**

`packages/article-extract/src/map.ts`:

```typescript
export interface ArticleProperties {
  title: string
  source: string
  author?: string[]
  published?: string
  created: string
  description?: string
  tags: string[]
}

export interface ArticleCapture {
  url: string
  mode: 'article' | 'selection' | 'screenshot'
  contentMarkdown: string
  excerpt: string
  extractionStatus: 'full' | 'partial' | 'failed'
  properties: ArticleProperties
  heroImage?: string
}

export interface DefuddleLikeResult {
  content?: string
  title?: string
  author?: string
  published?: string
  description?: string
  image?: string
  wordCount?: number
}

const PARTIAL_WORD_THRESHOLD = 100

function extractionStatusFor(
  content: string,
  wordCount: number
): ArticleCapture['extractionStatus'] {
  if (!content.trim()) return 'failed'
  if (wordCount < PARTIAL_WORD_THRESHOLD) return 'partial'
  return 'full'
}

export function mapToArticleCapture(
  result: DefuddleLikeResult,
  url: string,
  opts: { now?: string } = {}
): ArticleCapture {
  const now = opts.now ?? new Date().toISOString()
  const contentMarkdown = result.content ?? ''
  const wordCount = result.wordCount ?? 0
  const title = result.title?.trim() || url

  const properties: ArticleProperties = {
    title,
    source: url,
    created: now,
    tags: ['clippings']
  }
  if (result.author?.trim()) properties.author = [result.author.trim()]
  if (result.published?.trim()) properties.published = result.published.trim()
  if (result.description?.trim()) properties.description = result.description.trim()

  return {
    url,
    mode: 'article',
    contentMarkdown,
    excerpt: result.description?.trim() || contentMarkdown.slice(0, 200),
    extractionStatus: extractionStatusFor(contentMarkdown, wordCount),
    properties,
    heroImage: result.image?.trim() || undefined
  }
}
```

- [ ] **Step 6: Create the barrel export and register the package in vitest**

`packages/article-extract/src/index.ts`:

```typescript
export type { ArticleCapture, ArticleProperties, DefuddleLikeResult } from './map.ts'
export { mapToArticleCapture } from './map.ts'
```

In `apps/desktop/config/vitest.config.ts`, add to the shared project `include` array (after the `onenote-import` line):

```typescript
'../../packages/article-extract/src/**/*.{test,spec}.{ts,tsx}',
```

And add to the coverage `include` array (after the `onenote-import` line):

```typescript
'../../packages/article-extract/src/**/*.ts',
```

- [ ] **Step 7: Install deps and run the test to verify it passes**

Run: `pnpm install`
Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared ../../packages/article-extract/src/map.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/article-extract apps/desktop/config/vitest.config.ts pnpm-lock.yaml
git commit -m "feat(article-extract): scaffold package + property mapping"
```

---

### Task 2: Node extractor entry (`extractFromHtml` via linkedom + defuddle)

**Files:**

- Create: `packages/article-extract/src/node.ts`
- Test: `packages/article-extract/src/node.test.ts`

**Interfaces:**

- Consumes: `mapToArticleCapture`, `ArticleCapture` from `./map.ts`.
- Produces: `function extractFromHtml(html: string, url: string, opts?: { now?: string }): Promise<ArticleCapture>`

- [ ] **Step 1: Write the failing test**

`packages/article-extract/src/node.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { extractFromHtml } from './node.ts'

const FIXTURE = `<!doctype html>
<html>
  <head>
    <title>Running local models is good now</title>
    <meta name="author" content="Vicki Boykis" />
    <meta name="description" content="Local agentic coding has gotten good." />
  </head>
  <body>
    <nav>home about</nav>
    <article>
      <h1>Running local models is good now</h1>
      <p>I have been working with local models since they came out and they are good.</p>
      <p>With recent releases I can do agentic coding locally at about seventy five percent quality.</p>
    </article>
    <footer>copyright</footer>
  </body>
</html>`

describe('extractFromHtml', () => {
  it('extracts the article body and title from raw HTML', async () => {
    const capture = await extractFromHtml(FIXTURE, 'https://example.com/article', {
      now: '2026-06-17T00:00:00.000Z'
    })

    expect(capture.properties.title).toContain('Running local models')
    expect(capture.properties.source).toBe('https://example.com/article')
    expect(capture.contentMarkdown).toContain('local models')
    expect(capture.extractionStatus).not.toBe('failed')
  })

  it('returns failed status for empty HTML', async () => {
    const capture = await extractFromHtml('<html><body></body></html>', 'https://e.com/x')
    expect(capture.extractionStatus).toBe('failed')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared ../../packages/article-extract/src/node.test.ts`
Expected: FAIL — cannot resolve `./node.ts`.

- [ ] **Step 3: Implement `node.ts`**

`packages/article-extract/src/node.ts`:

```typescript
import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'
import { mapToArticleCapture, type ArticleCapture, type DefuddleLikeResult } from './map.ts'

export async function extractFromHtml(
  html: string,
  url: string,
  opts: { now?: string } = {}
): Promise<ArticleCapture> {
  const { document } = parseHTML(html)
  const result = (await Defuddle(document, url, { markdown: true })) as DefuddleLikeResult
  return mapToArticleCapture(result, url, opts)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared ../../packages/article-extract/src/node.test.ts`
Expected: PASS (2 tests).

> If `defuddle/node` types are missing, confirm `defuddle` resolves the `./node` subpath export; if not, import from `defuddle` and pass the linkedom document — the runtime API is the same.

- [ ] **Step 5: Commit**

```bash
git add packages/article-extract/src/node.ts packages/article-extract/src/node.test.ts
git commit -m "feat(article-extract): node extractFromHtml via linkedom + defuddle"
```

---

### Task 3: Add `article-extract` job type + `extractionStatus` on `LinkMetadata`

**Files:**

- Modify: `packages/contracts/src/inbox-api.ts:34-39`
- Modify: `packages/rpc/src/inbox.ts:24-29`
- Modify: `packages/domain-inbox/src/types.ts:15-20` (union) and `:24-35` (LinkMetadata)
- Modify: `packages/db-schema/src/schema/inbox.ts:50-58`
- Test: `packages/db-schema/src/schema/inbox.test.ts` (create if absent)

**Interfaces:**

- Produces: `InboxJobType` now includes `'article-extract'` in all 4 declarations; `LinkMetadata.extractionStatus?: 'full' | 'partial' | 'failed'`.

- [ ] **Step 1: Write the failing test**

`packages/db-schema/src/schema/inbox.test.ts` (append to existing describe if the file exists):

```typescript
import { describe, it, expect } from 'vitest'
import { inboxJobType } from './inbox.ts'

describe('inboxJobType', () => {
  it('includes the article-extract job type', () => {
    expect(inboxJobType.ARTICLE_EXTRACT).toBe('article-extract')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared ../../packages/db-schema/src/schema/inbox.test.ts`
Expected: FAIL — `inboxJobType.ARTICLE_EXTRACT` is undefined.

- [ ] **Step 3: Add the const + type in db-schema**

In `packages/db-schema/src/schema/inbox.ts`, update the const object (lines 50-56):

```typescript
export const inboxJobType = {
  TRANSCRIPTION: 'transcription',
  METADATA_SCRAPE: 'metadata-scrape',
  DUPLICATE_DETECTION: 'duplicate-detection',
  SUGGESTION_GENERATION: 'suggestion-generation',
  THUMBNAIL_GENERATION: 'thumbnail-generation',
  ARTICLE_EXTRACT: 'article-extract'
} as const
```

- [ ] **Step 4: Add the literal to the other three unions**

In each of `packages/contracts/src/inbox-api.ts`, `packages/rpc/src/inbox.ts`, `packages/domain-inbox/src/types.ts`, change the `InboxJobType` union to:

```typescript
export type InboxJobType =
  | 'transcription'
  | 'metadata-scrape'
  | 'duplicate-detection'
  | 'suggestion-generation'
  | 'thumbnail-generation'
  | 'article-extract'
```

- [ ] **Step 5: Add `extractionStatus` to `LinkMetadata`**

In `packages/domain-inbox/src/types.ts`, update the `LinkMetadata` interface (lines 24-35) to add one field:

```typescript
export interface LinkMetadata {
  url: string
  siteName?: string
  description?: string
  excerpt?: string
  heroImage?: string | null
  favicon?: string | null
  author?: string
  publishedDate?: string
  fetchedAt?: string
  fetchStatus: 'pending' | 'success' | 'partial' | 'failed'
  extractionStatus?: 'full' | 'partial' | 'failed'
}
```

- [ ] **Step 6: Run the test + typecheck + ipc regen**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared ../../packages/db-schema/src/schema/inbox.test.ts`
Expected: PASS.
Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: ipc check passes (invoke map up to date).
Run: `pnpm typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts packages/rpc packages/domain-inbox packages/db-schema apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(inbox): add article-extract job type + LinkMetadata.extractionStatus"
```

---

### Task 4: `fetchUrlHtml` helper in metadata.ts

**Files:**

- Modify: `apps/desktop/src/main/inbox/metadata.ts` (add an exported function near `fetchUrlMetadata`)
- Test: `apps/desktop/src/main/inbox/metadata.test.ts` (create if absent)

**Interfaces:**

- Consumes: existing private `chromiumFetch`, `rewriteUrlForFetch`, `USER_AGENT`, `URL_FETCH_TIMEOUT` in the same module.
- Produces: `export async function fetchUrlHtml(url: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/main/inbox/metadata.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

describe('fetchUrlHtml', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('returns the response body text', async () => {
    fetchMock.mockResolvedValue(new Response('<html><body>hi</body></html>', { status: 200 }))
    const { fetchUrlHtml } = await import('./metadata.ts')
    const html = await fetchUrlHtml('https://example.com/article')
    expect(html).toContain('<body>hi</body>')
  })

  it('throws on non-ok status', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))
    const { fetchUrlHtml } = await import('./metadata.ts')
    await expect(fetchUrlHtml('https://example.com/missing')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- src/main/inbox/metadata.test.ts`
Expected: FAIL — `fetchUrlHtml` is not exported.

> If you hit `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node` first.

- [ ] **Step 3: Implement `fetchUrlHtml`**

In `apps/desktop/src/main/inbox/metadata.ts`, add (immediately after `fetchUrlMetadata`):

```typescript
export async function fetchUrlHtml(url: string): Promise<string> {
  const fetchUrl = rewriteUrlForFetch(url)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT)

  try {
    const response = await chromiumFetch(fetchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`)
    }
    return await response.text()
  } finally {
    clearTimeout(timeoutId)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- src/main/inbox/metadata.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/inbox/metadata.ts apps/desktop/src/main/inbox/metadata.test.ts
git commit -m "feat(inbox): add fetchUrlHtml helper"
```

---

### Task 5: `article-extract` job processor + queue function + switch wiring

**Files:**

- Modify: `apps/desktop/src/main/inbox/jobs.ts` (add processor, queue fn, switch case, retry constant)
- Test: `apps/desktop/src/main/inbox/jobs.article-extract.test.ts`

**Interfaces:**

- Consumes: `fetchUrlHtml` (Task 4), `extractFromHtml` from `@memry/article-extract/node` (Task 2), existing helpers `requireDatabase`, `upsertJob`, `scheduleJob`, `completeJob`, `failJob`, `rescheduleJob`, `emitUpdated`, `inboxItems`.
- Produces: `export function queueInboxArticleExtractJob(itemId: string, url: string, options?: { maxAttempts?: number; runAt?: string }): string`

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/main/inbox/jobs.article-extract.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('@memry/article-extract/node', () => ({
  extractFromHtml: vi.fn(async (_html: string, url: string) => ({
    url,
    mode: 'article' as const,
    contentMarkdown: '# Title\n\nBody.',
    excerpt: 'Body.',
    extractionStatus: 'full' as const,
    properties: {
      title: 'Title',
      source: url,
      created: '2026-06-17T00:00:00.000Z',
      tags: ['clippings']
    }
  }))
}))

describe('queueInboxArticleExtractJob', () => {
  it('is exported with the expected arity', async () => {
    const mod = await import('./jobs.ts')
    expect(typeof mod.queueInboxArticleExtractJob).toBe('function')
    expect(mod.queueInboxArticleExtractJob.length).toBe(2)
  })
})
```

> Rationale: the full processor path touches the DB + scheduler singletons. This task's unit test pins the public surface; end-to-end behavior is verified by the paste-flow manual check at the end of the phase. Keep the test light to avoid coupling to the job-runner singletons.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- src/main/inbox/jobs.article-extract.test.ts`
Expected: FAIL — `queueInboxArticleExtractJob` is undefined.

- [ ] **Step 3: Add the retry constant**

In `apps/desktop/src/main/inbox/jobs.ts`, near the existing `METADATA_RETRY_DELAY_MS` constant, add:

```typescript
const ARTICLE_RETRY_DELAY_MS = 5_000
```

- [ ] **Step 4: Add the processor**

In `apps/desktop/src/main/inbox/jobs.ts`, add (after `processMetadataJob`):

```typescript
async function processArticleExtractJob(db: DataDb, job: JobRow): Promise<void> {
  const item = db.select().from(inboxItems).where(eq(inboxItems.id, job.itemId)).get()
  const sourceUrl = item?.sourceUrl || (job.payload?.url as string | undefined)

  if (!item || !sourceUrl) {
    failJob(db, job.id, 'Link item not found or missing source URL.')
    return
  }

  try {
    const { fetchUrlHtml } = await import('./metadata')
    const { extractFromHtml } = await import('@memry/article-extract/node')
    const html = await fetchUrlHtml(sourceUrl)
    const capture = await extractFromHtml(html, sourceUrl)

    if (capture.extractionStatus === 'failed') {
      completeJob(db, job.id, { extractionStatus: 'failed' })
      return
    }

    const now = new Date().toISOString()
    const existingMetadata =
      item.metadata && typeof item.metadata === 'object'
        ? (item.metadata as Record<string, unknown>)
        : {}

    db.update(inboxItems)
      .set({
        content: capture.contentMarkdown,
        modifiedAt: now,
        metadata: {
          ...existingMetadata,
          url: sourceUrl,
          excerpt: capture.excerpt,
          extractionStatus: capture.extractionStatus,
          properties: capture.properties
        }
      })
      .where(eq(inboxItems.id, job.itemId))
      .run()

    emitUpdated(job.itemId, { content: capture.contentMarkdown })
    completeJob(db, job.id, { extractionStatus: capture.extractionStatus })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown extraction error'
    if (job.attempts < job.maxAttempts) {
      rescheduleJob(db, job, message, ARTICLE_RETRY_DELAY_MS)
      return
    }
    failJob(db, job.id, message)
  }
}
```

- [ ] **Step 5: Wire the switch case**

In `processInboxJob`'s `switch (runningJob.type)` block, add before `default:`:

```typescript
      case 'article-extract':
        await processArticleExtractJob(db, runningJob)
        break
```

- [ ] **Step 6: Add the queue function**

In `apps/desktop/src/main/inbox/jobs.ts`, add (after `queueInboxMetadataJob`):

```typescript
export function queueInboxArticleExtractJob(
  itemId: string,
  url: string,
  options: { maxAttempts?: number; runAt?: string } = {}
): string {
  const db = requireDatabase()
  const runAt = options.runAt ?? new Date().toISOString()
  const jobId = upsertJob(db, {
    itemId,
    type: 'article-extract',
    status: 'pending',
    payload: { url },
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 2,
    runAt,
    lastError: null,
    startedAt: null,
    completedAt: null,
    result: null
  })

  scheduleJob(jobId, runAt)
  return jobId
}
```

> Note: `upsertJob` keys a job by `(itemId, type)`, so the new `article-extract` job coexists with the `metadata-scrape` job on the same item.

- [ ] **Step 7: Run the test + typecheck**

Run: `pnpm --filter @memry/desktop test:main -- src/main/inbox/jobs.article-extract.test.ts`
Expected: PASS.
Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/inbox/jobs.ts apps/desktop/src/main/inbox/jobs.article-extract.test.ts
git commit -m "feat(inbox): article-extract job processor + queue"
```

---

### Task 6: Trigger article-extract from the capture path

**Files:**

- Modify: `apps/desktop/src/main/inbox/domain.ts:482-484` (the `queueMetadataJob` handler) + its import line for the queue functions.

**Interfaces:**

- Consumes: `queueInboxArticleExtractJob` (Task 5).

- [ ] **Step 1: Add the import**

In `apps/desktop/src/main/inbox/domain.ts`, find the existing import of `queueInboxMetadataJob` from `./jobs` and add `queueInboxArticleExtractJob` to it, e.g.:

```typescript
import { queueInboxMetadataJob, queueInboxArticleExtractJob } from './jobs'
```

- [ ] **Step 2: Queue the article job alongside metadata**

Change the `queueMetadataJob` handler (lines 482-484) to:

```typescript
    queueMetadataJob: (itemId, url) => {
      queueInboxMetadataJob(itemId, url)
      queueInboxArticleExtractJob(itemId, url)
    },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/inbox/domain.ts
git commit -m "feat(inbox): queue article extraction when a link is captured"
```

---

### Task 7: Carry item properties into the note on file-to-note

**Files:**

- Modify: `apps/desktop/src/main/inbox/filing.ts` (add a pure helper + use it in `convertToNote` ~line 616)
- Test: `apps/desktop/src/main/inbox/filing.properties.test.ts`

**Interfaces:**

- Produces: `export function extractItemProperties(metadata: unknown): Record<string, unknown> | undefined`
- Consumes: existing `createNote({ ..., properties })` (the input already accepts `properties?: Record<string, unknown>`).

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/main/inbox/filing.properties.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { extractItemProperties } from './filing.ts'

describe('extractItemProperties', () => {
  it('returns the properties object from item metadata', () => {
    const props = extractItemProperties({
      url: 'https://e.com',
      properties: { title: 'T', source: 'https://e.com', tags: ['clippings'] }
    })
    expect(props).toEqual({ title: 'T', source: 'https://e.com', tags: ['clippings'] })
  })

  it('returns undefined when there are no properties', () => {
    expect(extractItemProperties({ url: 'https://e.com' })).toBeUndefined()
    expect(extractItemProperties(null)).toBeUndefined()
    expect(extractItemProperties('not-an-object')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- src/main/inbox/filing.properties.test.ts`
Expected: FAIL — `extractItemProperties` is not exported.

- [ ] **Step 3: Implement the helper**

In `apps/desktop/src/main/inbox/filing.ts`, add (near the top-level exports):

```typescript
export function extractItemProperties(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const properties = (metadata as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object') return undefined
  return properties as Record<string, unknown>
}
```

- [ ] **Step 4: Use it in `convertToNote`**

In `convertToNote`, change the `createNote` call (currently ~lines 616-620) to pass properties:

```typescript
const note = await createNote({
  title,
  content,
  tags: mergedTags,
  properties: extractItemProperties(item.metadata)
})
```

- [ ] **Step 5: Run the test + typecheck**

Run: `pnpm --filter @memry/desktop test:main -- src/main/inbox/filing.properties.test.ts`
Expected: PASS (2 tests).
Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/inbox/filing.ts apps/desktop/src/main/inbox/filing.properties.test.ts
git commit -m "feat(inbox): carry captured properties into note frontmatter on filing"
```

---

## Phase verification (manual, end of phase)

- [ ] Run the desktop app: `pnpm dev`.
- [ ] Capture a link (paste a real article URL into the inbox).
- [ ] Confirm: card appears immediately (metadata job), then the inbox item body fills with the full article markdown within a few seconds (article-extract job).
- [ ] File the item to a note; open the note and confirm the frontmatter has `title`, `source`, `created`, `tags` (+ `author`/`published`/`description` when the source provided them).
- [ ] Run the full gate: `pnpm lint && pnpm typecheck && pnpm test:desktop`.

## Self-review notes (coverage vs spec)

- Spec §"New package `@memry/article-extract`": Tasks 1-2 (node entry only; browser entry deferred to Phase 3 per Global Constraints).
- Spec §"Property model": Tasks 1 (mapping) + 7 (file-to-note frontmatter). Property-definition auto-creation (`source=link`, etc.) is deferred — Phase 1 writes frontmatter values; definitions/glyphs land with the popup work (Phase 3) where the editor needs them.
- Spec §"Path A — in-app paste": Tasks 4-6.
- Spec §"Data model changes" (`InboxJobType` += `article-extract`, `LinkMetadata.extractionStatus`): Task 3.
- Out of Phase 1 scope (later phases): loopback server + security, extension, popup, selection/screenshot, queue/retry, deeplink pairing.
