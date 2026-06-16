# Link Capture + defuddle + Browser Extension — Design

Date: 2026-06-17
Status: Design (pre-implementation)
Owner: Kaan

## Summary

Enrich Memry's link capture with full readable-article extraction via
[defuddle](https://github.com/kepano/defuddle), and add a Chromium browser
extension that captures pages into the vault. Two capture paths converge on one
result: an **inbox item carrying the full article markdown plus a property set**
(title, source, author, published, created, description, tags). The user triages
the inbox item and files it to a note; the properties become note frontmatter.

Both paths produce identical notes — only the HTML source differs (in-app fetch
vs. the extension's live page DOM).

## Goals

- Paste a URL in-app → inbox item with full article body + properties.
- One browser extension (Chromium MV3) capturing **whole article | text
  selection | visible screenshot** into the inbox, with an editable
  review-before-save popup that mirrors the resulting Memry note.
- Captured items carry a property set that flows into note frontmatter on filing.
- Fully local + E2E-private: extension talks only to a localhost endpoint in the
  desktop app. No new server, no cloud relay.

## Non-Goals (v1)

- Firefox / Safari extensions (Chromium MV3 only; Firefox is a near-drop-in later).
- Cloud relay / capture while the desktop app is closed (extension queues locally
  and flushes on reconnect instead).
- Direct-to-folder note creation from the extension (destination is the inbox;
  filing to a note is the existing separate step).
- Re-extraction UI / editing the extracted body in the popup (body is read-only
  preview in v1; properties are editable).

## Decisions (locked via brainstorming)

| Axis              | Decision                                                                            |
| ----------------- | ----------------------------------------------------------------------------------- |
| Transport         | Localhost HTTP, **app must be running**; extension queues + flushes on reconnect    |
| defuddle location | **In-extension** on live DOM (best fidelity); paste path runs defuddle **app-side** |
| Destination       | **Inbox item** with full article markdown body (file-to-note later)                 |
| Browsers          | **Chromium MV3** (Chrome / Edge / Brave / Arc)                                      |
| Capture modes     | Article \| text selection \| visible screenshot                                     |
| Popup flow        | **Review-then-save** to inbox; editable properties + body preview                   |
| Property editor   | **Full editable rows** reusing Memry `PropertyRow` components                       |

## Existing surface (what we build on)

- `captureLink` → `metadata-scrape` job → `fetchUrlMetadata` (via `chromiumFetch`,
  Chromium UA) currently pulls **OG card only** (title/description/hero/favicon/
  author/date). No article body. — `apps/desktop/src/main/inbox/{jobs,metadata}.ts`
- `CaptureClipInput { html, text, sourceUrl, sourceTitle, tags, source }` and item
  type `'clip'` are already typed in contracts (handler wiring to be verified).
- `LinkMetadata.extractionStatus: 'pending' | 'full' | 'partial' | 'failed'`
  already exists — to be populated.
- `CaptureSource` already includes `'browser-extension'` and `'api'`.
- `startLoopbackServer` pattern exists in main (Google Calendar + auth OAuth) —
  reused as the basis for a persistent capture endpoint.
- `PropertiesService` (`packages/app-core/src/properties.ts`): notes carry
  `properties` (frontmatter); property types `text | link | list | date |
select | multiselect | status`. `createDefinition` is an idempotent upsert.
- `InfoHeader` / `PropertyRow` note-header components (note-header redesign) —
  reused as the popup's property-row visual language.
- Import suite `_shared/html-to-markdown.ts` + `attachments/inbox/{id}/` storage +
  `downloadImage` + image-processing bridge (PNG→webp) — reused.

## Architecture

### Shared result shape

Both paths converge on one ingest type and one main-side function.

```ts
interface ArticleCapture {
  url: string
  mode: 'article' | 'selection' | 'screenshot'
  contentMarkdown: string            // defuddle markdown (or selection markdown)
  excerpt: string
  extractionStatus: 'full' | 'partial' | 'failed'
  properties: Record<string, unknown> // title/source/author/published/created/description/tags
  heroImage?: string                 // remote URL, downloaded app-side
  selectionMarkdown?: string          // when mode === 'selection'
  screenshotDataUrl?: string          // when mode === 'screenshot'
  capturedHtml?: string               // optional raw, for debug/re-extract
}

// main process — the single convergence point
ingestArticleCapture(input: ArticleCapture, source: CaptureSource): Promise<InboxItem>
```

`ingestArticleCapture` creates/updates the inbox item, downloads hero + saves
screenshot to `attachments/inbox/{id}/` (screenshot compressed via the existing
image-processing bridge), stores `contentMarkdown` in item `content`, writes
`metadata.properties` + `metadata.extractionStatus`, emits `emitUpdated` +
projection events. Reuses existing dedup (`force` flag) on `url`.

### New package: `@memry/article-extract`

Wraps defuddle so both paths emit the same `ArticleCapture` (minus transport-only
fields). defuddle ships `{ markdown: true }` output natively (same lib kepano uses
in the Obsidian clipper), so no separate markdown converter is required.

```ts
// browser entry (extension) — defuddle is sync in the browser
import Defuddle from 'defuddle'
export function extractFromDocument(doc: Document, url: string): ArticleResult {
  const r = new Defuddle(doc, { markdown: true }).parse()
  return mapToArticleCapture(r, url)
}

// node entry (paste path, main process) — defuddle/node is async
import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'
export async function extractFromHtml(html: string, url: string): Promise<ArticleResult> {
  const { document } = parseHTML(html)
  const r = await Defuddle(document, url, { markdown: true })
  return mapToArticleCapture(r, url)
}
```

`mapToArticleCapture` maps defuddle metadata → the property set + extraction
status. defuddle's computed-style filtering is only active in the real-DOM
(extension) path; the linkedom path degrades gracefully → `extractionStatus:
'partial'` when defuddle reports low word count / empty content.

New deps: `defuddle`, `linkedom`.

### Property model

defuddle metadata → a property set carried capture → inbox item → note frontmatter.

| Popup field | Memry property type | Source                     |
| ----------- | ------------------- | -------------------------- |
| title       | text (core)         | defuddle `title`           |
| source      | **link**            | page URL                   |
| author      | **list**            | defuddle `author`          |
| published   | **date**            | defuddle `published`       |
| created     | **date**            | capture timestamp          |
| description | text                | defuddle `description`     |
| tags        | **list** (core)     | user (default `clippings`) |

- Capture payload + `ArticleCapture` carry `properties`.
- Inbox item stores them in `metadata.properties`.
- On **file-to-note**: `PropertiesService.set(noteId, properties)` writes
  frontmatter; missing definitions auto-created via `createDefinition`
  (idempotent) so `source=link`, `author=list`, `published=date` render with the
  right glyph/editor. `title` + `tags` are already core.
- Property names + types are identical across both paths, so notes look the same.

## Path A — in-app paste (enhance existing)

1. `captureLink` keeps the fast `metadata-scrape` job → OG card appears immediately.
2. New **`article-extract` job type**: `chromiumFetch(url)` → `extractFromHtml`
   → merge into the item via `ingestArticleCapture` (progressive enrichment: card
   first, body + properties fill in async).
3. Failure → keep the card; `extractionStatus: 'failed'`.

## Path B — browser extension (Chromium MV3)

New workspace package `apps/extension` (Vite + WXT or `@crxjs/vite-plugin`).

- **Content script**: runs `extractFromDocument` on the live DOM; reads
  `window.getSelection()`; `chrome.tabs.captureVisibleTab` for screenshots.
- **Popup**: the review-before-save UI (below). Edits properties, picks mode,
  edits tags, then "Add to Memry".
- **Background (service worker)**: holds the pairing token; POSTs the
  `ArticleCapture` to the localhost endpoint; **queues failures in
  `chrome.storage.local`** and retries on `chrome.alarms` / reconnect; sets the
  toolbar badge to the pending count.
- **Keyboard command** (e.g. `Cmd+Shift+S`) → capture article.

### Popup UI — frontend-design direction

**Signature** (the one memorable, on-brand element): the popup is a **live
miniature of the Memry note it will become** — same `PropertyRow` language and
type glyphs as the note header, same body typography. Capture is a WYSIWYG
preview, not a foreign Obsidian-style form. Reuse Memry design tokens +
components so it reads as native, not templated. No vault selector (Memry is a
single local vault). One accent (Memry primary) on the button only; rows quiet.
Quality floor: visible keyboard focus, reduced-motion respected, mobile N/A
(fixed popup width).

```
┌─────────────────────────────────────┐
│ ● Memry        connected   ⚙        │  status: connected / app-closed
├─────────────────────────────────────┤
│ Running local models is good now    │  title (editable, display face)
│                                      │
│ Properties ▾                         │  collapsible PropertyRow rows
│   🔤 title       Running local mod…  │
│   🔗 source      vickiboykis.com/…   │
│   ☰  author      Vicki Boykis        │
│   📅 published   2026-06-15          │
│   📅 created     2026-06-17          │
│   🔤 description  Local agentic cod… │
│   ☰  tags        clippings ×  + add  │
├─────────────────────────────────────┤
│  [ Article ] [ Selection ] [ Shot ]  │  capture-mode segmented control
│  ┌─ body preview (scroll) ─────────┐ │
│  │ I've been working [with local…] │ │  defuddle markdown, muted, read-only
│  └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│         Add to Memry            ▾     │  primary; ▾ = "Add and open note"
└─────────────────────────────────────┘
```

- States: **connected** (default); **app-closed** ("Memry isn't running — saved,
  will sync when you open it", queued); **capturing**; **saved** (✓ "View in inbox").
- Copy: active voice; button "Add to Memry" → toast "Added to inbox". Failed
  extraction → "Couldn't read the article — saved the link and your selection."

## Transport + Security

Persistent loopback HTTP server in main: `POST http://127.0.0.1:<port>/capture`.

A localhost server is reachable by **any web page the user visits** and by other
local processes. All of the following are required:

- **Bind `127.0.0.1` only** (never `0.0.0.0`).
- **Pairing token**: the app generates a secret; the user pairs the extension once
  via `memry://pair?token=…` deep-link (popup "Pair" opens the app, which confirms
  and hands the token + live port back to the extension). The extension sends
  `Authorization: Bearer <token>` on every capture; requests without it are
  rejected (blocks drive-by web pages). Token is rotatable from app settings;
  unpair revokes.
- **Origin allowlist**: accept only `Origin: chrome-extension://<known-id>`;
  reject normal web origins (defeats CSRF from pages).
- **Anti-DNS-rebinding**: require a custom header (`X-Memry-Capture: 1`) that
  cross-site pages cannot set without a CORS preflight we never grant.
- Port: fixed default with a small probe range; the extension learns the live port
  from the pairing handshake response.

The pairing handshake also returns the live port + confirms reachability so the
popup can show connected/disconnected accurately.

## Data model changes

- `InboxJobType` += `'article-extract'`. The type is declared in four places
  (`packages/contracts`, `packages/rpc`, `packages/db-schema`,
  `packages/domain-inbox`) and must be kept in sync (same pattern as
  `CaptureSource`).
- `LinkMetadata.extractionStatus` already exists — populate it.
- `metadata.properties: Record<string, unknown>` carried on the inbox item.
- Capture inputs gain `properties` (+ `mode`, `selectionMarkdown`, screenshot
  attachment).
- No new DB table. Hero + screenshot are attachments.
- Confirm/wire the `clip` capture handler (typed in contracts; verify it is
  registered before relying on it).

IPC: a new capture/ingest channel (or reuse the inbox capture channel) routed
through `packages/contracts`; run `pnpm ipc:generate` + `pnpm ipc:check` after
editing contracts/preload/handlers.

## Error handling / edge cases

- App closed → extension queues, badge shows pending, flush on next successful
  ping; popup states it plainly.
- defuddle fails (login wall, PDF, empty page) → still save the link + selection /
  screenshot if present; `extractionStatus: 'failed'`; card from OG metadata.
- Duplicate URL → existing dedup path (`force` flag in capture inputs).
- Large payloads (full HTML + screenshot) → fine over loopback; screenshot capped
  to the visible viewport and compressed PNG→webp via the image-processing bridge.
- Property definition collisions → `createDefinition` upsert is idempotent; never
  overwrite an existing definition's type.

## Testing

- `@memry/article-extract`: fixture HTML → expected markdown + property set, for
  both `extractFromHtml` (linkedom) and `extractFromDocument` (jsdom) entries.
- Main: `ingestArticleCapture` + `article-extract` job (mock `chromiumFetch`);
  loopback server auth (reject no-token / bad-origin / missing custom header /
  accept paired); file-to-note property mapping (+ idempotent definition create).
- Extension: unit-test the background queue/flush + token handshake. Popup +
  capture modes via manual GUI QA.
- Reuse import-suite test conventions. `rebuild:node` before node-side vitest.

## Phasing (each independently shippable)

1. `@memry/article-extract` + paste-path `article-extract` job + property mapping
   on file-to-note. (Paste a URL → full article body + properties; no extension.)
2. Loopback capture server + pairing/security + `ingestArticleCapture` endpoint.
3. Extension MVP: article mode end-to-end + editable Properties-table popup.
4. Selection + screenshot modes.
5. Polish: queue/retry/badge, keyboard command, settings (token/port/rotate),
   "Add and open note".

## Resolved

- **Extension build tool: WXT** — first-class MV3, cross-browser (Firefox) drop-in
  later, Vite under the hood.
- **In-monorepo `apps/extension`** — own turbo pipeline + lint/types, excluded from
  the desktop build/package.
- **Pairing UX: `memry://pair?token=…` deep-link** — one click from the extension
  to authorize against the running app (single-click pair; no manual code entry).
