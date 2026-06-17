# Link Capture Phase 3 — Chromium Extension (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Chromium MV3 browser extension that captures the current page as a readable article (defuddle on the live DOM) and saves it to the Memry desktop app's localhost capture server, with a review-then-save popup that looks like a Memry note.

**Architecture:** New WXT workspace package `apps/extension`. A content script runs `extractFromDocument` (new browser entry added to `@memry/article-extract`) on the live DOM and returns an `ArticleCapture` draft. A background service worker owns the pairing token (`chrome.storage.local`) and all loopback network calls (port probe, `/pair/claim` auto-poll, `/capture` POST with the three required headers). A React popup orchestrates draft + connection status, renders the editable note miniature, and saves.

**Tech Stack:** WXT (MV3, Vite under the hood), React 19, Tailwind v4 (`@tailwindcss/vite`), defuddle 0.19 (browser build), `marked` + `dompurify` (read-only body preview), Vitest + jsdom (unit tests). Node 24, pnpm 11.5.2.

## Global Constraints

- **Repo style (Prettier):** single quotes, no semicolons, 100-char width, no trailing commas. Copy this exactly — the repo has no semicolons.
- **No `Co-Authored-By`** trailer on any commit.
- **Tailwind logical properties only** in new code: `ms-*`/`me-*` not `ml-*`/`mr-*`, `ps-*`/`pe-*` not `pl-*`/`pr-*`, `start-*`/`end-*` not `left-*`/`right-*`, `text-start`/`text-end`. Reject physical classes.
- **Package name:** `@memry/extension`, `private: true`. Workspace glob `apps/*` already matches — no `pnpm-workspace.yaml` edit needed.
- **Excluded from desktop build:** desktop only bundles what it imports; never import from `apps/extension` in `apps/desktop`. No electron-builder/electron.vite change needed.
- **Server contract (code against this exactly):**
  - Loopback only, ports probed `7849`..`7856` (`DEFAULT_PORT 7849`, `PROBE_RANGE 8`).
  - `GET /ping` (unauth) → `200 { app:'memry', version, paired }`. `paired` = is the caller's `Origin` allowlisted.
  - `POST /pair/claim` → headers: `Origin: chrome-extension://<id>` + `X-Memry-Capture` (presence checked). No body. → `200 { token, port }` | `400 { error:'missing-origin' }` | `403 { error:'pairing-window-closed' }`. Window opens for 120s only after the user confirms the `memry://pair` dialog; first successful claim closes it.
  - `POST /capture` → headers (ALL required): `Authorization: Bearer <token>`, allowlisted `Origin`, `X-Memry-Capture: 1`, `Content-Type: application/json`. Body = `ArticleCapture` JSON. → `200 { itemId }` | `401 { error:'missing-capture-header'|'origin-not-allowed'|'bad-token' }` | `422 { error:'invalid-capture' }` | `413 { error:'payload-too-large' }`.
  - Token: 64-hex string. Store in `chrome.storage.local`.
- **`ArticleCapture` body shape** (produced by `mapToArticleCapture`, validated server-side by `ArticleCaptureSchema`):
  ```ts
  {
    url: string                          // valid URL
    mode: 'article'
    contentMarkdown: string
    excerpt: string
    extractionStatus: 'full' | 'partial' | 'failed'
    properties: {
      title: string
      source: string
      author?: string[]
      published?: string
      created: string                    // ISO 8601
      description?: string
      tags: string[]                     // defaults to ['clippings']
    }
    heroImage?: string
  }
  ```
- **MVP scope (keep tight):** article mode only; Selection/Shot segmented buttons present but disabled (Phase 4). NO queue/retry/badge, NO keyboard command, NO settings UI, NO "Add and open note" (Phase 5). Light + dark via `prefers-color-scheme`. All property rows editable; body preview read-only.
- **Deliberate simplifications (ponytail), each marked in code with a `// ponytail:` comment:**
  - System-serif fallback (`Georgia`) instead of bundling Crimson Pro woff2. Upgrade: bundle the variable woff2 when polishing.
  - No manifest `key`; the dev unpacked extension ID is stable as long as the `.output/chrome-mv3` path is stable, so pairing survives reloads. Upgrade: add a fixed `key` if the load path moves.
  - No custom toolbar icon (WXT default placeholder). Upgrade: add `public/icon/*.png` in polish.
  - Declared content script on `*://*/*` (standard clipper pattern); does nothing until messaged. Upgrade: on-demand `scripting.executeScript` if always-on injection becomes a concern.
- **Acceptance gate = manual GUI QA (human-required).** Cross-process pairing (`memry://pair` confirm → claim window → token) cannot be automated here. Unit tests cover pure logic only.

---

## File Structure

```
packages/article-extract/
  src/browser.ts                 # NEW: extractFromDocument(doc, url, opts) — browser defuddle + reuse mapToArticleCapture
  package.json                   # MODIFY: add "./browser" export
  tsconfig.json                  # MODIFY: add DOM lib for the browser entry

apps/extension/
  package.json                   # NEW: @memry/extension, scripts + deps
  wxt.config.ts                  # NEW: react module, manifest, tailwind vite plugin
  tsconfig.json                  # NEW: extends .wxt/tsconfig.json
  eslint.config.js               # NEW: flat config, ignores .wxt/.output
  vitest.config.ts               # NEW: jsdom environment
  .gitignore                     # NEW: .wxt, .output, stats.html
  src/
    lib/messages.ts              # NEW: popup<->bg<->content message protocol types
    lib/capture-client.ts        # NEW: pure URL/header builders + fetch fns + pollUntil
    lib/capture-client.test.ts   # NEW
    lib/popup-state.ts           # NEW: pure reducer + selectPhase + mapError
    lib/popup-state.test.ts      # NEW
    lib/extract.test.ts          # NEW: extractFromDocument jsdom test
    entrypoints/background.ts    # NEW: token storage + network router
    entrypoints/content.ts       # NEW: EXTRACT handler
    entrypoints/popup/index.html # NEW
    entrypoints/popup/main.tsx   # NEW: React mount
    entrypoints/popup/App.tsx    # NEW: orchestration
    entrypoints/popup/tokens.css # NEW: Memry token subset + tailwind @theme (light+dark)
    components/StatusStrip.tsx    # NEW
    components/EditableTitle.tsx  # NEW
    components/PropertyRows.tsx   # NEW
    components/TagEditor.tsx      # NEW
    components/BodyPreview.tsx    # NEW
    components/ModeSegmented.tsx  # NEW
    components/PrimaryButton.tsx  # NEW
  README.md                      # NEW: load-unpacked + manual QA checklist

package.json (root)              # MODIFY: add dev/build/lint/test/typecheck:extension scripts
```

