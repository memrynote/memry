# Foreign Syntax Preservation — Design

**Date:** 2026-07-05
**Branch:** `obs-syntax-preservation`
**Status:** Implemented (raw-segment passthrough only — the matrix proved the
inline mask/restore layer unnecessary; see "Matrix results")

## Goal

When a user edits an Obsidian-vault note in MemryNote, the parse→serialize
pipeline must not mangle Obsidian-flavored syntax it doesn't understand (P2.9,
locked). Block IDs, `%%comments%%`, Tasks-plugin emoji, Dataview fields,
highlights, math, embeds, footnotes, template vars, custom checkbox states and
non-Memry callouts must round-trip **verbatim** through BlockNote — even though
BlockNote's `tryParseMarkdownToBlocks` / `blocksToMarkdownLossy` (remark under
the hood) neither knows nor preserves them.

Scope is the note **body** only. Frontmatter is spec 01/05; unedited files are
spec 04 (byte-preservation — no write without a semantic change). This spec is
the second line of defense: the note the user _did_ edit.

## Current behavior

Two duplicated pipelines re-serialize the whole body on every save:

- **Renderer** — `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts`
  - `parseMarkdownPreservingBlanks` (`:137`): `splitMarkdownByCallouts` →
    `splitMarkdownPreservingBlanks(separateBlockImages(…))` (`:154`) →
    `splitByEmbedMarkers` (`:157`, Memry `![bookmark]`/`![embed]`/file markers
    only) → `parseMarkdownChunkPreservingNesting` (`:175`) →
    `editor.tryParseMarkdownToBlocks`.
  - `serializeBlocksPreservingBlanks` (`:199`): custom branches for
    taskBlock/youtubeEmbed/bookmark/file/callout/colors/nesting; everything
    else goes through `editor.blocksToMarkdownLossy` (`:209`, `:294`) and
    `assembleMarkdownWithBlanks` (`:301`).
- **Main (CRDT sync)** — `apps/desktop/src/main/sync/blocknote-converter.ts`:
  `markdownToBlocksPreserving` (`:284`) / `blocksToMarkdownPreserving` (`:339`)
  are near-copies of the renderer functions. Any fix must land in **both**.

Existing protection machinery (precedents to build on):

- **Gap sentinels** — `packages/shared/src/empty-lines.ts:15` masks 3+-newline
  runs as `\x00GAP:n\x00` tokens outside code fences (`splitByCodeFences`,
  `:134`) and restores them after. In-pipeline sentinel masking already exists.
- **CriticMarkup (closest prior art)** —
  `packages/shared/src/critic-markup/parser.ts:145` `parseCriticMarkup` strips
  `{++…++}`/`{--…--}`/`{>>…<<}` spans into a side-channel of
  `CriticMarkupMark`s _before_ `markdownToBlocks`
  (`blocknote-converter.ts:162–177`), and `serializeCriticMarkup` (`:228`)
  re-inserts them by plain-text offset on the way out. The cost of the
  offset-based side-channel is visible in
  `critic-markup-offset-map.integration.test.ts`: a hand-built source↔editor
  offset map (`critic-markup-offset-map.ts:12`) with several `it.skip`
  "Blocked" fixtures (leading blank runs, atom inline nodes). Lesson: prefer
  mechanisms that keep the foreign text **inside** the document (as inert
  text or opaque blocks) over offset side-channels.
- **Round-trip tests** — `critic-markup-offset-map.integration.test.ts:244–280`
  asserts only _idempotence_ (`twice === once`), not first-pass identity
  (`once === input`). Fixtures document that BlockNote's canonical output uses
  `*` bullets and loose lists ("Tight lists normalize to loose once") — i.e.
  the first save already rewrites list style. `markdown-utils.test.ts` covers
  Memry's own markers (tasks, embeds, callouts, colors, nesting) but zero
  foreign syntax.
- **Wiki links** — text `[[…]]` is converted to `wikiLink` inline atoms by
  `wiki-link-utils.ts` (`WIKI_LINK_PATTERN`, `splitTextWithWikiLinks`,
  `normalizeInlineContent`) — on _all_ text, including inside would-be
  comments. Serialization goes through `toExternalHTML`
  (`wiki-link.tsx:67–75`) emitting `[[target|alias]]`; the target pattern
  (`wiki-link.tsx:7`) admits `#Heading` / `#^blockid` verbatim.
