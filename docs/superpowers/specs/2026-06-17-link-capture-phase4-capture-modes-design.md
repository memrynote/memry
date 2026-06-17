# Link Capture Phase 4 — Selection + Screenshot capture modes

Date: 2026-06-17
Status: Approved (design)
Builds on: `2026-06-17-link-capture-defuddle-design.md` (§Path B, §Popup UI, §Phasing).
Predecessors merged to main: Phase 1 (paste→article), Phase 2 (loopback server), Phase 3 + 3.1 (extension MVP + in-app pairing) via PR #587.

## Goal

Wire the two disabled popup segments — **Selection** and **Shot** — into working capture modes.
Selection clips the user's current text selection as a markdown note. Shot captures a
full-page screenshot and files it as an image note. Both land in the same inbox via the same
`/capture` → `ingestArticleCapture` convergence point the paste and article paths already use.

## Non-goals (Phase 5)

Offline queue/retry + toolbar badge, keyboard command, settings UI (token rotate / unpair /
port), "Add and open note" split action.

## What already exists (verified against main)

- **Extension** (`apps/extension`, WXT MV3):
  - `src/entrypoints/content.ts` — listens for `EXTRACT`, runs `extractFromDocument(document, url)`
    from `@memry/article-extract/browser`, which is `new Defuddle(doc, { markdown: true }).parse()`
    mapped to `ArticleCapture`.
  - `src/entrypoints/background.ts` — owns the token + all loopback network; message switch
    (`GET_STATUS`, `PAIR`, `CAPTURE`, `WAIT_FOR_SERVER`).
  - `src/entrypoints/popup/App.tsx` + `src/components/*` — popup UI; `ModeSegmented` renders
    Article (enabled) + Selection/Shot (disabled placeholders).
  - `src/lib/messages.ts` — `PopupMessage` / `ContentMessage` / `ExtractResponse` unions.
  - `src/lib/capture-client.ts` — URL/header builders + `postCapture` + `pollUntil`. Mode-agnostic.
  - `src/lib/popup-state.ts` — reducer (`Phase`, `PopupAction`).
  - `src/lib/render-markdown.ts` — `renderMarkdown(md)` = marked + DOMPurify (for body preview).
  - Deps already present: `@memry/article-extract` (defuddle), `marked`, `dompurify`. jsdom is a devDep.
  - Manifest perms: `['storage', 'activeTab']`, `host_permissions: ['http://127.0.0.1/*']`.
- **Desktop capture** (`apps/desktop/src/main/capture`): `server.ts` routes `/ping`, `/pair/claim`,
  `/pair/request`, `/capture`. `/capture` reads body (25 MB cap → 413), `ArticleCaptureSchema.safeParse`,
  then `ingestArticleCapture(parsed.data, 'browser-extension')`. `server.test.ts` mocks `./pairing`,
  `electron`, and `../inbox/ingest`.
- **Ingest** (`apps/desktop/src/main/inbox/ingest.ts`): `ingestArticleCapture(input, source)`.
  Create-path generates `id` BEFORE `insertItemWithTags`, calls `downloadHero(id, heroImage)`.
  Enrich-path keys off `input.itemId` or URL-dedup. `force: true` bypasses URL-dedup.
- **Inbox attachments** (`apps/desktop/src/main/inbox/attachments.ts`): `storeInboxAttachment(itemId,
data: Buffer, filename, mimeType) → { success, path, ... }` where `path` is vault-relative
  `attachments/inbox/{itemId}/{prefix}-{name}.{ext}`. (Note items use a different `saveAttachment`
  returning `memry-file://` URLs — do NOT use that for inbox.)
- **Contract** (`packages/contracts/src/capture-api.ts`, subpath `@memry/contracts/capture-api`):
  `ArticleCaptureSchema` already has `mode: z.enum(['article','selection','screenshot'])`, plus
  optional `tags` and `force`. It does NOT yet carry a screenshot payload.

## Design

### 1. Selection mode — extension-only, desktop unchanged