---

## Task 1: Scaffold `apps/extension` (WXT + React + Tailwind + Vitest, wired to monorepo)

**Files:**

- Create: `apps/extension/package.json`
- Create: `apps/extension/wxt.config.ts`
- Create: `apps/extension/tsconfig.json`
- Create: `apps/extension/eslint.config.js`
- Create: `apps/extension/vitest.config.ts`
- Create: `apps/extension/.gitignore`
- Create: `apps/extension/src/entrypoints/popup/index.html`
- Create: `apps/extension/src/entrypoints/popup/main.tsx`
- Create: `apps/extension/src/entrypoints/popup/App.tsx` (shell only this task)
- Create: `apps/extension/src/entrypoints/popup/tokens.css`
- Create: `apps/extension/src/lib/sanity.test.ts`
- Modify: root `package.json` (convenience scripts)

**Interfaces:**

- Produces: a buildable `@memry/extension` package with `dev`/`build`/`typecheck`/`lint`/`test` scripts; depends on `@memry/article-extract` (workspace). Later tasks add modules under `src/`.

- [ ] **Step 1: Create `apps/extension/package.json`**

```json
{
  "name": "@memry/extension",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "typecheck": "wxt prepare && tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "postinstall": "wxt prepare"
  },
  "dependencies": {
    "@memry/article-extract": "workspace:*",
    "dompurify": "^3.2.4",
    "marked": "^15.0.6",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.18",
    "@types/react": "^19.2.5",
    "@types/react-dom": "^19.2.3",
    "@wxt-dev/module-react": "^1.1.3",
    "eslint": "^9.39.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.1.18",
    "typescript": "~5.9.3",
    "typescript-eslint": "^8.46.4",
    "vitest": "^3.2.4",
    "wxt": "^0.20.6"
  }
}
```

- [ ] **Step 2: Create `apps/extension/.gitignore`**

```
.wxt
.output
stats.html
node_modules
```

- [ ] **Step 3: Create `apps/extension/wxt.config.ts`**

```ts
import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite'

// ponytail: no manifest `key` — dev unpacked ID is stable while the .output path is stable, so pairing survives reloads.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'Memry Web Clipper',
    description: 'Save the page you are reading to Memry as a readable note.',
    permissions: ['storage', 'activeTab'],
    host_permissions: ['http://127.0.0.1/*']
  },
  vite: () => ({
    plugins: [tailwindcss()]
  })
})
```

- [ ] **Step 4: Create `apps/extension/tsconfig.json`**

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "strict": true
  }
}
```

- [ ] **Step 5: Create `apps/extension/eslint.config.js`**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['.wxt', '.output', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended
)
```

- [ ] **Step 6: Create `apps/extension/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
```

- [ ] **Step 7: Create `apps/extension/src/entrypoints/popup/tokens.css`**

```css
@import 'tailwindcss';

@theme {
  --color-background: var(--bg);
  --color-surface: var(--surface);
  --color-surface-active: var(--surface-active);
  --color-foreground: var(--fg);
  --color-text-secondary: var(--text-secondary);
  --color-text-tertiary: var(--text-tertiary);
  --color-border: var(--border);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-accent-green: var(--accent-green);
  --font-serif: 'Crimson Pro', Georgia, 'Times New Roman', serif;
  --font-sans: ui-sans-serif, -apple-system, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif;
}

/* Memry token subset, copied from apps/desktop/src/renderer/src/assets/base.css */
:root {
  --bg: #f6f5f0;
  --surface: #efefe9;
  --surface-active: #e4e4de;
  --fg: #1a1a1a;
  --text-secondary: #4a4a4a;
  --text-tertiary: #8c8c8c;
  --border: #e4e4de;
  --primary: #1a1a1a;
  --primary-foreground: #f6f5f0;
  --accent-green: #22c55e;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181919;
    --surface: #222222;
    --surface-active: #2a2a2a;
    --fg: #bcbab6;
    --text-secondary: #bcbab6;
    --text-tertiary: #ada9a3;
    --border: #2a2a2a;
    --primary: #e8e6e1;
    --primary-foreground: #191919;
    --accent-green: #4ade80;
  }
}

html,
body {
  margin: 0;
}

#root {
  width: 400px;
}
```

- [ ] **Step 8: Create `apps/extension/src/entrypoints/popup/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Memry</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 9: Create `apps/extension/src/entrypoints/popup/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './tokens.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

- [ ] **Step 10: Create `apps/extension/src/entrypoints/popup/App.tsx` (shell)**

```tsx
export default function App() {
  return (
    <div className="bg-background font-sans text-foreground">
      <div className="px-4 py-3 text-text-tertiary">Memry</div>
    </div>
  )
}
```

- [ ] **Step 11: Create `apps/extension/src/lib/sanity.test.ts`**

