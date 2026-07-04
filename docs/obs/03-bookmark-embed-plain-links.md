# Bookmark & Embed Plain Links — Design

**Date:** 2026-07-05
**Branch:** `obs-plain-links`
**Status:** Approved, pending implementation

## Goal

Stop writing `![bookmark](url)` / `![embed](url)` pseudo-image markers into `.md`
files — they render as broken images in Obsidian. Serialize both blocks as plain
markdown links; decide rich rendering (bookmark card, YouTube embed) at parse time
from the URL and link shape. Locked decision #4 in [README](README.md).

## Current behavior

- `bookmark-block.tsx:25` `serializeBookmark(url)` → `![bookmark](url)`;
  `BOOKMARK_BLOCK_REGEX` (`:23`) exported but has no importers.
- `youtube-embed-block.tsx:95` `serializeYoutubeEmbed(videoUrl)` → `![embed](url)`;
  `EMBED_BLOCK_REGEX` (`:93`) also unused.
- `markdown-utils.ts:247–255` (`serializeBlocksPreservingBlanks`) emits both markers
  as their own content segments.
- Parse side: `markdown-utils.ts:314` `splitByEmbedMarkers` matches full-line
  `EMBED_LINE_REGEX` / `BOOKMARK_LINE_REGEX` (`:310–311`);
  `parseMarkdownPreservingBlanks` (`:137–197`) turns them back into
  `youtubeEmbed` / `bookmark` blocks. A `![embed]` whose URL isn't YouTube falls
  through to plain text.
- `main/inbox/filing.ts:289` (inbox → note filing) writes `![embed](url)` directly.
- Bookmark metadata: block props (`bookmark-block.tsx:7–15`) hold
  `title/description/image/favicon/siteName`, populated only at paste-conversion
  time in `ContentArea.tsx:405–429` via `fetchLinkPreview`. Nothing is persisted:
  the marker carries the URL only, and `bookmark-block-render.tsx:23–37` already
  re-hydrates display metadata on mount (when `title` is empty) through
  `lib/url-metadata.ts:25` — a session `Map` cache over `window.api.inbox.previewLink`
  (main-process fetch in `main/inbox/metadata.ts`).
- Main-process CRDT write-back (`main/sync/blocknote-converter.ts`) has **no**
  bookmark/embed handling at all (pre-existing gap; see Open questions).

## Design

### Serialization

- **Bookmark** → `[<title>](url)`; when `props.title` is empty, fall back to the
  URL hostname (what the card itself displays, `bookmark-block-render.tsx:68`):
  `[example.com](https://example.com/article)`. No bare `<url>` autolink fallback —
  a titleless card serialized as `<url>` could not round-trip back to a card
  (see upgrade rules), and hostname-as-text invents nothing the card doesn't show.
  Title text is single-line with `[` `]` escaped.
- **YouTube embed** → the bare URL on its own line: `https://youtu.be/dQw4w9WgXcQ`.
  Bare is what a human writes for a video link, Obsidian renders it fine, and the
  URL alone is enough to re-upgrade.
- **Verbatim re-emit:** both blocks gain a `sourceText` prop (default `''`). The
  parser stores the exact matched line; serialization emits `sourceText` when set,
  else the canonical form above. Blocks are `content: 'none'` with no edit UI, so
  `sourceText` cannot go stale. This keeps `<autolink>` vs bare vs `[text](url)`
  byte-identical across saves.

### Parse-time upgrade rules

A link upgrades **only when it stands alone**: it is the sole content line of its
blank-line-delimited segment (after color/file marker lines are peeled off in
`splitByEmbedMarkers`). Inline links inside text, list items (`- [t](u)`),
headings, and quotes never match — the regexes stay `^…$` anchored and the
sole-line guard rejects lazy-continuation lines inside a paragraph.

Standalone forms considered (`https?://` only): `[text](url)`, `<url>`, bare URL.

1. **YouTube URL** (`extractYouTubeVideoId`, `packages/shared/src/youtube.ts`:
   `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`) → `youtubeEmbed`
   block, any of the three forms.
2. **Non-YouTube `[text](url)` with `text !== url`** → `bookmark` block
   (`url`, `domain`, `title: text`, `sourceText`). The markdown itself encodes the
   intent: a titled standalone link is exactly what a bookmark card shows, no
   sidecar state needed, and the file stays untouched. Opt-out is one keystroke
   (any other text in the paragraph keeps it inline).
3. **Everything else standing alone** — bare URL, `<url>`, `[url](url)` — stays a
   plain link. Hijacking every standalone link would surprise Obsidian users;
   explicit conversion stays available via the existing paste menu
   (`ContentArea.tsx:405`).

`![…](url)` image syntax and `![[embeds]]` are never candidates (spec 06).

### Metadata