- **Callouts** — `callout-block.tsx:205` `splitMarkdownByCallouts` matches any
  `> [!type]` line (`CALLOUT_LINE_REGEX`, `:192`) but **coerces unknown types
  to `'info'`** (`:225`), swallows `-`/`+` fold markers and custom titles into
  the first body line (`:228–229`), and dequotes nested callouts into content.
  `parseMarkdownPreservingBlanks` then keeps only `parsed[0]?.content`
  (`markdown-utils.ts:146–147`) — multi-paragraph callout bodies collapse.
- **Task lines** — a `taskBlock` serializes by regenerating the line from
  `{taskId, title, checked}` (`markdown-utils.ts:224–246` via
  `serializeTaskBlock`); anything not captured in `title` is lost. Spec 02
  rewrites this linkage.

## Syntax inventory

"Today" column: **verified** = confirmed by reading the code paths above or
existing test fixtures; **unknown** = needs the matrix test (Step 1) — the
behavior depends on BlockNote's remark parse/stringify internals we did not
run. Mechanisms: **text** = flows as literal text, matrix-guarded; **mask** =
inline mask/restore (Design §b); **raw** = raw-segment passthrough (Design §c).

| Syntax                                 | Example                                          | What BlockNote/Memry does today                                                                                                                                                                                                           | Required handling                               |
| -------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Block ID, end of line                  | `Some text ^ab12cd`                              | unknown — likely literal text; `^` escaping by remark-stringify unverified                                                                                                                                                                | text; mask if matrix shows escaping             |
| Block ID, own line (after table/quote) | `^ab12cd`                                        | unknown — parses as its own paragraph; adjacency to table preserved only via standard `\n\n`                                                                                                                                              | text; raw line if matrix shows merging          |
| Block ID on bullet                     | `- item ^ab12cd`                                 | **verified partial break**: bullet marker rewrites `-`→`*` (canonical fixtures, integration test `:245–262`); ID text itself unknown                                                                                                      | text + list-marker fix (see Open questions)     |
| Inline comment                         | `%%draft%%`                                      | **verified break**: `[[links]]` inside comments become wikiLink atoms (`splitTextWithWikiLinks` runs on all text); other mangling unknown                                                                                                 | mask                                            |
| Block comment                          | `%%`\n`- raw notes`\n`%%`                        | **verified break** by construction: body lines parse as normal markdown, then re-serialize normalized (`-`→`*`, loose lists)                                                                                                              | raw block                                       |
| Highlight                              | `==important==`                                  | unknown — likely literal text; internal `*`/`_` re-escaping risk                                                                                                                                                                          | mask                                            |
| Inline math                            | `$e=mc^2$`                                       | unknown — literal text; `\`/`^`/`_` escaping risk on stringify                                                                                                                                                                            | mask                                            |
| Block math                             | `$$`\n`\int_0^1 x\,dx`\n`$$`                     | unknown, high risk — multi-line paragraph with LaTeX backslashes through remark-stringify                                                                                                                                                 | raw block                                       |
| Mermaid fence                          | ` ```mermaid `                                   | content **verified safe** (fences excluded from gap/image machinery, `empty-lines.ts:134`; codeBlock text verbatim); `language: 'mermaid'` prop retention unknown                                                                         | text; matrix guards language passthrough        |
| Tasks emoji signifiers                 | `- [ ] Pay rent 📅 2026-07-05 🔁 every month ⏫` | plain checkbox: emoji likely survives as text (unknown), but bullet rewrites `-`→`*` (**verified**); Memry-linked task: line **verified regenerated** from props (`markdown-utils.ts:233`) — trailing metadata lost unless inside `title` | text + spec 02 must carry the raw line verbatim |
| Dataview full-line field               | `Rating:: 9`                                     | unknown — plain paragraph, likely safe                                                                                                                                                                                                    | text; matrix                                    |
| Dataview bracketed                     | `[rating:: 9]`                                   | unknown, high risk — remark-stringify `[`-escaping (`\[rating:: 9]`)                                                                                                                                                                      | mask                                            |
| Dataview parenthesized                 | `(rating:: 9)`                                   | unknown — likely safe                                                                                                                                                                                                                     | text; mask if matrix fails                      |
| Custom checkbox state                  | `- [-] cancelled`, `- [?] maybe` (any char)      | **verified break**: not a GFM task marker → plain bullet with literal `[-]` text, bullet rewritten `-`→`*`; bracket escaping unknown                                                                                                      | raw line                                        |
| Template vars                          | `{{title}}`, `{{date:YYYY-MM-DD}}`               | unknown — `{` normally unescaped; likely safe                                                                                                                                                                                             | text; mask if matrix fails                      |
| Inline footnote                        | `^[a note]`                                      | unknown, high risk — `[` escaping                                                                                                                                                                                                         | mask                                            |
| Footnote reference                     | `[^1]`                                           | unknown, high risk — if BlockNote's remark config includes GFM footnotes, node is foreign to its schema → dropped                                                                                                                         | mask                                            |
| Footnote definition                    | `[^1]: the note`                                 | unknown, high risk — footnoteDefinition node drop                                                                                                                                                                                         | raw line                                        |
| Embed, own line                        | `![[img.png\|300x200]]`, `![[doc.pdf#page=3]]`   | unknown, high risk — **verified** not matched by `splitByEmbedMarkers` (Memry markers only) nor `STANDALONE_IMAGE_LINE`; `![`-escaping risk                                                                                               | raw line                                        |
| Embed, inline                          | `see ![[Note#Heading]] here`                     | unknown, high risk — same escaping risk                                                                                                                                                                                                   | mask                                            |
| Wiki link + anchors                    | `[[Note#Heading]]`, `[[Note#^ab12cd]]`           | **verified** parsed to `wikiLink` atom with full target (`wiki-link.tsx:7` admits `#`/`^`); serialize emits `[[…]]` via `toExternalHTML` — post-HTML escaping unknown                                                                     | keep atom path; matrix guards escaping          |
| Markdown-style link, encoded path      | `[note](My%20Note.md)`                           | unknown — link node URL re-encoding unverified; style (md-link vs wikilink) is structurally preserved (distinct node types)                                                                                                               | text; matrix guards URL + style                 |
| Callout, unknown type                  | `> [!faq] Title`                                 | **verified break**: type coerced to `info` (`callout-block.tsx:225`)                                                                                                                                                                      | raw block                                       |
| Callout, fold marker                   | `> [!note]- Title`, `+`                          | **verified break**: fold marker + title swallowed into body (`:228–229`); never re-emitted (`serializeCalloutBlock:194`)                                                                                                                  | raw block                                       |
| Callout, custom title (Memry types)    | `> [!info] My title`                             | **verified break**: title demoted to first body line                                                                                                                                                                                      | raw block (v1); native title prop later         |
| Callout, nested / multi-paragraph      | `> [!note]`\n`> > [!tip] inner`                  | **verified break**: dequoted+flattened; only `parsed[0]?.content` kept (`markdown-utils.ts:146–147`)                                                                                                                                      | raw block                                       |