```ts
import { expect, test } from 'vitest'

test('toolchain runs', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 12: Install and verify the package builds + lints + types + tests**

Run from repo root:

```bash
pnpm install
pnpm --filter @memry/extension test
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
pnpm --filter @memry/extension build
```

Expected: install succeeds; `test` PASS (1 test); `typecheck` no errors; `lint` clean; `build` writes `apps/extension/.output/chrome-mv3/`.

- [ ] **Step 13: Add root convenience scripts**

In root `package.json` `scripts`, add (place near the other `dev:`/`build:` entries):

```json
"dev:extension": "pnpm --filter @memry/extension dev",
"build:extension": "pnpm --filter @memry/extension build",
"typecheck:extension": "pnpm --filter @memry/extension typecheck",
"lint:extension": "pnpm --filter @memry/extension lint",
"test:extension": "pnpm --filter @memry/extension test"
```

- [ ] **Step 14: Commit**

```bash
git add apps/extension package.json pnpm-lock.yaml
git commit -m "feat(extension): scaffold @memry/extension WXT package"
```

---

## Task 2: Add `extractFromDocument` browser entry to `@memry/article-extract`

**Files:**

- Create: `packages/article-extract/src/browser.ts`
- Modify: `packages/article-extract/package.json` (add `./browser` export)
- Modify: `packages/article-extract/tsconfig.json` (add DOM lib)
- Test: `apps/extension/src/lib/extract.test.ts`

**Interfaces:**

- Produces: `extractFromDocument(doc: Document, url: string, opts?: { now?: string }): ArticleCapture` from `@memry/article-extract/browser`. Reuses `mapToArticleCapture` — same `ArticleCapture` shape as the Node `extractFromHtml`.
- Consumes: existing `mapToArticleCapture` and `DefuddleLikeResult`, `ArticleCapture` from `./map.ts`.

- [ ] **Step 1: Write the failing test** `apps/extension/src/lib/extract.test.ts`

```ts
import { expect, test } from 'vitest'
import { extractFromDocument } from '@memry/article-extract/browser'

test('extractFromDocument returns an article-mode capture from a live document', () => {
  document.title = 'Local models'
  document.body.innerHTML = `
    <article>
      <h1>Local models</h1>
      <p>${'I have been working with local models and the results are encouraging. '.repeat(20)}</p>
    </article>`

  const capture = extractFromDocument(document, 'https://example.com/post', {
    now: '2026-06-17T00:00:00.000Z'
  })

  expect(capture.mode).toBe('article')
  expect(capture.url).toBe('https://example.com/post')
  expect(capture.properties.source).toBe('https://example.com/post')
  expect(capture.properties.created).toBe('2026-06-17T00:00:00.000Z')
  expect(capture.properties.tags).toEqual(['clippings'])
  expect(typeof capture.contentMarkdown).toBe('string')
  expect(['full', 'partial', 'failed']).toContain(capture.extractionStatus)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/extension test src/lib/extract.test.ts`
Expected: FAIL — cannot resolve `@memry/article-extract/browser`.

- [ ] **Step 3: Add DOM lib to `packages/article-extract/tsconfig.json`**

Replace the file with (the `lib` override is local to this package; `extends` `node.json` sets `lib: ['ESNext']`, and `lib` does not merge — re-list it):

```json
{
  "extends": "@memry/typescript-config/node.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "lib": ["ESNext", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]
}
```

- [ ] **Step 4: Create `packages/article-extract/src/browser.ts`**

```ts
import Defuddle from 'defuddle'
import { mapToArticleCapture, type ArticleCapture, type DefuddleLikeResult } from './map.ts'

// Browser counterpart to extractFromHtml: defuddle parses the LIVE DOM (higher
// fidelity than fetched HTML because computed styles are available), then we
// reuse the exact same mapping the Node path uses.
export function extractFromDocument(
  doc: Document,
  url: string,
  opts: { now?: string } = {}
): ArticleCapture {
  const result = new Defuddle(doc, { markdown: true }).parse() as DefuddleLikeResult
  return mapToArticleCapture(result, url, opts)
}
```

- [ ] **Step 5: Add the `./browser` export to `packages/article-extract/package.json`**

Change the `exports` block to:

```json
  "exports": {
    ".": "./src/index.ts",
    "./node": "./src/node.ts",
    "./browser": "./src/browser.ts"
  },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @memry/extension test src/lib/extract.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify article-extract still typechecks**

Run: `pnpm --filter @memry/article-extract typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/article-extract apps/extension/src/lib/extract.test.ts
git commit -m "feat(article-extract): add browser extractFromDocument entry"
```

---

## Task 3: Message protocol + capture client (URL/header builders, fetch fns, poll)

**Files:**

- Create: `apps/extension/src/lib/messages.ts`
- Create: `apps/extension/src/lib/capture-client.ts`
- Test: `apps/extension/src/lib/capture-client.test.ts`

**Interfaces:**

- Produces (`messages.ts`): types `ConnectionState`, `StatusResponse`, `PairResponse`, `CaptureResponse`, `PopupMessage`, `ContentMessage`, `ExtractResponse`.
- Produces (`capture-client.ts`): `PROBE_PORTS`, `pingUrl`, `claimUrl`, `captureUrl`, `captureHeaders`, `parsePing`, `probeServer`, `claimToken`, `postCapture`, `pollUntil`.
- Consumes: `ArticleCapture` from `@memry/article-extract`.

- [ ] **Step 1: Create `apps/extension/src/lib/messages.ts`**

```ts
import type { ArticleCapture } from '@memry/article-extract'

export type ConnectionState = 'app-closed' | 'needs-pairing' | 'ready'

export interface StatusResponse {
  connection: ConnectionState
  port: number | null
}

export interface PairResponse {
  ok: boolean
}

export type CaptureResponse = { ok: true; itemId: string } | { ok: false; error: string }

export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'START_PAIR' }
  | { type: 'CAPTURE'; capture: ArticleCapture }

export type ContentMessage = { type: 'EXTRACT' }

export type ExtractResponse = { ok: true; capture: ArticleCapture } | { ok: false; error: string }
```

- [ ] **Step 2: Write the failing test** `apps/extension/src/lib/capture-client.test.ts`

```ts
import { describe, expect, test, vi } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import {
  PROBE_PORTS,
  captureHeaders,
  claimToken,
  parsePing,
  pingUrl,
  pollUntil,
  postCapture,
  probeServer
} from './capture-client'

const draft: ArticleCapture = {
  url: 'https://example.com/p',
  mode: 'article',
  contentMarkdown: '# Hi',
  excerpt: 'Hi',
  extractionStatus: 'full',
  properties: { title: 'Hi', source: 'https://example.com/p', created: 'now', tags: ['clippings'] }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

describe('probe range', () => {
  test('covers 7849..7856', () => {
    expect(PROBE_PORTS).toEqual([7849, 7850, 7851, 7852, 7853, 7854, 7855, 7856])
    expect(pingUrl(7849)).toBe('http://127.0.0.1:7849/ping')
  })
})

describe('parsePing', () => {
  test('accepts a memry ping', () => {
    expect(parsePing({ app: 'memry', version: '1.0.0', paired: true })?.paired).toBe(true)
  })
  test('rejects a foreign server', () => {
    expect(parsePing({ app: 'other', paired: true })).toBeNull()
    expect(parsePing('nope')).toBeNull()
  })
})

describe('captureHeaders', () => {
  test('carries all three required signals', () => {
    const h = captureHeaders('abc')
    expect(h.Authorization).toBe('Bearer abc')
    expect(h['X-Memry-Capture']).toBe('1')
    expect(h['Content-Type']).toBe('application/json')
  })
})

describe('probeServer', () => {
  test('returns the first listening memry port', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === pingUrl(7849)) throw new Error('ECONNREFUSED')
      if (url === pingUrl(7850)) return ok({ app: 'memry', version: '1', paired: false })
      throw new Error('ECONNREFUSED')
    })
    const found = await probeServer(fetchFn as unknown as typeof fetch)
    expect(found?.port).toBe(7850)
    expect(found?.ping.paired).toBe(false)
  })
  test('returns null when nothing is listening', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await probeServer(fetchFn as unknown as typeof fetch)).toBeNull()
  })
})

describe('claimToken', () => {
  test('returns token on 200, null otherwise', async () => {
    const good = vi.fn(async () => ok({ token: 't0ken', port: 7849 }))
    expect(await claimToken(7849, good as unknown as typeof fetch)).toBe('t0ken')
    const closed = vi.fn(async () => new Response('{}', { status: 403 }))
    expect(await claimToken(7849, closed as unknown as typeof fetch)).toBeNull()
  })
})

describe('postCapture', () => {
  test('maps 200 to itemId', async () => {
    const fetchFn = vi.fn(async () => ok({ itemId: 'item-1' }))
    expect(await postCapture(7849, 't', draft, fetchFn as unknown as typeof fetch)).toEqual({
      ok: true,
      itemId: 'item-1'
    })
  })
  test('maps error status to error code', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid-capture' }), { status: 422 })
    )
    expect(await postCapture(7849, 't', draft, fetchFn as unknown as typeof fetch)).toEqual({
      ok: false,
      error: 'invalid-capture'
    })
  })
})

describe('pollUntil', () => {
  test('resolves on first non-null', async () => {
    let n = 0
    const r = await pollUntil(async () => (++n >= 3 ? 'done' : null), {
      intervalMs: 1,
      timeoutMs: 1000,
      sleep: async () => {}
    })
    expect(r).toBe('done')
  })
  test('returns null past the deadline', async () => {
    let t = 0
    const r = await pollUntil(async () => null, {
      intervalMs: 10,
      timeoutMs: 30,
      sleep: async () => {},
      now: () => (t += 20)
    })
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/extension test src/lib/capture-client.test.ts`
Expected: FAIL — `./capture-client` not found.

- [ ] **Step 4: Create `apps/extension/src/lib/capture-client.ts`**

```ts
import type { ArticleCapture } from '@memry/article-extract'

export const DEFAULT_PORT = 7849
export const PROBE_RANGE = 8
export const PROBE_PORTS = Array.from({ length: PROBE_RANGE }, (_, i) => DEFAULT_PORT + i)

const CAPTURE_HEADER = 'X-Memry-Capture'

export function pingUrl(port: number): string {
  return `http://127.0.0.1:${port}/ping`
}
export function claimUrl(port: number): string {
  return `http://127.0.0.1:${port}/pair/claim`
}
export function captureUrl(port: number): string {
  return `http://127.0.0.1:${port}/capture`
}

export interface PingResponse {
  app: 'memry'
  version: string
  paired: boolean
}

export function parsePing(data: unknown): PingResponse | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.app !== 'memry' || typeof d.paired !== 'boolean') return null
  return { app: 'memry', version: String(d.version ?? ''), paired: d.paired }
}