Selection produces a ready-made `contentMarkdown` in the extension, exactly like article mode, so
the desktop path needs zero changes (it already accepts `mode:'selection'`).

- **Content script** (`content.ts`) gains a `GRAB_SELECTION` handler:
  - `const sel = window.getSelection()`. If empty/collapsed → return `{ ok:false, error:'no-selection' }`.
  - Clone the selected range(s) into a detached document body, run the same defuddle path as article
    (`defuddle({ markdown: true })`) over that fragment → `contentMarkdown`.
  - **Fallback**: if defuddle yields empty markdown, use `sel.toString()` as plain text. `// ponytail:`
    upgrade path = swap to a dedicated fragment converter if fidelity complaints arise.
  - Build the `ArticleCapture`: `mode:'selection'`, `url`/`properties.source` = `location.href`,
    `properties.title` = `document.title`, `properties.created` = now, `tags: ['clippings']`,
    `excerpt` = a trimmed prefix of the selection text, `extractionStatus:'full'`, `force: true`.
- **Conversion location** decision: reuse defuddle (already the engine for article mode). No new dep,
  no new converter, no desktop change.
- **Dedup**: `force: true` — each selection is a distinct inbox item (a page can be clipped twice).
- **Popup**: enable the Selection segment. Selecting it sends `GRAB_SELECTION` to the active tab's
  content script and renders the result as a **read-only body preview** via `renderMarkdown`. No
  selection → empty-state hint ("Select text on the page, then pick Selection again"); "Add to
  Memry" disabled. Re-clicking the Selection segment re-runs the grab (the documented retry path —
  select text, then pick Selection again), unlike Article which is a pure no-op on re-click. The
  title/properties rows stay editable, consistent with article mode.

### 2. Screenshot mode — full-page scroll + stitch

The background orchestrates; the content script scrolls; the background captures and stitches.
`captureVisibleTab` is privileged and cannot run in a content script, so the loop round-trips.

Flow:

1. Popup → background `GRAB_SCREENSHOT`.
2. Background → content `GET_PAGE_METRICS` → `{ scrollHeight, innerHeight, innerWidth, dpr }`
   (clamp `scrollHeight` to a max of ~15000 css-px to stay under the 25 MB cap — `// ponytail:`).
3. Loop `y = 0 … scrollHeight` by `innerHeight` steps:
   - content `SCROLL_TO { y }` → background waits ~350 ms settle → background
     `chrome.tabs.captureVisibleTab(windowId, { format: 'png' })` → collect `{ dataUrl, y }`.
   - Throttle so captures stay within `captureVisibleTab`'s ~2/sec limit.
   - Emit progress (`n/total`) back to the popup.
4. Restore the page's original scroll position.
5. **Stitch** in the background via `OffscreenCanvas` sized `innerWidth*dpr × clampedHeight*dpr`:
   `createImageBitmap` each slice, draw at `y*dpr`. The final slice's capture shows the bottom
   viewport (overlapping the previous slice) — draw it at `(scrollHeight - innerHeight)*dpr` and
   the geometry naturally clips. Export `canvas.convertToBlob({ type:'image/png' })` → data URL.
6. Background returns the stitched data URL to the popup.

The slice-geometry math (per-slice draw offset + final-slice clamp) is extracted into a **pure
helper** `planStitch({ scrollHeight, innerHeight, dpr })` so it gets a unit test independent of the
browser canvas.

Known limits, each `// ponytail:`-commented with an upgrade path:

- Sticky / `position:fixed` headers repeat in every slice (would need per-slice hide/restore).
- Lazy-loaded images may still be loading when a slice is captured (350 ms settle is best-effort).
- Total height capped (~15000 css-px) to keep the PNG under the `/capture` 25 MB cap; very tall
  pages are truncated rather than failing with a 413.

**Popup**: enable the Shot segment. Selecting it shows a `Capturing page… (n/total)` progress
state, then the stitched **image miniature** preview. "Add to Memry" sends it.

**Permissions**: none added. `activeTab` (granted when the popup opens) authorizes
`captureVisibleTab` for the active tab from the background while the popup is open; scrolling and
`getSelection` need no permission. `host_permissions` unchanged.