Related but out of this spec's per-syntax table: BlockNote's canonical style
rewrites `-` bullets to `*` and tight lists to loose on the first save
(**verified** via integration-test fixtures). See Open questions.

## Matrix results (measured 2026-07-05)

`foreign-syntax-roundtrip` fixtures through both real pipelines resolved every
"unknown" above:

- **Already verbatim (no fix needed; fixtures kept as regression guards):**
  every inline row — `%%…%%` comments (even containing `[[links]]`),
  `==highlight==`, `$math$`, `^[inline footnote]`, `[^1]` refs (when no
  definition is present), all `![[…]]` embeds, wiki links with `#`/`#^`
  anchors, `[note](My%20Note.md)`, all three Dataview forms, `{{templates}}`,
  block IDs (eol and own-line), mermaid fences including the language.
  remark escapes **nothing** here, so **design (b) mask/restore was dropped**
  per the do-nothing-when-green rule.
- **Broken at block level (fixed by (c) raw-segment passthrough):** `%%` block
  comments, `$$` math blocks (backslash loss), footnote definitions (GFM
  footnote nodes rewrite refs to `[1](#user-content-fn-1)`), custom checkbox
  states, and all five callout shapes (remark also emits `\`-hard-breaks
  inside blockquotes).
- **Still failing, deferred (marked `it.fails`):** `-`→`*` + tight→loose list
  normalization (`block-id-on-bullet`, `tasks-emoji-plain-checkbox`, and
  renderer-side `tasks-emoji-linked-task`) — open question 1 / spec 02.

## Design

### Strategy evaluation

- **(a) Test matrix first (TDD).** A golden fixture per table row driven
  through the _real_ pipeline (`BlockNoteEditor.create()` +
  `parseMarkdownPreservingBlanks` → `serializeBlocksPreservingBlanks`),
  asserting **first-pass identity** (`once === input`) — stricter than the
  existing idempotence-only round-trip test. Resolves every "unknown" above
  into a fact before we write a single fix. **Adopt, do first.**
- **(b) Mask/restore.** Sentinel-mask recognized foreign inline spans so
  neither remark's parser nor its stringifier can touch them, then restore the
  original bytes. Unlike CriticMarkup's offset side-channel, the text stays in
  the document, so no offset map is needed. **Adopt for inline syntax.**
- **(c) Raw-segment passthrough.** Lines/blocks the schema cannot represent
  become an opaque `rawMarkdown` block that serializes its `markdown` prop
  verbatim — the exact pattern taskBlock/bookmark/file blocks already use.
  **Adopt for line/block syntax.**

Order: **a → b + c per syntax**, guided by the matrix results. Anything the
matrix proves already round-trips stays as plain text with the fixture as a
regression guard — no speculative masking.

### (b) Inline mask/restore

New module `packages/shared/src/foreign-syntax.ts` (shared by both pipelines):

```ts
export interface ForeignSpan {
  token: string // 'FS<n>' — PUA chars, inert to remark
  original: string
}

export function maskForeignInline(markdown: string): {
  masked: string
  spans: ForeignSpan[]
}
export function restoreForeignInline(text: string, spans: ForeignSpan[]): string
```

- A single ordered regex registry (`%%…%%`, `==…==`, `$…$`, `^[…]`, `[^…]`,
  `![[…]]` inline, `[k:: v]`, `{{…}}`, trailing ` ^id`) scanned per non-code
  region (reuse `splitByCodeFences`). First-match-wins; no nesting inside an
  already-claimed span.
- **Parse side:** mask → `tryParseMarkdownToBlocks` → walk the resulting
  blocks and restore tokens back to the original text as plain `StyledText`.
  The editor shows the raw syntax (Obsidian source-mode behavior) — no custom
  rendering in v1. Masking must run **before** wiki-link conversion
  (`normalizeInlineContent`) so `[[links]]` inside `%%comments%%` stay text,
  and **after** `parseCriticMarkup` on the main path (critic spans may contain
  foreign syntax).
- **Serialize side:** walk blocks pre-serialize, re-mask registered spans in
  text content → `blocksToMarkdownLossy` (PUA tokens are never escaped) →
  restore in the output string. This is what defeats remark-stringify's
  `\[`/`\!`/`\\` escaping.
- If the user edits inside a span, it no longer matches the registry and
  serializes as whatever they typed — correct: they changed it.

### (c) Raw-segment passthrough

- New block spec `raw-markdown-block.tsx`: `type: 'rawMarkdown'`,
  `content: 'none'`, `props: { markdown: string }`. Renders as a muted
  monospace block (read-only v1; double-click-to-edit is a later enhancement).
  Flows through CRDT like taskBlock does.
- Pre-parse splitter `splitForeignRawSegments(markdown)` in the shared module,
  running at the same stage as `splitMarkdownByCallouts`
  (`markdown-utils.ts:141` and the main twin). Detects: `%%…%%` multi-line
  blocks, `$$…$$` blocks, footnote definition lines, own-line `![[…]]`
  embeds, custom-state checkbox lines, and any callout
  `splitMarkdownByCallouts` cannot represent losslessly (unknown type, fold
  marker, custom title, nesting, multi-paragraph body — the callout splitter
  gains a `isLosslessMemryCallout` guard and otherwise leaves the lines to the
  raw splitter).
- Serializer branch in `serializeBlocksPreservingBlanks` /
  `blocksToMarkdownPreserving`: `rawMarkdown` → emit `props.markdown` verbatim
  (mirror the `taskBlock` branch at `markdown-utils.ts:224`).

## Implementation plan

1. **Matrix fixtures + failing tests.** `foreign-syntax-roundtrip.integration.test.ts`
   next to the CriticMarkup integration test; one fixture per inventory row
   (list below), asserting `once === input` and `twice === once`. Mark
   currently-failing rows `it.fails`. Update the inventory table's "today"
   column with the measured results. → verify: suite runs, failures match the
   verified-break rows at minimum.
2. **Main-side matrix.** Same fixtures through
   `markdownToBlocks`/`yDocToMarkdown` twins in
   `blocknote-converter.test.ts`. → verify: parity with step 1 results.
3. **Shared module.** `packages/shared/src/foreign-syntax.ts`: registry,
   `maskForeignInline`/`restoreForeignInline`, `splitForeignRawSegments` +
   unit tests (mask idempotence, code-fence exclusion, overlap rules).
4. **Wire masking, renderer.** `parseMarkdownPreservingBlanks` +
   `serializeBlocksPreservingBlanks`; ensure ordering vs wiki-link conversion.
   → verify: inline matrix rows flip green.
5. **Wire masking, main.** Same in `blocknote-converter.ts`, after
   `parseCriticMarkup`. → verify: step 2 inline rows flip green.
6. **`rawMarkdown` block + splitter, renderer.** Block spec, schema
   registration, parse splitter, serializer branch. → verify: block-level
   matrix rows flip green.
7. **Raw segments, main.** Mirror step 6 in `blocknote-converter.ts`.
8. **Callout lossless guard.** Route non-representable callouts to raw;
   keep the four Memry types (simple, single-paragraph, no title) native.
   → verify: callout matrix rows green, existing callout tests untouched.
9. **Task-line coordination.** With spec 02: linked task lines keep the
   original raw line (emoji signifiers, list marker) as a prop and re-emit it
   verbatim, patching only the checkbox state on toggle.
10. **Docs.** `pnpm docs:ai-update --base <base>` →
    `pnpm docs:impact --base <base> --strict` → `pnpm docs:build`.

## Verification

```bash
pnpm --filter @memry/desktop test:renderer   # matrix + markdown-utils + foreign-syntax
pnpm --filter @memry/desktop test:main       # blocknote-converter matrix
pnpm test:desktop
pnpm lint && pnpm typecheck
```

Fixture list (one golden `.md` string each, matrix-tested in both pipelines):
`block-id-eol`, `block-id-own-line-after-table`, `block-id-on-bullet`,
`comment-inline`, `comment-block`, `highlight`, `math-inline`, `math-block`,
`mermaid-fence`, `tasks-emoji-plain-checkbox`, `tasks-emoji-linked-task`,
`dataview-fullline`, `dataview-bracketed`, `dataview-parenthesized`,
`checkbox-custom-states`, `template-vars`, `footnote-inline`, `footnote-ref`,
`footnote-definition`, `embed-image-sized`, `embed-pdf-page`,
`embed-note-heading-inline`, `wikilink-heading`, `wikilink-blockid`,
`mdlink-percent20`, `callout-unknown-type`, `callout-fold-markers`,
`callout-custom-title`, `callout-nested`, `callout-multi-paragraph`, plus one
`kitchen-sink.md` combining all of the above with gaps, code fences and Memry
markers.

## Interactions

- **04-byte-preservation** — first line of defense: an unedited file is never
  rewritten, so this spec only governs files with real edits. 04's golden
  round-trip corpus should absorb `kitchen-sink.md` once green here.
- **02-task-linkage** — step 9: whatever linkage replaces `{task:id}` must
  preserve the original checkbox line verbatim (Tasks emoji, marker char);
  regenerating from `{title, checked}` is no longer acceptable.
- **03-bookmark-embed-plain-links** — the plain-link bookmark parser must not
  claim `![[…]]` embeds; the raw/mask registry runs before bookmark detection.
- **01/05 (frontmatter)** — untouched: this spec starts after the frontmatter
  block is split off.
- **CriticMarkup** — main path ordering is `parseCriticMarkup` → mask → parse;
  serialize is the reverse. The offset map is unaffected (masked spans restore
  to identical text lengths in the document).

## Open questions

1. **List-marker + tight-list normalization.** BlockNote's canonical output
   (`*` bullets, loose lists) rewrites every list on the first save — a
   "meaningless diff" per the program goal, but not per-syntax: it is global
   style. Fix here (post-serialize marker restoration keyed on the original
   document's dominant style) or as a follow-up item under 04? Recommend
   deciding after the matrix quantifies the damage.
2. **Raw block UX.** v1 renders raw segments as inert monospace blocks. Is
   double-click-to-edit-as-text required for launch, or acceptable later?
3. **Footnote ambition.** Mask/raw keeps footnotes verbatim but unrendered.
   Native footnote rendering is explicitly out of scope here — confirm.
4. **`{{templates}}`** only matter inside template files; if the matrix shows
   they survive as text, no registry entry is added — confirm the
   do-nothing-when-green rule applies everywhere.