// Probe the loopback range. Returns the first live memry server, or null.
export async function probeServer(
  fetchFn: typeof fetch = fetch
): Promise<{ port: number; ping: PingResponse } | null> {
  for (const port of PROBE_PORTS) {
    try {
      const res = await fetchFn(pingUrl(port), { method: 'GET' })
      if (!res.ok) continue
      const ping = parsePing(await res.json())
      if (ping) return { port, ping }
    } catch {
      // port not listening — try the next one
    }
  }
  return null
}

// POST /pair/claim. The X-Memry-Capture header is required; Origin is attached
// by Chrome automatically. Returns the token on 200, null on 400/403/etc.
export async function claimToken(
  port: number,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await fetchFn(claimUrl(port), {
      method: 'POST',
      headers: { [CAPTURE_HEADER]: '1' }
    })
    if (!res.ok) return null
    const data = (await res.json()) as { token?: unknown }
    return typeof data.token === 'string' ? data.token : null
  } catch {
    return null
  }
}

export function captureHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    [CAPTURE_HEADER]: '1'
  }
}

export async function postCapture(
  port: number,
  token: string,
  capture: ArticleCapture,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; itemId: string } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(captureUrl(port), {
      method: 'POST',
      headers: captureHeaders(token),
      body: JSON.stringify(capture)
    })
    if (res.ok) {
      const data = (await res.json()) as { itemId?: unknown }
      return { ok: true, itemId: String(data.itemId ?? '') }
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown }
    return { ok: false, error: typeof data.error === 'string' ? data.error : `http-${res.status}` }
  } catch {
    return { ok: false, error: 'network' }
  }
}