### 3. Desktop — screenshot ingest

Selection needs nothing here. Screenshot adds one schema field + a decode-and-embed step.

- **Contract** (`@memry/contracts/capture-api`): add `screenshotDataUrl: z.string().optional()` to
  `ArticleCaptureSchema`. Import via the subpath, never the barrel (contracts `index.test.ts` forbids
  barrel named exports).
- **Pure helper** `parseDataUrl(s) → { mime, ext, buffer } | null` (new small module, e.g. under
  `apps/desktop/src/main/inbox/` or a shared util). Parses `data:<mime>;base64,<payload>`; maps mime
  → ext (`image/jpeg`→`jpg`, `image/svg+xml`→`svg`, else subtype). Unit-tested — it's a parser.
- **`ingestArticleCapture`** create-path: after `id` is generated, if `input.screenshotDataUrl`:
  `parseDataUrl` → `storeInboxAttachment(id, buffer, 'screenshot.<ext>', mime)` → on success set
  `content = ![screenshot](<result.path>)` (the image is the body) and `thumbnailPath = result.path`.
  Article/selection paths untouched. The extension sends `contentMarkdown: ''` + `force: true` for
  screenshot (each shot is a distinct item, same as selection); the desktop builds the real body.
- **`server.test.ts`**: add a screenshot-body case — valid screenshot payload (`mode:'screenshot'`,
  `screenshotDataUrl`, empty `contentMarkdown`) → `ingestArticleCapture` called with
  `expect.objectContaining({ mode:'screenshot', screenshotDataUrl: expect.any(String) })`. The
  decode/embed is covered by the `parseDataUrl` unit test; the DB-bound embed is manual QA.

### 4. Messages / state

- `messages.ts`:
  - `ContentMessage` += `{ type:'GRAB_SELECTION' }`, `{ type:'GET_PAGE_METRICS' }`,
    `{ type:'SCROLL_TO'; y:number }`.
  - `PopupMessage` += `{ type:'GRAB_SCREENSHOT' }`.
  - Response types: `SelectionResponse` (`ArticleCapture | error`), `PageMetrics`,
    `ScreenshotResponse` (`{ ok:true; dataUrl:string } | error`). Progress can ride a
    `runtime.connect` port or repeated messages — design leaves the simplest of the two to the plan.
- `popup-state.ts`: add `mode: 'article'|'selection'|'screenshot'` to state + `SET_MODE` action; a
  capturing/progress sub-state for screenshot (`capturing` phase carrying `{ done, total }`).
  Reducer unit tests for `SET_MODE` + the capturing transitions.

### 5. Tests / verification gate

- **Pure logic, unit-tested**: `parseDataUrl`, reducer `SET_MODE`/capturing, `planStitch` geometry.
- **Manual QA**: WXT content/background entrypoints, React popup components, the live scroll+stitch
  loop, and the DB-bound screenshot embed.
- **Gate**: `pnpm --filter @memry/extension test|typecheck|lint|build`; desktop
  `pnpm --filter @memry/desktop test:main capture/server.test.ts` + `typecheck:node`.

## Acceptance — human-required GUI QA

Load the unpacked extension in Chrome, run `pnpm dev`. Confirm:

- Selecting text + Selection mode + Add → a text note in the inbox with the selection as markdown.
- Shot mode → progress → stitched preview + Add → an image note in the inbox referencing the saved
  screenshot attachment.
- Article mode + the Phase 3.1 in-app pairing flow are unchanged.

## File touch list (estimate)

Extension: `messages.ts`, `popup-state.ts` (+test), `content.ts`, `background.ts`,
`popup/App.tsx`, `components/ModeSegmented.tsx` (+ a small selection-body / screenshot-preview
component), a `stitch.ts` pure helper (+test).
Desktop: `packages/contracts/src/capture-api.ts`, `apps/desktop/src/main/inbox/ingest.ts`, a
`parse-data-url.ts` helper (+test), `apps/desktop/src/main/capture/server.test.ts`.
No new dependencies. No new permissions.