The title is the only persisted metadata — it lives in the link text, user-visible
and editable from Obsidian. `description/image/favicon/siteName` remain
display-only: re-fetched at render through the existing `fetchLinkPreview` session
cache. No `.memry` sidecar cache now (offline cards degrade to title + hostname —
acceptable; see Open questions). One change: the hydration guard in
`bookmark-block-render.tsx:27` currently skips fetching when `title` is set; since
parsed cards now always have a title, relax it to fetch when `description`,
`image`, and `favicon` are all empty. Fetched values never overwrite the persisted
link-text title.

### Round-trip stability

- In-app conversion → `[Title](url)` → reopen → rule 2 → card with same title →
  serialize → identical line. YouTube paste → bare URL → rule 1 → embed → bare URL.
- Foreign files: `sourceText` re-emits the matched line byte-for-byte, whatever
  its form. Repeated saves are byte-stable in all cases.

### Migration (existing vaults)

Keep `EMBED_LINE_REGEX` / `BOOKMARK_LINE_REGEX` parsing for **one release**,
producing the same blocks but with `sourceText` left `''` — so the next save of
that note naturally rewrites the marker to the canonical plain link. No bulk
migration, no version flag; untouched notes keep old markers until edited
(consistent with spec 04's no-write-without-change gate; pre-production, fine).
Delete the legacy regex branch next release.

## Implementation plan

1. `bookmark-block.tsx` — add `sourceText: { default: '' }` to the prop schema;
   change `serializeBookmark` to take the block props and return
   `sourceText || '[' + escape(title || hostname(url)) + '](' + url + ')'`.
   Delete the unused `BOOKMARK_BLOCK_REGEX` export.
2. `youtube-embed-block.tsx` — same: `sourceText` prop,
   `serializeYoutubeEmbed(props)` returns `sourceText || videoUrl`. Delete
   `EMBED_BLOCK_REGEX`.
3. `markdown-utils.ts` serialize side (`:247–255`) — pass full props to the two
   serializers.
4. `markdown-utils.ts` parse side — extend `splitByEmbedMarkers` (`:314`): add
   standalone-link detection (`[text](url)`, `<url>`, bare URL) with the
   sole-content-line guard; set `sourceText`/`title` on the emitted parts and in
   `parseMarkdownPreservingBlanks` (`:157–168`). Keep the legacy marker regexes as
   a clearly-commented branch (parsed without `sourceText`).
5. `main/inbox/filing.ts:289` — emit the bare URL line instead of `![embed](url)`;
   update `filing.test.ts:614`.
6. `ContentArea.tsx` — no paste-flow change (`sourceText` stays `''` → canonical
   emit); verify the bookmark conversion path (`:405–429`) still resolves titles.
7. `bookmark-block-render.tsx:27` — relax the hydration guard per Design.
8. Tests — update `markdown-utils.test.ts:70–71,113,333–334`; add round-trip
   cases: card → md → card with stable bytes over two save cycles, YouTube
   bare/autolink/titled forms, inline links untouched, bare non-YouTube standalone
   stays plain, `[url](url)` stays plain, list-item and lazy-continuation links
   untouched, legacy `![bookmark]`/`![embed]` parse + canonical rewrite.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test:desktop`
- New round-trip tests in step 8 green; `pnpm --filter @memry/desktop test:renderer`
  for the focused loop
- Manual: paste YouTube URL → embed → save → file shows bare URL → reopen → embed;
  same for bookmark with `[Title](url)`; open the file in Obsidian → no broken image
- Docs gate per CLAUDE.md (`pnpm docs:impact --base <base> --strict`)

## Interactions

- **[04-byte-preservation.md](04-byte-preservation.md)** — `sourceText` is this
  spec's contribution to byte-stability; 04's golden fixtures must include
  standalone titled links, bare URLs, autolinks, and all YouTube URL forms. 04's
  write gate is what defers the legacy-marker rewrite until a real edit.
- **[06-foreign-syntax-preservation.md](06-foreign-syntax-preservation.md)** —
  `![](url)` images and `![[file]]` embeds are excluded from upgrade here; 06 owns
  their verbatim preservation. The `sourceText` verbatim-re-emit pattern introduced
  here is the same mechanism 06 generalizes.

## Open questions

- `main/sync/blocknote-converter.ts` (CRDT write-back) never handled
  bookmark/embed blocks; after this change synced bookmark blocks still lack a
  serialize case there. Pre-existing gap — mirror rules 1–3 there, or confirm
  bookmark blocks never reach that path? Tracked separately, not a blocker.
- `.memry` sidecar metadata cache (richer offline cards, fewer refetches) —
  deferred until render-time fetch proves annoying.
- Make the titled-standalone-link upgrade (rule 2) a toggle if Obsidian users
  complain? Default stays on; revisit with feedback.