// Call `attempt` until it returns a non-null value or the deadline passes.
export async function pollUntil<T>(
  attempt: () => Promise<T | null>,
  opts: {
    intervalMs: number
    timeoutMs: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
): Promise<T | null> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const deadline = now() + opts.timeoutMs
  for (;;) {
    const result = await attempt()
    if (result !== null) return result
    if (now() >= deadline) return null
    await sleep(opts.intervalMs)
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/extension test src/lib/capture-client.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/lib/messages.ts apps/extension/src/lib/capture-client.ts apps/extension/src/lib/capture-client.test.ts
git commit -m "feat(extension): capture client and message protocol"
```

---

## Task 4: Popup state reducer (`popup-state.ts`)

**Files:**

- Create: `apps/extension/src/lib/popup-state.ts`
- Test: `apps/extension/src/lib/popup-state.test.ts`

**Interfaces:**

- Produces: `PopupState`, `PopupAction`, `initialState`, `reducer(state, action)`, `selectPhase(state): Phase`, `mapError(code): string`. `Phase = 'extracting' | 'app-closed' | 'needs-pairing' | 'pairing' | 'ready' | 'saving' | 'saved' | 'error'`.
- Consumes: `ArticleCapture` from `@memry/article-extract`; `ConnectionState` from `./messages`.

- [ ] **Step 1: Write the failing test** `apps/extension/src/lib/popup-state.test.ts`

```ts
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

test('needs-pairing then pairing then ready', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  expect(selectPhase(s)).toBe('needs-pairing')
  s = reducer(s, { type: 'PAIR_START' })
  expect(selectPhase(s)).toBe('pairing')
  s = reducer(s, { type: 'PAIR_DONE', ok: true })
  expect(selectPhase(s)).toBe('ready')
})

test('failed pairing surfaces an error', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  s = reducer(s, { type: 'PAIR_START' })
  s = reducer(s, { type: 'PAIR_DONE', ok: false })
  expect(selectPhase(s)).toBe('error')
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/extension test src/lib/popup-state.test.ts`
Expected: FAIL — `./popup-state` not found.

- [ ] **Step 3: Create `apps/extension/src/lib/popup-state.ts`**

```ts
import type { ArticleCapture } from '@memry/article-extract'
import type { ConnectionState } from './messages'

export type Phase =
  | 'extracting'
  | 'app-closed'
  | 'needs-pairing'
  | 'pairing'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'error'

export interface PopupState {
  draft: ArticleCapture | null
  draftReady: boolean
  connection: 'unknown' | ConnectionState
  port: number | null
  action: 'idle' | 'pairing' | 'saving' | 'saved' | 'error'
  itemId: string | null
  errorMessage: string | null
}

export type PopupAction =
  | { type: 'DRAFT_READY'; draft: ArticleCapture | null }
  | { type: 'STATUS'; connection: ConnectionState; port: number | null }
  | { type: 'EDIT'; draft: ArticleCapture }
  | { type: 'PAIR_START' }
  | { type: 'PAIR_DONE'; ok: boolean }
  | { type: 'SAVE_START' }
  | { type: 'SAVE_DONE'; result: { ok: true; itemId: string } | { ok: false; error: string } }
  | { type: 'RETRY' }

export const initialState: PopupState = {
  draft: null,
  draftReady: false,
  connection: 'unknown',
  port: null,
  action: 'idle',
  itemId: null,
  errorMessage: null
}

export function mapError(code: string): string {
  switch (code) {
    case 'bad-token':
    case 'origin-not-allowed':
      return 'Pairing expired — pair with Memry again.'
    case 'invalid-capture':
      return "Memry couldn't read this capture."
    case 'payload-too-large':
      return 'This page is too large to capture.'
    case 'pair-timeout':
      return 'Pairing timed out. Try again.'
    default:
      return "Couldn't reach Memry. Try again."
  }
}

export function reducer(state: PopupState, action: PopupAction): PopupState {
  switch (action.type) {
    case 'DRAFT_READY':
      return { ...state, draft: action.draft, draftReady: true }
    case 'STATUS':
      return { ...state, connection: action.connection, port: action.port }
    case 'EDIT':
      return { ...state, draft: action.draft }
    case 'PAIR_START':
      return { ...state, action: 'pairing', errorMessage: null }
    case 'PAIR_DONE':
      return action.ok
        ? { ...state, action: 'idle', connection: 'ready' }
        : { ...state, action: 'error', errorMessage: mapError('pair-timeout') }
    case 'SAVE_START':
      return { ...state, action: 'saving', errorMessage: null }
    case 'SAVE_DONE':
      return action.result.ok
        ? { ...state, action: 'saved', itemId: action.result.itemId }
        : { ...state, action: 'error', errorMessage: mapError(action.result.error) }
    case 'RETRY':
      return { ...state, action: 'idle', errorMessage: null }
    default:
      return state
  }
}

export function selectPhase(state: PopupState): Phase {
  if (state.action === 'saved') return 'saved'
  if (state.action === 'error') return 'error'
  if (state.action === 'saving') return 'saving'
  if (state.action === 'pairing') return 'pairing'
  if (state.connection === 'unknown' || !state.draftReady) return 'extracting'
  if (state.connection === 'app-closed') return 'app-closed'
  if (state.connection === 'needs-pairing') return 'needs-pairing'
  return 'ready'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/extension test src/lib/popup-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/lib/popup-state.ts apps/extension/src/lib/popup-state.test.ts
git commit -m "feat(extension): popup state reducer"
```

---

## Task 5: Background service worker + content script

**Files:**

- Create: `apps/extension/src/entrypoints/background.ts`
- Create: `apps/extension/src/entrypoints/content.ts`

**Interfaces:**

- Consumes: `probeServer`, `claimToken`, `postCapture`, `pollUntil` from `lib/capture-client`; `extractFromDocument` from `@memry/article-extract/browser`; message types from `lib/messages`.
- Produces: background responds to `GET_STATUS` → `StatusResponse`, `START_PAIR` → `PairResponse`, `CAPTURE` → `CaptureResponse`. Content responds to `EXTRACT` → `ExtractResponse`.
- Note: these are browser-API glue (auto-imported `browser`, `defineBackground`, `defineContentScript`). They are exercised by the manual GUI QA gate, not unit tests — the testable logic they call is already covered in Tasks 2–4.

- [ ] **Step 1: Create `apps/extension/src/entrypoints/background.ts`**

```ts
import type { CaptureResponse, PairResponse, PopupMessage, StatusResponse } from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import { claimToken, pollUntil, postCapture, probeServer } from '@/lib/capture-client'

const TOKEN_KEY = 'memry:capture-token'

async function getToken(): Promise<string | null> {
  const r = await browser.storage.local.get(TOKEN_KEY)
  const v = r[TOKEN_KEY]
  return typeof v === 'string' ? v : null
}

async function setToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token })
}

