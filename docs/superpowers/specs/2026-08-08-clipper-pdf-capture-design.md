# Web clipper captures the actual PDF when the tab is a PDF

Issue: [#1160](https://github.com/memrynote/memry/issues/1160)
Date: 2026-08-08

## Problem

When the active tab is a PDF — a direct `.pdf` URL rendered by Chrome's or Firefox's
built-in viewer — clipping produces nothing useful. Content scripts are not injected
into either browser's PDF viewer, so the popup's `EXTRACT` message rejects and the user
sees "Couldn't read this page". The `⌘⇧S` shortcut shows an error badge.

Reported by a user over email on 2026-08-05 against `v2026-07-19.2`.

The storage and reading ends already exist on the desktop side: the inbox has a `pdf`
item type, `storeInboxAttachment` accepts `application/pdf` up to `MAX_INBOX_FILE_SIZE`
(50 MB), `fileBinaryToFolder` files binary items into folders, and the app has a real
PDF viewer. The missing piece is entirely the capture end.

## Scope

In scope: **top-level PDF tabs** — the tab's own URL is the PDF, rendered by the
browser's built-in viewer.

Out of scope, deliberately: PDFs embedded in a normal page via `<embed>` or `<iframe>`.
There the content script _does_ run and extraction "succeeds" with junk, so detection,
disambiguation between several embeds, and a picker UI would all be new surface. That
is a separate problem and belongs in a separate issue.

Also out of scope: any PDF the browser itself cannot fetch a second time — PDFs served
in response to a POST, one-time signed URLs, and `blob:` URLs. These fail with a clear
message rather than silently saving the wrong bytes.

## Design

### 1. Detection (extension, popup mount)

The popup already queries the active tab and sends `EXTRACT` to the content script.
Today a rejection dispatches `DRAFT_READY` with `draft: null`.

New rule: when `EXTRACT` fails **and** the tab URL's protocol is `http:` or `https:`,
build a _provisional_ PDF draft from tab metadata alone — no bytes yet, because fetching
them needs a host permission that can only be requested from a user gesture.

```ts
{
  url: tab.url,
  mode: 'pdf',
  contentMarkdown: '',
  excerpt: '',
  extractionStatus: 'full',
  force: true,
  properties: {
    title: <filename from URL pathname, extension stripped> || tab.title || tab.url,
    source: tab.url,
    created: <now ISO>
  },
  tags: ['clippings']
}
```

Any other `EXTRACT` failure (`chrome://`, the Web Store, `file://`) keeps today's
"Couldn't read this page" empty state.

On `http(s)` pages content scripts effectively always inject, so "`EXTRACT` failed on
`http(s)`" is, in practice, "the browser is displaying a binary resource". Labelling that
state "PDF" is right nearly always, and the magic-byte check in step 2 catches the rest
loudly.

`tab.url` and `tab.title` are readable because clicking the browser action grants
`activeTab` for that tab. No new permission is needed for detection.

### 2. Permission and fetch (on Send)

`onSend` currently calls `ensureHostPermission()` for the loopback origin. For a PDF
draft it instead makes **one** combined request:

```ts
permissions.request({ origins: [LOOPBACK_ORIGIN, originPatternOf(draft.url)] })
```

One call, one gesture. Splitting it into two `await`-separated requests would lose
gesture attribution on Firefox, which is stricter than Chrome about this.

The fetch itself belongs in the background service worker: it outlives the popup, it
already owns the comparable `grabScreenshot` operation, and it is not subject to page CSP.
The popup sends `{ type: 'FETCH_PDF', url }` and the background performs:

1. `fetch(url, { credentials: 'include' })` — cookies ride along, so most auth-gated
   PDFs work with no extra handling.
2. Non-`ok` response → `{ ok: false, error: 'pdf-fetch-failed' }`.
3. Read `arrayBuffer()`; require the first five bytes to be `%PDF-`. A login page
   returned as `200 text/html` fails here with `not-a-pdf` instead of being stored as a
   corrupt "PDF". This is the auth-gated failure mode the issue asks about, made loud.
4. `byteLength > 16 MB` → `{ ok: false, error: 'pdf-too-large' }` (see §4).
5. Encode with the existing `bytesToDataUrl(bytes, 'application/pdf')` — already chunked
   to avoid blowing the call stack on large inputs.
6. Filename from `Content-Disposition` when present, else the URL pathname's last
   segment, else `document.pdf`.

The popup merges `pdfDataUrl` / `pdfFilename` into the draft and sends the normal
`CAPTURE` message. Everything downstream of that is the existing path.

### 3. Contract change

`packages/contracts/src/capture-api.ts`, additive only:

- `mode` enum gains `'pdf'` → `z.enum(['article', 'selection', 'screenshot', 'pdf'])`
- `pdfDataUrl: z.string().optional()`
- `pdfFilename: z.string().optional()`

Matching additions to `ArticleCapture` in `packages/article-extract/src/map.ts`.

Backward compatibility:

- An **older extension against a newer desktop** is unaffected — the new fields are
  optional and the existing modes are untouched.
- A **newer extension against an older desktop** gets a 422 `invalid-capture`, because
  the old `ArticleCaptureSchema` rejects `mode: 'pdf'`.

Therefore the desktop change must ship **before or with** the extension update. Chrome
Web Store and AMO review lag makes this the natural ordering, but it is a real
constraint and must not be reversed.

### 4. Size cap

The desktop `/capture` handler caps request bodies at 25 MB (`server.ts:38`). Base64
inflates bytes by ~4/3, and the JSON envelope carries title, tags, and properties on top.
A raw cap of **16 MB** leaves comfortable headroom and covers the overwhelming majority
of papers and datasheets.

The cap is enforced **client-side, before encoding**, so an oversized PDF produces a
clear "PDF is too large to clip" message rather than a 413 after the extension has
already spent time and memory base64-encoding it.

This is below `MAX_INBOX_FILE_SIZE` (50 MB), which continues to govern the drag-and-drop
path. The two limits differ because the transports differ; raising `/capture`'s body cap
is a change to a shared DoS guard and is not in scope here.

### 5. Desktop ingest

`apps/desktop/src/main/inbox/ingest.ts` gains a `pdfDataUrl` block mirroring the existing
`screenshotDataUrl` block directly above it:

```ts
if (input.pdfDataUrl) {
  const parsed = parseDataUrl(input.pdfDataUrl)
  if (parsed && parsed.mime === 'application/pdf') {
    const stored = await storeInboxAttachment(
      id,
      parsed.buffer,
      input.pdfFilename ?? 'document.pdf',
      'application/pdf'
    )
    // on success: itemType 'pdf', content null, attachmentPath, pdf metadata
    // on failure: log.warn and fall through to a plain link item
  }
}
```

The resulting row:

| Column           | Value                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| `type`           | `'pdf'`                                                                          |
| `title`          | `input.properties.title` (filename, extension already stripped by the extension) |
| `content`        | `null`                                                                           |
| `attachmentPath` | relative vault path from `storeInboxAttachment`                                  |
| `sourceUrl`      | the PDF URL                                                                      |
| `metadata`       | `{ originalFilename, fileSize, mimeType, url, properties }`                      |

The `{ originalFilename, fileSize, mimeType }` triple is copied deliberately from
`captureImageItem` (`domain.ts:299`) — the drag-and-drop path that already produces `pdf`
items. Matching it means the inbox list rendering, the PDF viewer, and
`fileBinaryToFolder` work unchanged; no renderer or filing code is touched by this
feature.

`ingest.ts` does not currently set `attachmentPath` on the insert at all, so that field
is threaded through for the first time.

`force: true` on the draft skips `findDuplicateByUrl`. This matters: the duplicate branch
routes into the `input.itemId` enrichment path, which only updates `content` and
`metadata` and would silently discard the PDF bytes. Screenshot mode already sets `force`
for the same structural reason.

If storage fails — over `MAX_INBOX_FILE_SIZE`, no vault open, disk error — the item is
still created as a plain link so the clip is never lost outright, and the failure is
logged.

### 6. No offline queueing for PDFs

Chrome's `storage.local` quota is 10 MB without the `unlimitedStorage` permission. A
16 MB PDF encoded as base64 is ~21 MB and would blow it.

`captureOrQueue` therefore returns PDF failures directly instead of enqueuing them:

```ts
if (body.pdfDataUrl) return capture(body) // never enqueue
```

The app-closed case is already covered by the existing `onLaunchAndAdd` flow, which opens
`memry://open` and waits up to 20 s for the server. A genuine failure after that shows
"Try again" — the tab is still open, so retrying costs one click.

### 7. Keyboard shortcut

The background `capture-page` command handler cannot call `permissions.request` — there
is no user gesture in a service worker. On `EXTRACT` failure it checks
`permissions.contains({ origins: [originPatternOf(tab.url)] })`:

- granted → build and send the PDF capture, same helper as the popup
- not granted → today's `!` error badge

So `⌘⇧S` works on PDFs from any origin the user has already approved through the popup,
and degrades to current behaviour otherwise.

### 8. Manifest

`apps/extension/wxt.config.ts` gains:

```ts
optional_host_permissions: ['*://*/*']
```

Optional permissions are not shown at install time and are prompted per-origin at request
time, so this adds no new install warning — important for a privacy-first clipper. It is
still a manifest change, so it triggers a Chrome Web Store and AMO re-review; that is a
release-planning cost, not a technical one.

Portability: `optional_host_permissions` is supported by Firefox MV3 from 128, and the
manifest already pins `strict_min_version: '140.0'`. `permissions.request` from a popup
gesture and `fetch` with `credentials: 'include'` behave the same on Chrome, Edge, and
Firefox. Nothing Chrome-specific is used — no `chrome.pdfViewerPrivate`, no `downloads`
permission.

### 9. Error messages

New codes in `mapError` (`popup-state.ts:53`):

| Code                           | Message                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `pdf-fetch-failed`             | "Couldn't download this PDF. Open it directly, then try again." |
| `not-a-pdf`                    | "This isn't a PDF — nothing to save."                           |
| `pdf-too-large`                | "This PDF is too large to clip (limit 16 MB)."                  |
| `permission-denied` (existing) | extended to cover the site-access denial                        |

## Files touched

| File                                            | Change                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/contracts/src/capture-api.ts`         | `mode` gains `'pdf'`; optional `pdfDataUrl`, `pdfFilename`                           |
| `packages/article-extract/src/map.ts`           | matching `ArticleCapture` fields                                                     |
| `apps/extension/src/lib/pdf-capture.ts`         | **new** — filename derivation, magic-byte check, size cap, provisional draft builder |
| `apps/extension/src/lib/capture-permissions.ts` | combined loopback + origin request; `originPatternOf`                                |
| `apps/extension/src/lib/messages.ts`            | `FETCH_PDF` message and response types                                               |
| `apps/extension/src/entrypoints/background.ts`  | `FETCH_PDF` handler; skip queue for PDFs; shortcut PDF branch                        |
| `apps/extension/src/entrypoints/popup/App.tsx`  | provisional draft on extract failure; PDF card; combined permission request          |
| `apps/extension/src/lib/popup-state.ts`         | new error codes                                                                      |
| `apps/extension/wxt.config.ts`                  | `optional_host_permissions`                                                          |
| `apps/desktop/src/main/inbox/ingest.ts`         | PDF block; thread `attachmentPath`                                                   |
| `apps/docs/src/**`                              | clipper docs — PDF capture, site-access prompt, 16 MB limit                          |

## Testing

Unit, extension:

- filename from `Content-Disposition`, from URL pathname, and the `document.pdf` fallback
- `%PDF-` magic-byte check accepts a real PDF header, rejects an HTML login page
- size cap rejects at `16 MB + 1` and accepts at exactly 16 MB
- provisional draft builder: `http(s)` extract failure yields a `pdf` draft; `chrome://`
  yields `null`
- combined permission request issues exactly one `permissions.request` call carrying both
  origins
- `captureOrQueue` never enqueues a capture carrying `pdfDataUrl`

Unit, contracts:

- `ArticleCaptureSchema` accepts `mode: 'pdf'` with the new fields, and still accepts a
  capture with none of them (old-extension compatibility)

Unit, desktop:

- `ingest.ts` with a valid `pdfDataUrl` creates a `type: 'pdf'` row with `attachmentPath`
  set, `content` null, and `captureImageItem`-shaped metadata
- a `pdfDataUrl` whose MIME is not `application/pdf` falls back to a link item and logs
- a `storeInboxAttachment` failure falls back to a link item rather than throwing

Manual, per the repo's real-user rule:

- `.pdf` URL in Chrome's viewer → grant site access → item lands as a `pdf` inbox item,
  opens in the in-app viewer, files into a folder
- same in Firefox's pdf.js viewer
- auth-gated PDF while signed in → succeeds; while signed out → `not-a-pdf`
- oversized PDF → size message, no partial item
- `⌘⇧S` on an already-granted origin → succeeds; on a fresh origin → `!` badge

## Release ordering

1. Desktop ships the contract and ingest change (an inert code path until an extension
   sends `mode: 'pdf'`).
2. Extension update goes to the Chrome Web Store and AMO for re-review.

Reversing this order produces 422s for every PDF clip until the desktop catches up.