async function getStatus(): Promise<StatusResponse> {
  const found = await probeServer()
  if (!found) return { connection: 'app-closed', port: null }
  const token = await getToken()
  if (found.ping.paired && token) return { connection: 'ready', port: found.port }
  return { connection: 'needs-pairing', port: found.port }
}

// The popup opens memry://pair (which prompts the desktop confirm + 120s claim
// window); we poll /pair/claim until it returns the token or the window lapses.
async function startPair(): Promise<PairResponse> {
  const found = await probeServer()
  if (!found) return { ok: false }
  const token = await pollUntil(() => claimToken(found.port), {
    intervalMs: 1500,
    timeoutMs: 120_000
  })
  if (!token) return { ok: false }
  await setToken(token)
  return { ok: true }
}

async function capture(body: ArticleCapture): Promise<CaptureResponse> {
  const found = await probeServer()
  if (!found) return { ok: false, error: 'network' }
  const token = await getToken()
  if (!token) return { ok: false, error: 'bad-token' }
  return postCapture(found.port, token, body)
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: PopupMessage) => {
    // Returning a Promise responds asynchronously (webextension-polyfill).
    switch (message.type) {
      case 'GET_STATUS':
        return getStatus()
      case 'START_PAIR':
        return startPair()
      case 'CAPTURE':
        return capture(message.capture)
      default:
        return undefined
    }
  })
})
```

- [ ] **Step 2: Create `apps/extension/src/entrypoints/content.ts`**

```ts
import type { ContentMessage, ExtractResponse } from '@/lib/messages'
import { extractFromDocument } from '@memry/article-extract/browser'

export default defineContentScript({
  // ponytail: declared on all web pages (standard clipper pattern); inert until messaged.
  matches: ['*://*/*'],
  main() {
    browser.runtime.onMessage.addListener((message: ContentMessage): Promise<ExtractResponse> => {
      if (message.type !== 'EXTRACT')
        return Promise.resolve({ ok: false, error: 'unknown-message' })
      try {
        return Promise.resolve({ ok: true, capture: extractFromDocument(document, location.href) })
      } catch (err) {
        return Promise.resolve({ ok: false, error: String(err) })
      }
    })
  }
})
```

- [ ] **Step 3: Verify typecheck + build**

Run:

```bash
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension build
```

Expected: no type errors; `.output/chrome-mv3/` contains `background.js`, a content script, and the popup. (`@/` resolves via WXT's generated paths after `wxt prepare`.)

- [ ] **Step 4: Commit**

```bash
git add apps/extension/src/entrypoints/background.ts apps/extension/src/entrypoints/content.ts
git commit -m "feat(extension): background pairing/capture router and content extractor"
```

---

## Task 6: Popup UI components + orchestration

**Files:**

- Create: `apps/extension/src/components/StatusStrip.tsx`
- Create: `apps/extension/src/components/EditableTitle.tsx`
- Create: `apps/extension/src/components/PropertyRows.tsx`
- Create: `apps/extension/src/components/TagEditor.tsx`
- Create: `apps/extension/src/components/BodyPreview.tsx`
- Create: `apps/extension/src/components/ModeSegmented.tsx`
- Create: `apps/extension/src/components/PrimaryButton.tsx`
- Modify: `apps/extension/src/entrypoints/popup/App.tsx` (replace shell with full orchestration)

**Interfaces:**

- Consumes: reducer + `selectPhase` from `lib/popup-state`; message types from `lib/messages`; `ArticleCapture` from `@memry/article-extract`; `marked`, `dompurify`.
- Produces: the rendered popup. Visual surface — verified by manual GUI QA, not unit tests.

- [ ] **Step 1: Create `apps/extension/src/components/StatusStrip.tsx`**

```tsx
import type { Phase } from '@/lib/popup-state'

const LABEL: Partial<Record<Phase, string>> = {
  'app-closed': "Memry isn't running",
  'needs-pairing': 'Not paired',
  ready: 'Connected',
  pairing: 'Pairing…',
  saving: 'Saving…',
  saved: 'Saved'
}

export function StatusStrip({ phase }: { phase: Phase }) {
  const connected = phase === 'ready' || phase === 'saving' || phase === 'saved'
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <span className="text-[13px] font-semibold text-foreground">Memry</span>
      <span className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: connected ? 'var(--accent-green)' : 'var(--text-tertiary)' }}
        />
        {LABEL[phase] ?? ''}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Create `apps/extension/src/components/EditableTitle.tsx`**

```tsx
export function EditableTitle({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Untitled"
      className="w-full bg-transparent font-serif text-[18px] font-medium leading-snug text-foreground outline-none placeholder:text-text-tertiary"
    />
  )
}
```

- [ ] **Step 3: Create `apps/extension/src/components/PropertyRows.tsx`**

All rows editable (per the locked design). `source`, `published`, `created`, `description` are single text inputs; `author` is a comma-joined text input mapped to/from `string[]`.

```tsx
import type { ArticleCapture } from '@memry/article-extract'

type Props = ArticleCapture['properties']

function Row({
  label,
  value,
  onChange,
  disabled
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center py-1.5">
      <span className="w-24 shrink-0 truncate text-[13px] leading-4 text-text-tertiary">
        {label}
      </span>
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
      />
    </div>
  )
}

export function PropertyRows({
  properties,
  onChange,
  disabled
}: {
  properties: Props
  onChange: (next: Props) => void
  disabled?: boolean
}) {
  const set = (patch: Partial<Props>) => onChange({ ...properties, ...patch })
  return (
    <div className="border-t border-border/60 pt-2">
      <div className="pb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-text-tertiary">
        Properties
      </div>
      <Row
        label="source"
        value={properties.source}
        disabled={disabled}
        onChange={(v) => set({ source: v })}
      />
      <Row
        label="author"
        value={(properties.author ?? []).join(', ')}
        disabled={disabled}
        onChange={(v) =>
          set({
            author: v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          })
        }
      />
      <Row
        label="published"
        value={properties.published ?? ''}
        disabled={disabled}
        onChange={(v) => set({ published: v })}
      />
      <Row
        label="created"
        value={properties.created}
        disabled={disabled}
        onChange={(v) => set({ created: v })}
      />
      <Row
        label="description"
        value={properties.description ?? ''}
        disabled={disabled}
        onChange={(v) => set({ description: v })}
      />
    </div>
  )
}
```

- [ ] **Step 4: Create `apps/extension/src/components/TagEditor.tsx`**

```tsx
import { useState } from 'react'

export function TagEditor({
  tags,
  onChange,
  disabled
}: {
  tags: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const t = draft.trim()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1.5">
      <span className="w-24 shrink-0 text-[13px] leading-4 text-text-tertiary">tags</span>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          disabled={disabled}
          onClick={() => onChange(tags.filter((x) => x !== tag))}
          className="inline-flex items-center gap-1 rounded-full bg-foreground/10 px-2.5 py-1 text-[12px]/4 font-medium text-foreground"
        >
          {tag}
          <span className="text-text-tertiary">×</span>
        </button>
      ))}
      <input
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
        }}
        onBlur={add}
        placeholder="+ add"
        className="w-16 bg-transparent text-[12px] text-foreground outline-none placeholder:text-text-tertiary"
      />
    </div>
  )
}
```

- [ ] **Step 5: Create `apps/extension/src/components/BodyPreview.tsx`**

```tsx
import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function BodyPreview({ markdown }: { markdown: string }) {
  // Read-only preview of arbitrary web content — sanitize before injecting.
  const html = DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string)
  return (
    <div
      className="max-h-40 overflow-y-auto border-t border-border pt-2 font-serif text-[13px] leading-relaxed text-text-secondary [&_a]:underline [&_h1]:mt-2 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:font-semibold [&_p]:mb-2"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
```

- [ ] **Step 6: Create `apps/extension/src/components/ModeSegmented.tsx`**

```tsx
const MODES = [
  { id: 'article', label: 'Article', enabled: true },
  { id: 'selection', label: 'Selection', enabled: false },
  { id: 'shot', label: 'Shot', enabled: false }
] as const

export function ModeSegmented() {
  return (
    <div className="flex gap-1 rounded-md bg-surface p-1">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={!m.enabled}
          className={
            'flex-1 rounded px-2 py-1 text-[12px] font-medium transition-colors ' +
            (m.id === 'article' ? 'bg-background text-foreground shadow-sm' : 'text-text-tertiary')
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 7: Create `apps/extension/src/components/PrimaryButton.tsx`**

```tsx
export function PrimaryButton({
  label,
  onClick,
  disabled
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-md bg-primary px-4 py-2.5 text-[14px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {label}
    </button>
  )
}
```

- [ ] **Step 8: Replace `apps/extension/src/entrypoints/popup/App.tsx` with full orchestration**

```tsx
import { useEffect, useReducer } from 'react'
import type { ArticleCapture } from '@memry/article-extract'
import type { CaptureResponse, ExtractResponse, PairResponse, StatusResponse } from '@/lib/messages'
import { initialState, reducer, selectPhase } from '@/lib/popup-state'
import { StatusStrip } from '@/components/StatusStrip'
import { EditableTitle } from '@/components/EditableTitle'
import { PropertyRows } from '@/components/PropertyRows'
import { TagEditor } from '@/components/TagEditor'
import { BodyPreview } from '@/components/BodyPreview'
import { ModeSegmented } from '@/components/ModeSegmented'
import { PrimaryButton } from '@/components/PrimaryButton'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const phase = selectPhase(state)

  useEffect(() => {
    browser.runtime
      .sendMessage({ type: 'GET_STATUS' })
      .then((r: StatusResponse) =>
        dispatch({ type: 'STATUS', connection: r.connection, port: r.port })
      )
      .catch(() => dispatch({ type: 'STATUS', connection: 'app-closed', port: null }))

    browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return dispatch({ type: 'DRAFT_READY', draft: null })
      browser.tabs
        .sendMessage(tab.id, { type: 'EXTRACT' })
        .then((r: ExtractResponse) =>
          dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : null })
        )
        .catch(() => dispatch({ type: 'DRAFT_READY', draft: null }))
    })
  }, [])

  const setDraft = (draft: ArticleCapture) => dispatch({ type: 'EDIT', draft })

  const onPair = () => {
    dispatch({ type: 'PAIR_START' })
    window.open('memry://pair') // desktop shows confirm + opens the 120s claim window
    browser.runtime
      .sendMessage({ type: 'START_PAIR' })
      .then((r: PairResponse) => dispatch({ type: 'PAIR_DONE', ok: r.ok }))
      .catch(() => dispatch({ type: 'PAIR_DONE', ok: false }))
  }

  const onSave = () => {
    if (!state.draft) return
    dispatch({ type: 'SAVE_START' })
    browser.runtime
      .sendMessage({ type: 'CAPTURE', capture: state.draft })
      .then((r: CaptureResponse) => dispatch({ type: 'SAVE_DONE', result: r }))
      .catch(() => dispatch({ type: 'SAVE_DONE', result: { ok: false, error: 'network' } }))
  }

  const draft = state.draft
  const editable = phase === 'ready' || phase === 'error'

  return (
    <div className="flex flex-col bg-background font-sans text-foreground">
      <StatusStrip phase={phase} />

      {phase === 'extracting' && (
        <div className="px-4 py-8 text-center text-[13px] text-text-tertiary">
          Reading this page…
        </div>
      )}

      {phase !== 'extracting' && phase !== 'saved' && (
        <div
          className={
            'flex flex-col gap-2 px-4 py-3 ' +
            (phase === 'ready' || phase === 'error' ? '' : 'opacity-60')
          }
        >
          {draft && (
            <>
              <EditableTitle
                value={draft.properties.title}
                disabled={!editable}
                onChange={(title) =>
                  setDraft({ ...draft, properties: { ...draft.properties, title } })
                }
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
                onChange={(tags) =>
                  setDraft({ ...draft, properties: { ...draft.properties, tags } })
                }
              />
              <ModeSegmented />
              <BodyPreview markdown={draft.contentMarkdown} />
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        {phase === 'error' && state.errorMessage && (
          <p className="text-[12px] text-text-secondary">{state.errorMessage}</p>
        )}
        {phase === 'app-closed' && (
          <p className="text-[12px] text-text-secondary">Open Memry to capture this page.</p>
        )}
        {phase === 'saved' && (
          <p className="py-2 text-center text-[14px] font-medium text-foreground">
            Added to inbox ✓
          </p>
        )}

        {phase === 'needs-pairing' && <PrimaryButton label="Pair with Memry" onClick={onPair} />}
        {phase === 'pairing' && <PrimaryButton label="Confirm pairing in Memry…" disabled />}
        {phase === 'ready' && (
          <PrimaryButton label="Add to Memry" onClick={onSave} disabled={!draft} />
        )}
        {phase === 'saving' && <PrimaryButton label="Adding…" disabled />}
        {phase === 'app-closed' && <PrimaryButton label="Add to Memry" disabled />}
        {phase === 'error' && (
          <PrimaryButton label="Try again" onClick={() => dispatch({ type: 'RETRY' })} />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 9: Verify typecheck, lint, build**

Run:

```bash
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
pnpm --filter @memry/extension test
pnpm --filter @memry/extension build
```

Expected: all green; `.output/chrome-mv3/` updated.

- [ ] **Step 10: Commit**

```bash
git add apps/extension/src/components apps/extension/src/entrypoints/popup/App.tsx
git commit -m "feat(extension): review-then-save popup UI"
```

---

## Task 7: README, manual QA checklist, whole-branch verification

**Files:**

- Create: `apps/extension/README.md`

**Interfaces:** none (docs + verification).

- [ ] **Step 1: Create `apps/extension/README.md`**

````markdown
# @memry/extension — Memry Web Clipper (Chromium MV3)

Captures the current page as a readable article and saves it to the Memry
desktop app via its localhost capture server. Built with [WXT](https://wxt.dev).

## Develop

```bash
pnpm --filter @memry/extension dev      # WXT dev server + auto-reload
pnpm --filter @memry/extension build    # production build → .output/chrome-mv3
pnpm --filter @memry/extension test     # unit tests (vitest)
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
```

## Load unpacked in Chrome

1. `pnpm --filter @memry/extension build`
2. Chrome → `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select `apps/extension/.output/chrome-mv3`.
4. Keep the load path stable so the extension ID (and pairing) survives reloads.

## Manual QA (the Phase-3 acceptance gate — human-required)

Run the desktop app first: `pnpm dev`.

1. **App-closed:** quit the desktop app, open the popup on any article → status
   "Memry isn't running", "Add to Memry" disabled.
2. **Pairing:** start the desktop app. Open the popup → "Not paired" + "Pair with
   Memry". Click it → desktop shows the `memry://pair` confirm dialog → click
   Pair. Popup flips to "Connected" within a couple of seconds.
3. **Capture:** open the popup on a real article → properties + body fill in.
   Edit the title/tags → "Add to Memry" → "Added to inbox ✓". Confirm a new
   link item appears in the desktop inbox with the article body + properties.
4. **Failed extraction:** open the popup on a non-article page (e.g. a web app)
   → "Couldn't read this page — saving the link and title." Saving still works.
5. **Origin header check (the known risk):** if `/capture` returns 401
   `origin-not-allowed`/`bad-token` despite a successful pair, Chrome is not
   attaching `Origin: chrome-extension://<id>` on the background fetch — verify
   in DevTools → background service worker → Network.
````

- [ ] **Step 2: Run the full extension gate**

Run:

```bash
pnpm --filter @memry/extension test
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
pnpm --filter @memry/extension build
pnpm --filter @memry/article-extract typecheck
```

Expected: all green.

- [ ] **Step 3: Confirm the extension is excluded from the desktop build**

Run:

```bash
rtk grep -rn "@memry/extension" apps/desktop || echo "no desktop import — excluded OK"
```

Expected: no matches (so electron-builder/electron.vite never bundle it).

- [ ] **Step 4: Whole-branch review**

Use `superpowers:requesting-code-review` for the full branch diff against `feat/link-capture-loopback`. Address findings.

- [ ] **Step 5: Commit docs**

```bash
git add apps/extension/README.md
git commit -m "docs(extension): load-unpacked + manual QA checklist"
```

- [ ] **Step 6: Manual GUI QA**

Execute `apps/extension/README.md` → "Manual QA" against a running `pnpm dev`. This is the human-required acceptance gate; report the result before opening the PR as ready.

---

## Self-Review Notes

- **Spec coverage:** Path B content-script extraction → Task 2 + 5; background pairing/capture → Task 3 + 5; review-then-save popup with editable properties/tags + read-only body + 4 states + segmented control (Article only) → Task 4 + 6; WXT package excluded from desktop → Task 1 + 7 Step 3; design-token reuse → Task 1 (`tokens.css`) + Task 6 components.
- **Phase boundaries respected:** no queue/retry/badge, no keyboard command, no settings UI, no "Add and open note", Selection/Shot disabled — all deferred to Phase 4/5.
- **Type consistency:** `ArticleCapture` (from `@memry/article-extract`) is the single body type across content → background → popup; `ConnectionState`/`StatusResponse`/`CaptureResponse`/`PairResponse` defined once in `messages.ts` and consumed unchanged; reducer action/phase names match between `popup-state.ts` and `App.tsx`.
- **Known runtime risk (QA, not code):** Chrome must attach `Origin: chrome-extension://<id>` on the background's loopback fetches — covered by `host_permissions` and is the intended anti-rebinding seam, but is the most likely failure point; called out in the QA checklist.
