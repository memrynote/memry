# 12 — The note body format

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

This is the chapter FR-041 and SC-010 rest on. A body written by one client and
read by another must be byte-identical where this chapter says it is.

## 12.1 Who converts markdown — Q12.2

> **Ownership change.** From the Tauri desktop build, the core owns markdown conversion in both directions, in `crates/memry-core/src/markdown/`, per `docs/adr/0001-desktop-on-tauri-v2.md`. The converter is a Rust port of the TypeScript one, behind the cargo feature `markdown` (§12.1.4). The TypeScript converter named in the rules below is frozen until the cutover step, and it stays the oracle that generates the `markdown-convert` vectors. The citations below name the TypeScript the vectors were generated from; §12.1.4 names the Rust that reproduces them.

**Normative. A build of the core with the cargo feature `markdown` converts markdown in both
directions, through `Converter` (`crates/memry-core/src/markdown/convert/api.rs:39`), and the
`markdown-convert` vector class is the proof that it matches the TypeScript converter below. A
build without the feature, which is the iOS build, never serialises a document to markdown, and
it parses markdown in one module, `markdown_seed`, for the three writes of §12.1.0. Every other
path carries markdown verbatim.**

The TypeScript converter is a headless BlockNote editor in the Electron main process
(`apps/desktop/src/main/sync/blocknote-converter.ts:1` (`ServerBlockNoteEditor`), `:133-141`),
built from the schema factory the renderer uses (`createMemrySchema`,
`packages/editor-schema/src/schema.ts:126`;
`apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts:31`). The iOS app
converts no markdown. It changes a body through the core's block operations (`BlockEdit`,
`crates/memry-core/src/crdt/body_edit/mod.rs:50`), which write the Y.Doc directly.

The directions:

| Direction              | Mechanism                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| markdown to document   | `Converter::seed_body` (`crates/memry-core/src/markdown/convert/api.rs:102`), the port of `markdownToYFragment` (`apps/desktop/src/main/sync/blocknote-converter.ts:548`) with the repairs of §12.1.1; in the iOS build, `markdown_seed` for the two writes of §12.1.0 and no others |
| document to markdown   | `Converter::serialize_note_body` (`crates/memry-core/src/markdown/convert/api.rs:152`), the port of the vault write-back's `serializeNoteBody` (`apps/desktop/src/main/sync/crdt-writeback.ts:603`)                                                                                  |
| document to plain text | `extract_text`, a plain-text walk of the `prosemirror` fragment that keeps headings and list markers, drops everything else, and claims no markdown fidelity (§12.1.3)                                                                                                               |

### 12.1.0 The core's markdown seed

`markdown_seed` (`crates/memry-core/src/crdt/markdown_seed/mod.rs`) builds blocks from markdown
for three writes and no others:

| Write                                | Entry point                                                                                                                                                                                                                                          | Rule                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a journal day opened from a template | `seed_document` (`crates/memry-core/src/crdt/markdown_seed/mod.rs:188`), called through `seed_empty_body_in` (`crates/memry-core/src/domain/body_write.rs:213`) by `open_day_from_template` (`crates/memry-core/src/domain/journal_ops/seed.rs:112`) | seeds an **empty** body only. A body that holds anything is refused, because a second tree beside the first is the whole-fragment replace §12.5.0.1 forbids (`:182-187`)     |
| a note created from a template       | `seed_document`, through `seed_empty_body_in` (`crates/memry-core/src/domain/body_write.rs:213`), called by `create_note` in the note's create transaction (`crates/memry-core/src/domain/templates.rs:155`)                                         | seeds the new, empty body with the `{{title}}`-substituted content, the same bytes as the payload `content` and `seed_markdown`. The same empty-body rule as the journal row |
| a filed inbox article                | `append_markdown_in` (`crates/memry-core/src/crdt/markdown_seed/mod.rs:210`), through `append_markdown` (`crates/memry-core/src/domain/body_write.rs:116`)                                                                                           | appends after whatever the body holds, under the article's link mention, as desktop's `generateNoteContent` does (`apps/desktop/src/main/inbox/filing.ts:427-431`)           |

**The seeded document MUST be the one desktop builds from the same bytes.** Each stage of
desktop's conversion is ported with its quirks, and
`packages/contracts/test-vectors/markdown-seed.json` pins the result, generated through the
production parse path (`crates/memry-core/src/crdt/markdown_seed/mod.rs:11-18`). The supported
set is the block types templates use: paragraphs, headings, bullet, numbered and check lists,
quotes, code blocks, dividers, and inline bold, italic, strike, code and links. A construct
outside it keeps its source lines as literal text, one paragraph per non-blank line. A construct
that changes how desktop reads the whole text, such as a toggle, CriticMarkup, a link reference
definition or a carriage return, sends every line there. No text is dropped (`:20-33`). A code
block's `language` is its fence's info string, `""` for an untagged fence or an indented run,
never BlockNote's `javascript` default (`packages/editor-schema/src/schema.ts:80-89`,
`crates/memry-core/src/crdt/markdown_seed/blocks.rs:147-158`). An
append also reads a line that is only an image as an image block, as desktop's editor does
(`:206-209`).

**Why the core parses here at all.** A day seeded from a template on the phone would otherwise
hold only `seed_markdown` until desktop built its document, and the first keystroke on the phone
would write blocks into an empty body that desktop's next write-back puts over the template text
(`crates/memry-core/src/crdt/markdown_seed/mod.rs:3-9`; JP022a in
`specs/005-ios-journal-parity/tasks.md:390-396`).

A note created from a template is seeded for the same reason. The core replaces every
`{{title}}` in the template's `content` with the note's title, as desktop's `applyTemplate` does
(`apps/desktop/src/main/vault/templates.ts:352`, `packages/shared/src/template-placeholders.ts:1-3`),
copies the result into the payload and into `note_bodies.seed_markdown`, and seeds the document
from the same bytes in the same transaction
(`crates/memry-core/src/domain/templates.rs:4-19`, `crates/memry-core/src/domain/templates.rs:138-162`).
Desktop writes that `content` as the new note's file (§12.2 carve-out A).

**The race is the journal row's.** Desktop builds a document from the file only when the note's
fragment is empty (`apps/desktop/src/main/sync/crdt-provider.ts:1829-1830`). If desktop opens the
note after the record arrives and before the seeded updates do, both devices have seeded a tree,
and the merge holds the body twice. The window and the outcome are the same as for a journal day
opened from a template on the phone, and neither write closes it.

### 12.1.1 Desktop's pipeline

**Normative, and a client MUST NOT assume otherwise.** Desktop does more than BlockNote's
markdown parse and export.

- **Inbound**, `markdownToYFragment` (`apps/desktop/src/main/sync/blocknote-converter.ts:548`)
  runs `prepareFragmentSeed` (`:586`), which takes writing tools markers, CriticMarkup and link
  reference definitions out of the text before the parse, then `applyFragmentSeed` (`:636`),
  which writes the blocks and those side channels, then `recordMarkdownSourceInYDoc` (`:690`).
- **Outbound**, the vault write-back calls `serializeNoteBody`
  (`apps/desktop/src/main/sync/crdt-writeback.ts:603`,
  `apps/desktop/src/main/sync/writing-markdown.ts:430`). It runs `yDocToMarkdown`
  (`apps/desktop/src/main/sync/blocknote-converter.ts:204`), which serialises with
  `blocksToMarkdownPreserving` and `restoreLinkReferences` (`:387-389`) and then runs
  `restoreMarkdownSource` (`:224`), and it applies `serializeCriticMarkup` last
  (`apps/desktop/src/main/sync/writing-markdown.ts:455`).

The renderer and main build their block and inline specs from one factory (§12.1), so the block
grammar of §12.6 and §12.7 is the same in both. **The out-of-band layer of §12.8 runs only on
desktop.** `markdown_seed` does not encode it: CriticMarkup and link reference definitions send
the whole text to literal paragraphs (§12.1.0).

### 12.1.2 What this means for a non-desktop client

**Normative.** A non-desktop client is any client without desktop's converter: the core and
every shell over it. Such a client:

- MUST NOT parse or serialise BlockNote markdown, except through `markdown_seed` for the two
  writes of §12.1.0, or through the Rust converter of §12.1.4 in a build that enables the feature
  `markdown` (`crates/memry-core/Cargo.toml:23`);
- carries a create's `content` and a template's body verbatim (§12.2 carve-out A);
- duplicates a note by copying its document, never by serialising it. The core snapshots each
  top-level block into the copy and sends `content: ''`
  (`crates/memry-core/src/domain/notes/duplicate.rs:58-59`, `:68`);
- changes a body only through block operations that author the change in one transaction
  (§12.5.1, `crates/memry-core/src/crdt/body_edit/mod.rs:6-9`);
- reads text out of a body through `extract_text` (§12.1.3);
- MUST preserve the Y.Doc roots of §12.5 exactly across an apply-then-encode cycle. That, not a
  markdown grammar, is its whole obligation here.

**Disposition of Q12.2: answered** (this section).

### 12.1.3 What `extract_text` does, rule by rule

**Normative.** §12.11 makes this function the basis of the cross-shell digest,
and §12.1 described it in one sentence — "keeps headings and list markers,
drops everything else" — which is true and reproduces nothing. Every rule below
was previously recoverable only from `text-extract.json` and the reference
port. The vectors still pin the bytes; this section is what lets a port be
written before it reads them.

It walks the `prosemirror` `XmlFragment` (§12.3). **It is not markdown**, does
not parse markdown, and does not emit it: the markers below are a preview
convention that happens to look like markdown.

| Node class    | Nodes                                                                                                 | Contribution                              |
| ------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Containers    | `blockContainer`, `blockGroup`, `table`, `tableRow`                                                   | no line of their own; children are walked |
| Line blocks   | `heading`, `paragraph`, `quote`, `callout`, `codeBlock`, `toggleListItem`, `tableCell`, `tableHeader` | one line each                             |
| List items    | `bulletListItem`, `checkListItem`, `taskBlock` → `- `; `numberedListItem` → `1. `                     | one line each, marker prefixed            |
| Skipped       | `divider`                                                                                             | dropped entirely                          |
| Anything else | —                                                                                                     | **walked, not dropped**                   |

Because a block is identified by node name and never by depth, y-prosemirror's
`blockContainer`/`blockGroup` nesting does not change the output, and nesting
depth contributes no indentation.

Rules that are easy to get wrong, each of which a vector case pins:

- **A heading's level is clamped to 1..=6.** A level above six emits six `#`,
  not seven. An absent or unparseable level is treated as level 1.
- **Every `numberedListItem` emits `1. `.** Numbering is deliberately not
  reconstructed: a preview does not need the count, and reconstructing it would
  make a line's output depend on its siblings.
- **A table cell is a line.** Rows and the table itself are containers, so an
  n-cell table is n lines, not one row per line.
- **A callout's type and a toggle's open state are dropped**; both contribute
  only their text, as an ordinary line.
- **An empty line block is dropped, but an empty list item is not.** The line is
  trimmed at its end and dropped if nothing remains, and a list item's marker is
  already non-empty — so an empty paragraph vanishes and an empty bullet
  survives as a bare `- `.
- **Trailing-whitespace trimming follows JavaScript's `trimEnd`**, which also
  trims `U+FEFF`. Rust's `trim_end` does not, so a port must add it explicitly
  or a note beginning with a byte-order mark digests differently on two shells.

#### 12.1.3.1 Known defect: the tag strip eats literal angle brackets

**Not normative — a defect, recorded so it is not rediscovered as a surprise.**

The reference extractor renders an `XmlText` together with its formatting marks
as XML tags, then removes them with `/<[^>]*>/g`. That expression cannot tell a
formatting tag from text the user typed, so a note containing `a <b> c`
extracts as `a  c`. The loss reaches the FTS index, the note preview and the
SC-010 digest, and it is silent in all three.

A conforming port **reproduces this**, because parity is what the digest
measures and a port that fixed it would report a false mismatch against every
other shell. Fixing it is a coordinated change to every port and its vectors at
once, not a local correction.

### 12.1.4 The Rust converter and its proof

**Normative.** The converter in `crates/memry-core/src/markdown/` MUST answer what the
TypeScript converter of §12.1.1 answers for the same input, byte for byte for markdown and
canonically for trees, and MUST fail closed, with `None`, where the TypeScript throws or answers
`null`, so the caller keeps the vault file (`crates/memry-core/src/markdown/convert/api.rs:129`,
`crates/memry-core/tests/markdown_fail_closed.rs:1`). It never edits the live document it
reads: serialization works on a detached copy
(`crates/memry-core/src/markdown/convert/canonical.rs:34`).

A write is atomic. `seed_body` and `replace_body` run the whole conversion on a copy of the
document first and touch the live one only when that succeeded, so a call either succeeds or
leaves the document, and so the vault file, exactly as it was
(`crates/memry-core/src/markdown/convert/api.rs`, `crates/memry-core/tests/markdown_atomic.rs:1`).
No input aborts the process. One budget of 100 steps covers quotes, list items and HTML elements, and a quote or an element costs one step while a list level costs two (the list and its item), so the real limits are about 97 nested quotes, about 98 nested elements and about 48 nested list levels; links and emphasis inside each other get 200 steps. A table span above 100000, a grid
above 4 million cells, and a body in the large-file class also fail closed. The same holds beyond markdown: YAML frontmatter nested more than 100 levels deep, or an alias that would put a value deeper than that under another node, is a parse error; a value deeper than 256 levels is not dumped (an error, never a truncation); and an existing Yjs body tree deeper than 100 elements is refused by `replace_body` (`Failed`, the document untouched) and has no snapshot, markdown, blocks or repair
(`crates/memry-core/src/markdown/limits.rs:1`, `crates/memry-core/tests/markdown_depth.rs:1`, `crates/memry-core/tests/markdown_depth_untrusted.rs:1`).

A read can succeed and still lose content. `doc_to_markdown` and `serialize_note_body` return
`unrepresentable` (node names the schema cannot build) and `dropped_elements` (elements
y-prosemirror removes, such as a childless table row) next to the markdown. When either is
non-empty the markdown omits that content, so a caller that writes the vault file MUST refuse the
write, or keep the file, instead of saving it
(`crates/memry-core/tests/markdown_fail_closed.rs:1`).

The read also loses content inside the elements it keeps: a text run under a mark the schema does
not know, and an attribute with a value on an element, a mark or an `XmlText` that the schema does
not declare. `read_fragment` counts these in `lost` (`crates/memry-core/src/markdown/yxml.rs:79`),
and the external feed replaces a body only when `removed` and `lost` are both zero
(`crates/memry-core/src/markdown/convert/canonical.rs:66`,
`crates/memry-core/src/domain/external_feed.rs:257`). A mark attribute that a shipped release wrote
and no build ever read back is not a loss: `RETIRED_MARK_ATTRS`
(`crates/memry-core/src/markdown/yxml.rs:52`) lists them. Today the list is `link.target`, `link.rel`,
`link.class` and `link.title`. BlockNote 0.47.1 (desktop releases v2026.4.28 to v2026-09-19)
declared these through `@tiptap/extension-link` 3.19. Every link those releases wrote carries
`target` and `rel`, and no file ever held them, because the release turned a link mark into
`{ type: "link", href, content }` before it wrote markdown. The list is derived from each release's
real `pmSchema`, which `apps/desktop/scripts/markdown-oracle/blocknote-history.mts` dumps when it
runs in a worktree at the release tag, and is checked against it in both directions
(`crates/memry-core/tests/markdown_yxml_vectors.rs:198`). A mark that this schema does not have at
all, such as the 0.47.1 AI suggestion marks, is content and stays lost.

The proof is the `markdown-convert` class in `packages/contracts/test-vectors/markdown-convert/`,
generated by running the TypeScript in place (`apps/desktop/scripts/markdown-oracle/`) and
reproduced by `crates/memry-core/tests/markdown_*_vectors.rs`:

| File                                                                              | Pins                                                                                                                                                                                                                   | Owner section         |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `frontmatter.json`, `markdown-class.json`                                         | the split, parse, serialize, YAML dump and load, the large-file class                                                                                                                                                  | §12.4                 |
| `pm-schema.json`, `yxml.json`                                                     | the ProseMirror schema, content matching, and y-prosemirror's read and write of the fragment                                                                                                                           | §12.5.0               |
| `blocknote-0.47.1.json`                                                           | what releases on BlockNote 0.47.1 wrote: their `pmSchema` and one document per note-blocks case, written by the release itself; read as the `bn-0.47.1-*` cases of `yxml.json`, `blocks.json` and `serialize-doc.json` | §12.5.0               |
| `md-to-html.json`, `html-to-blocks.json`, `parse.json`, `memry-parse.json`        | BlockNote's markdown parse, and the whole markdown-to-seed path with the repairs of §12.1.1                                                                                                                            | §12.1.1, §12.6, §12.7 |
| `grammar-corpus.json`, `seed-corpus.json`                                         | a positive and a negative note per grammar rule (`corpus/*.md`), and 250 notes of a synthetic vault                                                                                                                    | §12.6 to §12.8        |
| `serialize.json`, `serialize-doc.json`, `roundtrip.json`                          | the block serializer, and the document read back as markdown with the restore outcome and the unrepresentable nodes                                                                                                    | §12.1.1, §12.10       |
| `seed-doc.json`, `blocks.json`, `replace-body.json`                               | the document a seed writes with its side roots, the block view, and the whole-body replace                                                                                                                             | §12.5, §12.8          |
| `layer-text.json`, `layer-markers.json`, `layer-blocks.json`, `layer-critic.json` | the function-level marker, block and CriticMarkup layers                                                                                                                                                               | §12.6 to §12.8        |

Update bytes, client ids and block ids are never compared (§12.5.0): two documents are equal
when their canonical fragments and side roots are. Beyond the vectors, three oracle-free checks
run on every change (`crates/memry-core/tests/markdown_proptest.rs:1`), and two oracle-backed runs
(`crates/memry-core/tests/markdown_differential.rs:1`, `crates/memry-core/tests/markdown_corpus.rs:1`)
run in the nightly job (`.github/workflows/markdown-fuzz.yml`), with cargo-fuzz targets for `convert_roundtrip`, `replace_body` and `frontmatter_split`.

URL reflection follows whatwg-url 15.1 (jsdom 27.4), which differs from the `url` crate on `^` in
a path, `file:` hosts, drive letters, empty segments and UNC paths, opaque paths with a space before `?` or `#`,
dot segments next to a drive letter, and non-special authorities. A seeded random differential against
jsdom (`crates/memry-core/tests/markdown_url_differential.rs`, 230000 URLs, 0 mismatches) backs the
claim that the Rust answers what jsdom answers for `img.src`; a class it does not cover is not claimed. The Rust pins
`url = "=2.5.8"` and `crates/memry-core/src/markdown/bn/dom_parser/rules/url.rs` adjusts it; the
classes are `url-reflect/*` in `html-to-blocks.json`. Text that the tree builder foster-parents out of
a table lands after the table, at the end of its parent, as jsdom's adapter does
(`foster-table-*` cases).

## 12.2 FR-041 holds structurally, with three carve-outs

**The structural argument.** A non-desktop client never writes a vault file;
desktop is the only writer; and desktop writes from the Y.Doc
(`apps/desktop/src/main/sync/crdt-writeback.ts:459-466`, `:552-560`).
`restoreMarkdownSource` returns the source untouched when `ours === base`
(`packages/shared/src/markdown-source.ts:73`),
`serializeParsedMarkdownNote` re-emits the raw frontmatter block and the body
verbatim when unedited (`packages/app-core/src/markdown.ts:65-71`), and
`writebackExisting` skips the write entirely when the bytes match
(`apps/desktop/src/main/sync/crdt-writeback.ts:563-566`).

**Three carve-outs a client MUST know:**

- **Carve-out A — a non-desktop client's markdown does reach disk on create.** A note record
  push carries `content` only on `create`
  (`apps/desktop/src/main/sync/item-handlers/note-handler-sync-helpers.ts:63`). The core puts
  the caller's `content` into the create payload unchanged
  (`crates/memry-core/src/domain/notes/mod.rs:206`), and a note made from a template carries the
  template's `content` the same way, after `{{title}}` substitution
  (`crates/memry-core/src/domain/templates.rs:138`).
  Desktop writes a new remote note's file as `serializeNote(frontmatter, data.content)`
  (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:661-675`). **So "a client that
  cannot serialise markdown cannot write a vault file" is false as stated: the invariant is
  scoped to _existing_ notes, and the create-time `content` path is the exception.** A duplicate
  is not part of it. The core sends `content: ''` and copies the document
  (`crates/memry-core/src/domain/notes/duplicate.rs:58-59`, `:68`).
- **Carve-out B — a tag or property edit regenerates frontmatter**
  (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:353-371`,
  `:400-420`). See §12.4.
- **Carve-out C — a non-empty `criticMarkupMarks` disables source restoration**
  (`apps/desktop/src/main/sync/blocknote-converter.ts:158`), so a note carrying
  suggestions is **never** byte-identical after any write-back, on any client.

**Core obligation.** The `content` a client puts in a create record becomes vault bytes
verbatim on desktop. Prefer sending `content: ''` on create unless seeding from a template, and
prefer copying the document on duplicate, as the core does
(`crates/memry-core/src/domain/notes/duplicate.rs:58-59`).

**Create-time `content` is not canonical.** When a client pushes a Y.Doc alongside the create,
the Y.Doc is authoritative. Do not rely on create-time `content` matching it.

## 12.3 The body fragment and document ids

**Normative.** The body is an `XmlFragment` named **`prosemirror`**, declared once in
TypeScript as `CRDT_FRAGMENT_NAME` (`packages/contracts/src/ipc-crdt.ts:73`, pinned by
`packages/contracts/src/ipc-crdt.test.ts:39`) and once in the core as `BODY_FRAGMENT`
(`crates/memry-core/src/crdt/text_extract.rs:38`). Its layout is what y-prosemirror gives a
BlockNote document.

**Document ids are bare.** Desktop keys every Y.Doc by the bare note id, with no
namespace prefix (`apps/desktop/src/main/sync/crdt-provider.ts:897`).
Journal documents are keyed by the journal record's id (chapter 07 §7.1).

**The two-namespace local update log**, `<docId>` for server sequence numbers and
`local.<docId>` for local ones (`crates/memry-core/src/crdt/update_log.rs:1-14`, `:38`), **is
the core's storage convention, not a protocol fact.** A conforming client MAY choose any local
storage layout.

## 12.4 Frontmatter — Q12.1

### 12.4.1 The split is byte-exact by construction

**Normative** (`packages/shared/src/frontmatter-split.ts:17-60`, re-exported by `packages/app-core/src/markdown.ts:15-16`):

- `splitFrontmatterBlock` slices the block by hand using the same `---`
  delimiters gray-matter uses, so that **`block + body === raw` holds byte-exact**
  (`:10-13`).
- **A BOM is included in the block** (`:22-23`, `:34`).
- Delimiters are compared after stripping a trailing `\r` (`:26`, `:32`), so CRLF
  files parse.
- **An unclosed block is not frontmatter** and the whole file is body (`:25`,
  `:39`).

`parseMarkdownNote` records `eol` — `\r\n` if the file contains one anywhere,
else `\n` — and `hadTrailingNewline`, and **never trims the body**
(`packages/app-core/src/markdown.ts:27-39`).

### 12.4.2 The preservation rule

**Normative** (`packages/app-core/src/markdown.ts:46-90`):

- unless the frontmatter was edited, **the original raw block is re-emitted
  verbatim** (`:65-67`), which is what preserves comments, key order, quoting, CR
  bytes and the BOM;
- if the body is unchanged **it too is emitted verbatim** (`:69-71`);
- an edited body has its EOLs converted to the file's dominant EOL and the file's
  final-newline presence re-applied (`:73-74`). **Per-line EOL preservation is
  out of scope by design** (`:50-52`);
- when the written file has a frontmatter block, **the blank lines the file had
  between the block and the body are kept byte for byte**, and the edited body's
  own leading blank lines are dropped (`:75-77`). A file with none gets none, so
  the separator never changes on a save;
- **a block that ends the file, with no line end after its closing fence, gets
  the file's line end before a body that is not empty** (`:80-90`): `---\nmood:
  ok\n---` with the body `added` is written `---\nmood: ok\n---\nadded`. A fence
  line that ends in a lone `\r` gets only the `\n`. An empty body adds nothing,
  so such a file with no body stays as it is. The `block-at-eof-*` serialize
  cases of `markdown-convert/frontmatter.json` pin it. A writer that edits a
  block in place joins it to the body through the same function, as a journal
  save does (`apps/desktop/src/main/vault/journal.ts:450-453`).

Builds before this rule wrote the body against the fence (`---\nmood: ok\n---added`,
#3800). Such a file has no closing fence, so by §12.4.1 it is all body and its
frontmatter reads as text. No build repairs it. The bytes from before that write
survive only as a version: desktop's write-back keeps one (best effort on
Electron), and a CLI note update keeps none.

New files are written **LF only with a single trailing newline**, and user
content never flows through `matter.stringify`
(`packages/app-core/src/markdown.ts:130-143`).

### 12.4.3 The decision: the only guarantee is the verbatim path

**Decision, 2026-09-13 — option B. This is the normative rule.**

**A frontmatter block that the CRDT tag array, remote tags and remote properties
all left alone is re-emitted byte for byte
(`packages/app-core/src/markdown.ts:65-67`). When any of those alters it, the
block is regenerated and clients MUST NOT depend on key order, quoting style,
comment survival, or scalar spelling. A non-desktop client MUST NOT emit YAML at
all.**

The regenerated order is a composition of JavaScript semantics and js-yaml
defaults, **not a policy**: `stringifyFrontmatterBlock` drops `undefined`, emits
`''` for zero keys, and hands the object to `matter.stringify`
(`packages/app-core/src/markdown.ts:116-128`); gray-matter 4.0.3 does
`Object.assign({}, file.data, data)` and calls `yaml.safeDump`; js-yaml 3.15.1
defaults are `sortKeys: false`, `lineWidth: 80`, `noCompatMode: false`.

Per path:

| Path              | Behaviour                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRDT write-back   | `{ ...existing }`, and `merged.tags = yjsTags` only when there is no file yet (`apps/desktop/src/main/sync/crdt-writeback.ts:1052-1063`) — existing keys hold position and an existing file keeps its own `tags:`. Journal `{ ...existing, date }` (`:966`) still takes a non-empty array                                   |
| remote tags       | assignment or `delete` in place (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:357-361`, `:404-408`)                                                                                                                                                                                                            |
| remote properties | `replacePropertiesOnRoot` normalises, deletes every property key, then re-adds them in the **record's** order (`apps/desktop/src/main/vault/frontmatter.ts:414-434`, `:438-449`, `:452-461`). **Editing one property moves every property to the end of the block.**                                                        |
| new file          | `serializeNote` → `normalizePropertiesToRoot` → `writeMarkdownNote` (`apps/desktop/src/main/vault/frontmatter.ts:186-188`, `packages/app-core/src/markdown.ts:134-143`); a remote create builds `{tags?, aliases?, properties?}` in that literal order (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:601-607`) |

**Value re-spelling is part of the same loss.** `parseNote` uses js-yaml
`safeLoad`, so `date: 2026-07-05` becomes a `Date`
(acknowledged at `apps/desktop/src/main/sync/crdt-writeback.ts:983`) and the
dumper re-emits it as `toISOString()`, i.e.
`2026-07-05T00:00:00.000Z`. **Any frontmatter edit rewrites every bare date.**
Comments, quoting style and blank lines survive only on the verbatim path
(`packages/app-core/src/markdown.ts:5-13`).

**The Rust core reproduces this path for desktop.** With the cargo feature
`markdown`, `memry-core` emits and reads frontmatter byte for byte as the
TypeScript above does (`crates/memry-core/src/markdown/frontmatter/`: the split,
`parse_markdown_note`, `serialize_parsed_markdown_note`, and a js-yaml 3.15.1
loader and dumper). The proof is `packages/contracts/test-vectors/markdown-convert/frontmatter.json`,
generated by running the cited code in place, which the Rust tests reproduce for
every case. The MUST NOT above still binds every other client: the iOS build
compiles the core without the feature.

**Rationale for B.** A real ordering policy would change bytes for every existing
user on their next tag edit, which the mandatory-backward-compatibility rule
forbids without a migration story; a non-desktop client never emits YAML, so an
ordering spec would bind exactly one implementation and conform nothing; and
Obsidian, the emitter's stated model, is also insertion-order.

**Open, out of chapter scope: whether desktop should stop coercing bare dates at
all.** It is a silent value rewrite on every frontmatter edit. That is a desktop
issue, not a protocol question.

**Disposition of Q12.1: answered (decision: option B, verbatim path only).**

## 12.5 The Y.Doc roots — Q12.5

### 12.5.0 The XML layout inside `prosemirror`

**This chapter described the markdown spelling of blocks (§12.6, §12.7) and
never the XML layout inside the `prosemirror` fragment.** A client that only
reads a body does not need it. A client that **writes** into one does, and
getting it wrong destroys content silently, so it is normative here.

```
prosemirror (XmlFragment)
└── blockGroup (XmlElement)          ← exactly one, always
    └── blockContainer (XmlElement)  ← one per block, id attribute
        └── <block type> (XmlElement)
            └── XmlText
```

**Normative: the fragment's single top-level child is a `blockGroup`.**
BlockNote's own writer builds the fragment with `topNode:
schema.nodes.blockGroup.create()`, and the `doc` node's content expression is
`blockGroup`.

**A `blockContainer` placed as a direct child of `prosemirror`, beside an
existing `blockGroup`, is silently DELETED — not rejected.** y-prosemirror's
repair heuristic answers a node its schema cannot construct by removing the
element (`createNodeFromYElement`), and a `doc` holding two top-level children
is not constructible. The damage is invisible at every layer a naive client can
see: the update applies, the document encodes, `extract_text` may even return
the text — and the next desktop to open the note renders it without the block.
This is the single most dangerous thing a writing client can get wrong, which is
why it is stated rather than left to be inferred from a fixture.

**A writer MUST therefore locate its parent rather than assume one**: append
inside the existing `blockGroup`; create the `blockGroup` first if the fragment
is empty; and **refuse** a top-level layout it does not recognise rather than
guess. Refusing is correct because the alternatives are a deletion the user
never sees and a document a peer cannot construct.

**`block-edit.json` is the class that enforces this**, by recording a base
document, one operation and the document the operation must leave behind, both
authored through BlockNote. A writer is held to producing what BlockNote would
have produced, which is the only statement of the rule that a test can check;
a writer held to its own idea of the shape cannot catch a node its peer will
delete. Its expectations are compared through the canonical rendering below
rather than through update bytes.

**Two writer defects that class found on its first run, recorded so they are
not rediscovered as surprises.** The reference core's append path put a
`blockContainer` beside the existing `blockGroup` as a second top-level child
— exactly the deletion this section warns about. And its prop write stored
every value as a **string**, so `checked` became `"true"` where BlockNote
writes the boolean `true`; since a non-empty string is truthy, an unticked box
written as `"false"` reads as ticked by anything testing the prop for truth. A
conforming writer MUST write a prop in its **declared type**, not as text.

**A block's declared props are written explicitly, not omitted.** The paragraph
BlockNote's own writer produces carries `backgroundColor`, `textAlignment` and
`textColor` at their declared defaults; the sentence below about omitting
defaults describes the hand-built fixtures, not the reference writer. A client
that omits them produces a document that renders identically and is **not**
canonically identical, so it cannot be held to byte parity with desktop.

**Each `blockContainer` carries an `id` attribute, a v4 UUID.** BlockNote's
writer stamps one on every block; its reader tolerates a missing id by
generating one, and desktop separately repairs containers lacking one on note
open — that repair exists because empty-string ids produced an editor error. A
writer SHOULD write a v4-shaped id; a reader MUST NOT fail on a block without
one.

**A block's `props` MAY be omitted when they equal their declared defaults, and
a reader MUST accept either spelling.** `textColor`, `backgroundColor` and
`textAlignment` are declared with defaults, so a node carrying no attributes
reads identically to one carrying them, and omitting them is what keeps the
hand-built fixtures small.

**This is a reader's tolerance, not a writer's licence — see the paragraph
above.** BlockNote's own writer emits the defaults explicitly, so a writer that
omits them produces a document that renders identically and is not canonically
identical to desktop's. The two statements are easy to read as one rule and are
not: a reader accepts both spellings, a writer produces exactly one of them.

**The committed fixtures are deliberately smaller than this, and two of them
disagree with it.** `text-extract.json`'s `a plain paragraph document` is
`prosemirror > blockContainer > paragraph`, and `crdt-update.json`'s real-update
case is `prosemirror > paragraph` with no container at all. Both are hand-built
and correct for what they pin — `extract_text`'s walk, and that the transport
does not inspect the bytes — and neither is the layout above. **This section,
not a fixture, is the authority on what a writer produces.**

**`note-blocks.json` is the fixture that does carry this layout**, because its
corpus is authored through BlockNote's own `blocksToYXmlFragment` rather than
by hand: every case is a real `blockGroup > blockContainer > <block>` tree, and
the top-level `blockGroup` above is visible in each one. It pins the **read**
direction — document bytes in, a block list out — across the TypeScript, Rust
and Swift ports, and its coverage is asserted against `registry-manifest.json`
so a type in the §12.9 table with no case is a failing test.

**Two facts about this layout that a reader must not get wrong, each now
pinned by that class.** First, **the top-level `blockGroup` is structure, not
nesting**: a walk that counts it as a level reports every top-level block one
deeper than it is, and a shell that indents by depth draws the whole note
indented. Second, a client comparing two documents **must not compare update
bytes** to decide they are the same. An update encodes `clientID` and
per-client clocks, and struct ordering, origin ids and run-length packing are
free choices; two different updates that converge are both correct. Documents
are compared through a canonical rendering of the fragment — node names,
nesting, attributes sorted, text — which is what `note-blocks.json`'s
`expectedCanonical` field carries and what the write-direction class compares.
An attribute whose value is null or undefined is omitted from that rendering,
because y-prosemirror writes an `undefined` attribute (`numberedListItem`
carries `start: undefined`) while skipping a `null` one, and a port that
rendered one and dropped the other would report a false mismatch.

**Normative, and stronger than the question assumes: a conforming client MUST
preserve every root present in the update stream, including roots this
specification does not name.** FR-033 says unrecognised fields are preserved and
never stripped; a Y.Doc root is such a field.

**A note document has seven roots, not eight.** `probe` is **not** one: it is set
on a throwaway `Y.Doc` under `PERSISTENCE_PROBE_KEY`
(`apps/desktop/src/main/sync/crdt-persistence.ts:229-231`) and cleared
(`:256-259`).

| Root                       | Type                                    | Writer                                                                                                                                                                                                                                                                                             | Reader                                                                                                      | Consequence of dropping it                                                                                                                                        |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prosemirror`              | XmlFragment                             | desktop's editors via y-prosemirror; desktop's seed (`apps/desktop/src/main/sync/crdt-provider.ts:1893-1899`) and external-edit replace (`apps/desktop/src/main/sync/crdt-feed.ts:51`); the core's block operations (`crates/memry-core/src/crdt/body_edit/mod.rs:50`) and markdown seed (§12.1.0) | everything                                                                                                  | **the body is lost**                                                                                                                                              |
| `meta`                     | Map (`title`, `date`)                   | `apps/desktop/src/main/sync/crdt-provider.ts:1956-1958`, `:1977-1979`                                                                                                                                                                                                                              | `apps/desktop/src/main/sync/crdt-writeback.ts:684-685`, `:706`                                              | a remotely created note materialises as `Untitled` with the wrong `createdAt`                                                                                     |
| `tags`                     | Array\<string\>                         | `apps/desktop/src/main/sync/crdt-provider.ts:1960-1964`, `apps/desktop/src/main/sync/crdt-feed.ts:127-133`                                                                                                                                                                                         | `apps/desktop/src/main/sync/crdt-writeback.ts:1059` (a note file the write-back creates)                    | a new file has no `tags:` until the record push brings them; an existing file's `tags:` is owned by the file and the note record, never by this array             |
| `markdownSource`           | Map (`record: {source, htmlComments?}`) | `packages/shared/src/markdown-source.ts:182-191` via `apps/desktop/src/main/sync/blocknote-converter.ts:517-541`, `apps/desktop/src/main/sync/crdt-feed.ts:80`                                                                                                                                     | `apps/desktop/src/main/sync/blocknote-converter.ts:156`, `:161`                                             | foreign-vault bytes are re-spelled to house style on the next write-back: a `git diff` across the user's file, violating FR-041's "change only the edited region" |
| `linkReferenceDefinitions` | Array                                   | `packages/shared/src/link-references.ts:178` via `apps/desktop/src/main/sync/blocknote-converter.ts:470-471`                                                                                                                                                                                       | `packages/shared/src/link-references.ts:187`, `apps/desktop/src/main/sync/blocknote-converter.ts:237-238`   | reference-link definitions are deleted and `[docs][d]` is inlined                                                                                                 |
| `linkReferenceUsages`      | Array                                   | same (`packages/shared/src/link-references.ts:179`)                                                                                                                                                                                                                                                | same (`:191`)                                                                                               | same                                                                                                                                                              |
| `criticMarkupMarks`        | Array                                   | `packages/shared/src/critic-markup/yjs.ts:34-45` via `apps/desktop/src/main/sync/blocknote-converter.ts:469`; renderer `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx:602`                                                                                            | `apps/desktop/src/main/sync/crdt-writeback.ts:466`, `apps/desktop/src/main/sync/blocknote-converter.ts:158` | **every suggestion and comment is deleted from the file on the next write-back, and source restoration flips back on, so the body is additionally re-spelled**    |

Root name constants:
`CRITIC_MARKUP_MARKS_ARRAY = 'criticMarkupMarks'`
(`packages/shared/src/critic-markup/yjs.ts:9`),
`LINK_REFERENCE_DEFINITIONS_ARRAY` and `LINK_REFERENCE_USAGES_ARRAY`
(`packages/shared/src/link-references.ts:158-159`),
`MARKDOWN_SOURCE_MAP = 'markdownSource'`
(`packages/shared/src/markdown-source.ts:154`).

`criticMarkupMarks` is the root that proves the rule: dropping it violates FR-033
and destroys user data.

#### 12.5.0.1 A whole-fragment replace is not a merge-safe operation

**Normative, and it is a warning rather than a permission.** Deleting a
fragment's entire contents and reinserting them —
`fragment.delete(0, fragment.length)` followed by a fresh seed, in one
transaction — **loses any concurrent edit another device made to the old
contents.** The deleted items become tombstones, and a peer's update that
targets them merges as an insert into deleted content: it applies without error,
converges, and does not appear.

Nothing else in this chapter says so, because everything else here is an
incremental edit, for which Yjs's merge is exactly what it claims to be. The
replace is the one shape where "the document converged" and "no edit was lost"
come apart, and the two are easy to conflate — **both devices agree, and one
device's work is gone.**

A client MUST NOT use a whole-fragment replace as its merge path for remote
input. Where a client uses one to re-seed a document from an external source of
truth — a file on disk, say — it MUST treat that as an authoritative overwrite
of the body, not as an edit, and a concurrent edit from another device is
expected to be lost. **Recorded here so a port does not discover it by losing a
user's paragraph.**

Observed on desktop: an out-of-app edit to a vault markdown file is fed through
`feedExternalEditToCrdt` → `replaceNoteBodyInCrdt`, which performs exactly this
replace (`apps/desktop/src/main/sync/crdt-feed.ts`). Its comment calls the
operation "lossy re Yjs history", which is true and understates it: the loss is
of concurrent _content_, not only of history. An edit typed into the editor
takes the incremental path and is not affected.

### 12.5.1 The mechanism, not just the rule

**Normative.** Yjs materialises a root that arrives in an update but was never
requested by name as a bare `AbstractType` placeholder, upgrading it only when
`getMap`/`getArray` is later called. **The only safe way to preserve unknown
roots is never to rebuild state through typed accessors: snapshot with a
full-state encode (`Y.encodeStateAsUpdate`, or `encode_state_as_update_v1` in a
Rust binding) and never assemble a document by copying named roots.**

The core and desktop already do this
(`crates/memry-core/src/crdt/registry.rs:200`, `crates/memry-core/src/crdt/snapshots.rs:10`;
`apps/desktop/src/main/sync/crdt-provider.ts:1808-1825`, `:1956`, `:1961`,
`:1977`).

**A non-desktop client** reads `prosemirror` for `extract_text` and its block operations,
and **MUST NOT delete or normalise other roots as a side effect**. It **MUST NOT** write
`criticMarkupMarks`, `linkReference*` or `markdownSource` — byte-offset marks and
source records are desktop-derived and a client that touches them corrupts them.
It **MAY** write `meta` and `tags` with
`apps/desktop/src/main/sync/crdt-provider.ts:1955-1966` semantics: set-if-absent
on create, whole-array replace on a tag edit
(`apps/desktop/src/main/sync/crdt-feed.ts:96-99`).

The critic-markup reader **drops any element failing shape validation** — `id`,
`kind`, `visibleText`, finite `start <= end`
(`packages/shared/src/critic-markup/yjs.ts:55-66`) — so a client that rewrites
elements MUST keep that shape exactly.

### 12.5.2 The `meta` key set

**Normative: two keys are defined, `title` and `date`
(`apps/desktop/src/main/sync/crdt-provider.ts:1957-1958`, `:1978-1979`). Every
other key is reserved and MUST be preserved.** Nothing forbids one, and §12.5's
rule applies to map keys as it does to roots.

**Undefined, do not rely on this: the two-writer case where a document's `tags`
root and the note record payload's `tags` disagree.** Write-back trusts the
document (`apps/desktop/src/main/sync/crdt-writeback.ts:952`) and the note
handler trusts the record
(`apps/desktop/src/main/sync/item-handlers/note-handler.ts:357-361`), with **no
tiebreak**. A client MUST NOT construct a case that depends on which wins.

### 12.5.3 Defect — `compactYDoc` drops unknown roots (#2181)

`compactYDoc` iterates `doc.share` and copies only `Y.XmlFragment`, `Y.Map`,
`Y.Array` and `Y.Text`; anything else is logged and **skipped**
(`packages/sync-client/src/crdt-compact-utils.ts:14-30`). `initDocStructure`
types only `prosemirror`, `meta`, `tags` and `criticMarkupMarks`
(`apps/desktop/src/main/sync/crdt-provider.ts:1808-1812`), so `markdownSource`
and the two `linkReference*` roots are typed only once a seed or a
`yDocToMarkdown` touches them.

Compaction fires via `setImmediate` when the encoded document passes 1 MiB with
no editor open (`apps/desktop/src/main/sync/crdt-provider.ts:2196-2219`,
threshold at `:81`) and its output replaces both the pushed snapshot and local
persistence (`:2314`, `:2319-2320`), while write-back is debounced 500 ms
(`apps/desktop/src/main/sync/crdt-writeback.ts:69`).

**A document opened editor-less from persistence and compacted before its first
write-back drops those three roots for every device, and any future root is
dropped unconditionally.** There is no test for `compactYDoc`. Tracked as
**#2181**. **This chapter states the rule of §12.5; `compactYDoc` violates it.**

**Disposition of Q12.5: answered (seven roots, not eight; every root MUST
survive, including unnamed ones).**

## 12.6 Block grammar

**Normative** (`packages/editor-schema/src/blocks/markdown.ts`), the forms that
are not plain CommonMark:

| Block            | On-disk form                                                                                                                                                                                                                                                                                                           | Anchor                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| callout          | `> [!<type>]` (optionally `-` closed or `+` open right after the `]`, the `fold` prop; no suffix is `none`) alone on its line, `<type>` one of `CALLOUT_TYPE_VALUES` or a user-defined type (§12.6.2) in lowercase, then the own line and child blocks, one `> ` per line and a bare `>` per blank line between blocks | `:34-48`, `:55-59`                      |
| structured quote | one `> ` per line, a bare `>` for each blank line between the quote's own blocks                                                                                                                                                                                                                                       | `:146-151`                              |
| youtube embed    | `![alt](videoUrl)` with a YouTube URL; Memry writes alt `embed`, any other alt is kept                                                                                                                                                                                                                                 | `:311`, `:320`                          |
| bookmark         | `![bookmark](url)`                                                                                                                                                                                                                                                                                                     | `:285`, `:327`                          |
| whiteboard       | `![whiteboard](memry://canvas/<id>)`, the canvas by id; a block with no canvas writes no line                                                                                                                                                                                                                          | `:340`, `:342-348`, `:351-353`          |
| file             | `<!-- file:{…} -->`, an HTML comment with JSON props                                                                                                                                                                                                                                                                   | `:389`, `:398`, `:439`                  |
| math             | `$$` alone on its line, the LaTeX source, then `$$`; the body's blank lines are dropped                                                                                                                                                                                                                                | `:468`, `:480-489`                      |
| toggle           | `<details data-memry-toggle>` / `<summary>…</summary>` / blank / body / blank / `</details>`; the expanded variant adds ` open`                                                                                                                                                                                        | `:558`, `:565-566`, `:606-638`          |
| plain checkbox   | `- [ ] text {check}`: a `checkListItem` whose `plain` prop is `true`; the marker ends the line, after one space                                                                                                                                                                                                        | `packages/shared/src/plain-checkbox.ts` |

**Claiming rules matter as much as the forms:**

- a youtube embed is claimed from any WHOLE line `![alt](url)` whose URL is a
  YouTube video, except alt `bookmark` and `whiteboard` (`:311-318`). The alt
  is kept in the block's `alt` prop (default `embed`) and written back
  unchanged, so another app's `![](url)` keeps its bytes. Builds before this
  rule claimed only alt `embed` and read any other alt as an `image`;
- the callout fold suffix is exactly `-` or `+`; builds before it drop the unknown `fold` prop
  and write the marker back without it;
- the callout marker regex is strict — a type that is neither in
  `CALLOUT_TYPE_VALUES` nor defined by the user (`> [!danger]`), an uppercase
  marker (`> [!NOTE]`) and `> [!info] A title` are deliberately **not** claimed
  (`packages/editor-schema/src/blocks/markdown.ts:35-42`, `callout-types.ts:65`). Older builds
  claimed only `info`, `warning`, `error` and `success`, and read the
  other nine types as quotes. The CRDT `type` prop is a free string, so those
  builds keep a newer type through sync and render it as `info`;
- the bare damaged marker (`[!info]` without its `> `) is healed only for the
  original four types (`:40-47`);
- a run abutting more quote lines is refused whole (`:125`);
- **a run is claimed only by proof**: the body must re-serialise byte for byte
  (`:195`), except a body with a list or a `> >` level, which is claimed when
  its canonical form settles (`:196-199`); a body with a checkbox is never
  claimed (`:211`). A leading paragraph is the callout's own line and every
  later block its child;
- structured quotes refuse a `>text` line and claim only a run that is separated
  or nested (`:201-207`);
- a math run is claimed only when it OWNS its paragraph at both ends and
  `serializeMathBlock` reproduces it byte for byte
  (`packages/editor-schema/src/blocks/markdown.ts:518-536`), so a one-line
  `$$x$$`, an indented fence, a fence with trailing spaces and an unterminated
  one all stay the author's markdown;
- **the file marker's JSON key order is fixed** as `url, name, size, mimeType`,
  then `width` and `height` only when greater than zero, `align` only when set
  and not `left`, and `display` only when it is `link`, so legacy markers stay
  byte-identical (`:424-439`). `display` (`embed` | `link`, default `embed`)
  chooses whether a PDF shows as the inline viewer or as its file name. A
  marker without it, or with any other value, is `embed`, and a build that
  predates the prop ignores it and shows the viewer;
- the comment-terminator escape replaces only the `>` in `-->` and `--!>` with
  `>`, so a filename containing `--` keeps its bytes (`:413`);
- a whiteboard is claimed only as a WHOLE, unindented line whose target is
  `memry://canvas/` followed by an id in `[A-Za-z0-9_-]+` (`:340`), and never
  inside a code fence: `![whiteboard](https://…)` is somebody's image and stays
  an `image` block. The marker names the canvas by id, not title, so renaming a
  canvas rewrites no note. A whiteboard whose `canvasId` is empty is written as
  NOTHING, because `![whiteboard](memry://canvas/)` fails the claim and would
  re-open as an image; the block is dropped rather than changing type.

### 12.6.2 User-defined callout types

**Normative.** A user can define callout types (name, colour, icon) in the
synced settings map `editor.calloutTypes`, one entry per name (chapter 6 §6.9:
`editor.calloutTypes.<name>`; a deleted type is `null`). A name
matches `[a-z][a-z0-9_-]{0,31}` and MUST NOT equal a built-in type
(`packages/editor-schema/src/blocks/callout-types.ts:46-47`, `:79`). A valid
definition has `color` (`#rrggbb`) and `icon` (a non-empty id) and an optional
`label`; a reader drops any entry that fails these rather than failing the
settings payload.

- **On disk nothing changes.** A custom callout is `> [!<name>]` with the same
  fold suffix and body rules as a built-in one. No definition is written into
  the note.
- **A name is claimed only while a definition exists.** The parser reads the
  current definitions (`callout-types.ts:56-67`). A marker whose name has no
  definition (another app, a build before this feature, a type deleted on
  another device) is not claimed: it stays a quote block and writes back its
  bytes unchanged, exactly as `> [!danger]` does.
- **Existing documents keep their shape.** The `type` prop of a callout block
  is a free string in the CRDT (§12.9), so no node or attribute is added. A
  client that has no definition for a `type` it meets in a document renders
  `info` and writes the marker back unchanged.
- **The Rust core needs no definitions.** It never parses `[!`; the seed sends
  such a line to the desktop fallback (`crates/memry-core/src/crdt/markdown_seed/prepare.rs`).

### 12.6.1 The view block is a code fence

**Normative.** A view block (a live list of notes embedded in a note, #2488) is
**not a block type**. It is a `codeBlock` whose `language` is `memry-view`, and
on disk it is the fence that code block already writes:

````
```memry-view
{
  "source": { "kind": "tag", "tag": "inbox-thought" },
  "layout": "list"
}
```
````

The fence body is the block's definition as JSON
(`packages/shared/src/view-block.ts`). Writers emit two-space JSON with
`source` first. The keys are:

| Key       | Value                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `source`  | required: `{ "kind": "vault" }`, `{ "kind": "folder", "path": "" }` or `{ "kind": "tag", "tag": "" }` |
| `view`    | a saved view on the source, by name                                                                   |
| `layout`  | `list`, `table` or `grid`                                                                             |
| `filters` | a folder-view `FilterExpression`, ANDed onto the saved view's filters                                 |
| `order`   | `[{ "property", "direction": "asc" \| "desc" }]`                                                      |
| `limit`   | a positive integer                                                                                    |

The consequences are the reason for the shape:

- **No schema change.** The registry in §12.9 is unchanged, so no client can
  meet a node name it would delete (§12.1). Main and every older build
  hold the block as a code block and write the same bytes back; Obsidian and
  GitHub show it as code. The desktop renderer draws it (`createMemrySchema`'s
  `codeBlockViews`, presentation only), and so does the iOS app, which keeps the
  fence out of its text editor so it is never rewritten there
  (`apps/ios/Memry/Features/Notes/NoteBlockView.swift:345-351`).
- **Round-trip is the code block's.** The body is literal text
  (`LITERAL_TEXT_BLOCK_TYPES`), and the conformance corpus pins it
  (`packages/editor-schema/src/conformance.ts`, `viewBlockCases`).
- **Readers are tolerant.** A reader MUST keep keys it does not know and MUST
  write them back when it rewrites the definition; a known key holding a value
  it does not understand is ignored for display, not dropped. A body that is not
  JSON, or has no usable `source`, is shown as an error with the source visible,
  never removed.
- **Template variables resolve as text.** A journal template substitutes
  `{{date:YYYY-MM-DD}}` and the other tokens across the whole body, fence
  included, so a filter written against them is fixed when the entry is created.

### 12.6.3 The portal block is a code fence

**Normative.** A portal (a live window onto part of another note, or the blocks a
search finds) is **not a block type** either. It is a `codeBlock` whose `language`
is `memry-portal`, with its definition (format v1) as JSON
(`packages/shared/src/portal-block.ts:223-232`):

````
```memry-portal
{
  "v": 1,
  "note": "<noteId>",
  "blocks": ["k3x9a2", "p8m2qa"],
  "open": { "k3x9a2": { "show": ["n4c8x1"] } }
}
```
````

| Key      | Value                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`      | `1`. A reader MUST accept an absent `v` as 1; a writer always emits it                                                                                                                             |
| `note`   | the source note's id, not its path, so the portal survives a rename or move                                                                                                                        |
| `blocks` | the **root** anchors (below), without the caret, in portal order, all in the source note. Entries that are not anchors, and repeats, are dropped on read. Absent or empty: the whole note          |
| `hide`   | whole-note portals only (no `blocks`): the anchors of blocks the portal leaves out, with everything under them. Entries that are not anchors, and repeats, are dropped on read. Omitted when empty |
| `open`   | which blocks show their children: a map from a block's anchor to `{ "hide": [anchors] }` or `{ "show": [anchors] }`. An entry that is neither is dropped on read                                   |
| `search` | instead of `note`: `{ "text"?, "tag"?, "limit"? }`, at least one of `text` and `tag`; `limit` defaults to 50, at most 200. Carries no `blocks` or `open`                                           |

Writers emit two-space JSON with the keys in the order `v`, `note`, `blocks`,
`open`, then any key they do not manage; `open` is omitted when empty and `blocks`
when the portal shows the whole note. A whole-note portal writes `v`, `note`, `hide`
instead, `hide` omitted when empty (`packages/shared/src/portal-block.ts:197-232`). The search form is
`{ "v": 1, "search": { ... } }` (`packages/shared/src/portal-block.ts:197-216`).

**Open modes.** A block that is absent from `open` is **collapsed**: its children
are not shown. `{"hide": [..]}` shows every child except the listed ones, so an
empty list shows all of them. `{"show": [..]}` shows only the listed children. A
block inserted through a picker is a root and collapsed, so it appears in `blocks`
and not in `open` (`packages/shared/src/portal-block.ts:138-148`).

**Anchors.** A block is addressable when its text ends with a space, a caret and
an anchor, ` ^k3x9a2`. The anchor matches `[a-z0-9][a-z0-9-]{3,31}`, and the
caret MUST follow whitespace or start the text, so `x^abcd` is not an anchor
(`packages/shared/src/portal-block.ts:84-86`, `:112-115`). An anchor is ordinary text: it round-trips as any
paragraph does (§12.6, `portalCases` in `packages/editor-schema/src/conformance.ts`),
and `^id` text that already exists in a vault keeps the meaning it had. A writer
stamps an anchor only on a block that must be referenced: one that becomes a root,
one listed in a `hide` or `show` list, or one created through a portal in show-mode.

**No schema change.** As for the view block (§12.6.1), the §12.9 registry is
unchanged, there is no write-version floor, and no client can meet a node name
it would delete. An older build shows the fence as code and writes the same
bytes back.

**Readers are tolerant.** A reader MUST keep keys it does not know and write
them back when it rewrites the definition (`packages/shared/src/portal-block.ts:223-232`). A body that is not JSON
or has no usable target is shown as invalid with its bytes left alone
(`packages/shared/src/portal-block.ts:180-195`).

**Visibility.** Given a note or blocks target and the source note's block list in
document order (the `extract_blocks` shape, §12.11), a block's _parent_ is the
nearest earlier block with a smaller depth (`packages/shared/src/portal-resolve.ts:82-90`). A block is **visible**
if and only if it is a root, or its parent is visible, its parent's anchor is a
key of `open`, and either that entry is `hide` and the block's anchor is not
listed, or it is `show` and the block's anchor is listed. A block with no anchor
can therefore be visible only as a root or under a `hide` entry
(`packages/shared/src/portal-resolve.ts:91-106`). A note target (no `blocks`) shows every block except those its `hide` list
removes: a block whose anchor is in `hide` (the first block in document order to own
that anchor) and all its descendants, the blocks after it up to the next block at its
depth or shallower. A `hide` entry that names no block changes nothing. A note target
has no `open` and no folding (`packages/shared/src/portal-resolve.ts`, `resolveNote`).

**Resolution.** A client computes the result as follows (`packages/shared/src/portal-resolve.ts:53-123`):

1. A root's block is the **first** block in document order whose text, the
   concatenation of its inline runs, ends with ` ^anchor`. A later block carrying
   the same anchor owns nothing (`packages/shared/src/portal-resolve.ts:62-73`).
2. A root anchor that matches no block is ignored. If none matches the status is
   `missing-block` and no block is shown (`packages/shared/src/portal-resolve.ts:75-80`).
3. The shown blocks are the visible blocks, in the source's document order,
   whatever the order of `blocks`.
4. A search target resolves `invalid`: its blocks are computed by the caller
   (`packages/shared/src/portal-resolve.ts:57`).

**Hidden counts.** Alongside the shown blocks a resolver returns two lists
(`packages/shared/src/portal-resolve.ts:107-120`):

- `hidden.siblings`: the blocks that share a parent with some root and are not
  visible, in document order. For a note target with `hide`: the outermost hidden
  blocks in document order (a block hidden only through a hidden ancestor is not
  listed);
- `hidden.children`: for each visible block with an anchor, keyed by that anchor,
  its children that are not visible. Empty for a note target.

A client draws "N hidden" rows from these. A visible block without an anchor has
no key; a client stamps one before it can expand that block.

`missing-note`, `locked`, `not-synced`, `cycle` (the source is already on the
chain of notes being drawn) and `too-deep` (more than three portals nested,
`PORTAL_MAX_DEPTH`, `packages/shared/src/portal-block.ts:47`) are decided by the caller before it has a block
list. The Rust core (`crates/memry-core`, the `portal` module) implements the
resolution over `Notes.blocks`, and the iOS app draws the resulting slice
read-only with an action that opens the source note. Both are held to
`packages/contracts/test-vectors/portal-resolve.json`, whose cases pin collapsed
roots, several roots, show-mode, hide-mode, nested `open`, anchors split across
inline runs, duplicate anchors, unknown keys, a missing block, and a note target's
`hide` list (nested, unknown and duplicate anchors).

## 12.7 Inline grammar

**Normative:**

| Inline type      | On-disk form                                                                     | Anchor                                                            |
| ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `wikiLink`       | `[[target]]`, or `[[target\|alias]]` when the alias differs                      | `packages/editor-schema/src/inline/wiki-link.ts:97-99`            |
| `hashTag`        | `#tag` as a bare span's text                                                     | `packages/editor-schema/src/inline/hash-tag.ts:39-43`             |
| `dateMention`    | `((date:<payload>))`, payload alphabet `[A-Za-z0-9,;_-]`                         | `packages/shared/src/date-mention.ts:32`, `:103`                  |
| `linkMention`    | `((mention:<encoded url>))`                                                      | `packages/editor-schema/src/inline/link-mention.ts:25`, `:50`     |
| `inlineImage`    | `![alt](src)`, width carried in the alt as `alt\|300` with a purely numeric tail | `packages/editor-schema/src/inline/inline-image.ts:85-92`         |
| `inlineCheckbox` | `<input type=checkbox>`-shaped DOM                                               | `packages/editor-schema/src/inline/inline-checkbox.ts:79`, `:112` |
| `htmlComment`    | the comment's own bytes, `<!--` to `-->` or `%%` to `%%`, in its `source` prop   | `packages/editor-schema/src/inline/html-comment.ts`               |

`linkMention` encodes **seven characters beyond `encodeURIComponent`** —
`! ' ( ) * ~ _` — so the token alphabet closes to `[A-Za-z0-9.%-]`
(`packages/editor-schema/src/inline/link-mention.ts:39-48`), with a wider legacy
acceptance union at `:66`.

`wikiLink` style marks nest **outer to inner** as
`bold, italic, underline, strike, code`
(`packages/editor-schema/src/inline/wiki-link.ts:114-120`); `underline` is
chip-only and reaches disk through inline-colour span masking instead (§12.8).

`htmlComment` (AF-015) holds an HTML comment, `<!--` and `-->` included, byte
for byte. Since BBF-26 it also holds an Obsidian `%% … %%` comment, both `%%`
included; the boundaries of both forms come from `replaceMarkdownComments`
(`packages/shared/src/markdown-code.ts`). A client built before BBF-26 reads a
`%%` comment as paragraph text and still writes a node it receives back as its
`source`. A comment on a line of its own is a paragraph holding only this node;
one inside a line of text, or glued to the line above or below, is a node in
that paragraph, so it is written back where it was. The serializer sees it as a
token of hex (`MEMRYCMT<word><hex>X`, `packages/shared/src/html-comments.ts`)
that `normalizeSerializedMarkdown` turns back into `source`, so nothing the
serializer escapes or re-breaks reaches the comment. `<word>` is drawn once per
process, so note text that only looks like a token stays text (BBF-30); the
token never leaves the process and never reaches a vault file or a peer. The
node holds no marks, so a comment inside emphasis (`**a <!-- b --> c**`) is
written as a text run holding its token and the marks it sat in: those a
neighbouring text run holds on a whitespace edge next to the comment (a hard
break's `\n` is not one), never `code` (BBF-52,
`packages/editor-schema/src/inline/html-comment.ts:74-86`, `:152`). Comments in fenced code and
code spans stay code, and Memry's own marker comments (§12.8, file markers,
nesting markers, writing tools markers) keep their own readers. A client built
before the type finds it unrepresentable and keeps the file (§12.1).

A `<!--` that opens an HTML block and never closes would hide the rest of the
note, so it is a node whose `source` is `<!--` alone, and the text after it
stays document content, written back as its own bytes (BBF-101,
`packages/shared/src/html-comments.ts:108-116`,
`packages/shared/src/markdown-code.ts:74-77`). Builds before BBF-101 parse such
a note to an empty body and keep the file through the source record. A `<!--`
that never closes inside a paragraph is text.

House style writes each run of neighbouring inline items that hold `bold`,
`italic` or `strike` as one pair of delimiters, with the whitespace on its
edges outside them (BBF-62). `**alpha *x y* omega**` comes back as written, not
as one emphasis per text run. The mark spanning the most items opens first, ties
in the order `bold, italic, strike`. A link counts as holding a mark when all
of its text does. Text runs inside a link that hold the same remaining marks
are joined, so `**[a *b*](u) c**` stays one link (BBF-71). `code` holds no
other mark, so ``**`a` x `c`**`` reads back as bold `x` only and is written
`` `a` **x** `c` ``
(`packages/editor-schema/src/inline/emphasis-runs.ts:71`, `:87`, `:140`).

`code` holds no link either, so a code span inside link text is the link's own
text, backticks included (BBF-105). ``[`a`](u)`` parses to link text
`` `a` ``, and the editor shows the backticks inside the link. Before BBF-105 the
span parsed to code with no link, and the next write-back deleted the address.
The parse rebuilds the span from its code: the shortest backtick fence no run
in it matches, with one space on each side when the code opens or closes with
a backtick or with a space on both ends
(`packages/editor-schema/src/inline/link-code-spans.ts:16`, `:25`,
`packages/editor-schema/src/parse-markdown.ts:326`;
`crates/memry-core/src/crdt/markdown_seed/inline.rs:316`, `:343`). House style
writes each code-span-shaped run of link text without escapes, so
``[`a*b`](u)`` comes back as written
(`packages/editor-schema/src/inline/emphasis-runs.ts:127`).

A link destination whose bytes hold whitespace is the link's `href` as
written, title and angle brackets included (BBF-109). `[a](u "t")` parses to
`href` `u "t"` and `[a](<u (y)>)` to `<u (y)>`, because the link mark has no
field for a title. The destination counts only when it has no leading or
trailing whitespace, no newline and no backtick, and the link mark accepts both
it and its address half; anything else keeps BlockNote's address half
(`packages/editor-schema/src/inline/link-destinations.ts:56`, `:97`,
`packages/editor-schema/src/parse-markdown.ts:309`;
`crates/memry-core/src/crdt/markdown_seed/links.rs:44`). House style writes an
`href` with whitespace back unescaped, so the bytes survive every save
(`packages/editor-schema/src/inline/emphasis-runs.ts:170`). A reader that opens
the link uses the address half (`linkDestination`,
`packages/editor-schema/src/inline/link-destinations.ts:43`). Builds before
BBF-109 kept only the address half.

### 12.7.1 `inlineImage` and `inlineCheckbox` outside a table — Q12.6

Both claim an element only when it is inside a `td` or `th`
(`packages/editor-schema/src/inline/inline-image.ts:107-109`,
`packages/editor-schema/src/inline/inline-checkbox.ts:107-109`).

**Normative — outside a table there is no inline form, and this is deliberate.**
An `![alt](src)` at block level is the `image` **block**, not an `inlineImage`,
and a checkbox at block level is the `checkListItem` **block**, not an
`inlineCheckbox`. The inline variants exist **because** a table cell cannot hold
a block. A client MUST NOT emit either inline type outside a table cell, and MUST
NOT claim an image or checkbox inside a table cell as a block.

**Disposition of Q12.6: answered** (this section).

### 12.7.2 Which note a wiki-link names

A `wikiLink` target's note half (the text before the first `#`) names a note
by path, by title or by one of the note's aliases, the frontmatter `aliases:`
list. Both implementations decide it with one rule
(`packages/shared/src/note-names.ts:108`,
`crates/memry-core/src/domain/wiki_target.rs:260-278`), pinned by the
`wiki-target-resolution` vectors. The first tier with a hit wins:

1. a half holding `/` is a vault-root path (one leading `/` dropped) and
   matches a note's path, with or without `.md`, case folded
   (`wiki_target.rs:322`);
2. a title spelled exactly as written;
3. a title with the same name key;
4. an alias with the same name key.

A title always beats an alias. Within one tier a note beats a journal day
(`note-names.ts:86`, `wiki_target.rs:192`), then the lowest note id wins.

The name key (`note-names.ts:23`, `crates/memry-core/src/domain/notes/names.rs:19`)
is: NFC, every run of Unicode `White_Space` collapsed to one space, the ends
trimmed, then the tag fold of §13.7.8 (locale-free, `İ` to `i`, final sigma to
`σ`, `ß` kept). Whitespace only is no name. Before this rule, titles matched
case-insensitively in ASCII only and same-title ties had no defined winner;
both changed.

An alias list as stored and synced (`note-names.ts:34`, `names.rs:38`) keeps
each spelling trimmed, drops empties, entries over 200 UTF-16 units and any
alias equal to the title by key, dedupes by key with the first spelling kept,
and holds at most 32.

### 12.7.3 Unlinked mentions

An unlinked mention is body text that spells a note's title or one of its
aliases without linking to it. Both implementations match with one rule
(`packages/shared/src/unlinked-mentions.ts:36`,
`crates/memry-core/src/domain/unlinked_mentions.rs:62`), pinned by the
`unlinked-mentions` vectors:

1. each name is trimmed, and a name under 3 characters is skipped;
2. each character folds on its own with the tag fold of §13.7.8, so matching
   is case-insensitive;
3. a match is whole-word: the characters on both sides are not letters,
   digits or `_`;
4. at one position the longest name wins, and the scan resumes after it.

Desktop scans markdown, frontmatter split off, and first blanks code,
comments, wiki links, markdown links and URLs to spaces of the same UTF-16
length (`packages/shared/src/unlinked-mentions.ts:91`,
`crates/memry-core/src/markdown/shared/mention_mask.rs:147`); offsets are
UTF-16 units into that markdown. A linked run is a wiki link or embed
(`!?[[…]]` holding no `[`, `]` or line break), a markdown link or image
whose label holds none of those and whose target holds no parenthesis or white
space, or a URL: an ASCII letter (or `ſ` or the Kelvin sign `K`, which fold
to `s` and `k` under case folding), then such letters, digits, `+`, `.` or
`-`, then `://`, not preceded by a letter, digit, `+`, `.` or `-`, running
to white space, `<`, `>` or a parenthesis (`packages/shared/src/unlinked-mentions.ts:86`).
Linking the `ordinal`-th mention writes `[[Title]]` when it spells the title
and `[[Title|text]]` otherwise, and links nothing when there is no such
mention (`packages/shared/src/unlinked-mentions.ts:112`,
`crates/memry-core/src/markdown/shared/mention_mask.rs:59`). The `markdown`
cases of the vectors pin both. The core scans `extract_text` output on iOS.
A source that already links to the note is a backlink and is not listed.
Nothing is stored: the list is computed on read from the FTS index and the
bodies.

### 12.7.4 Link-card display settings

A `wikiLink` that is the only content of its paragraph carries three display
settings, `size` (`none`, `small` or `medium`), `cover` and `preview`
(`packages/shared/src/wiki-link-props.ts:57-68`). Their defaults, `none`, `false`
and `false`, are today's inline chip (`wiki-link-props.ts:70-74`). They are
additive props of the node with those defaults
(`packages/editor-schema/src/inline/wiki-link.ts:89-91`), so a build that does
not know them builds the node without them.

**Normative:**

- The settings are stored in one sidecar line directly before the paragraph,
  `<!-- link-card:{"size":"medium","cover":true,"preview":true} -->`
  (`packages/shared/src/link-card-marker.ts:16`).
- A writer emits the JSON keys in the order `size`, `cover`, `preview`, omits a
  key at its default, and writes `size` only as `small` or `medium`
  (`link-card-marker.ts:76-87`).
- A writer emits no line when all three settings are default, so a note with no
  card is byte-identical to one written before this section
  (`link-card-marker.ts:76-87`).
- A writer emits the line only for a paragraph whose inline content is exactly
  one `wikiLink` node. A link inside running text, and a link in any other block
  type, never gets a line (`link-card-marker.ts:37-41`).
- In the on-disk order the line comes after the `table-layout` line
  (`packages/shared/src/block-markers.ts:275-282`).
- A reader accepts a line only when its JSON is an object, `size` if present is
  `none`, `small` or `medium`, `cover` and `preview` if present are booleans, and
  at least one of the three is present. Any other line, including invalid JSON
  and `{}`, is not a marker and is left as ordinary text
  (`link-card-marker.ts:93-111`). A reader ignores keys it does not know
  (`link-card-marker.ts:93-111`).
- A reader applies a marker only to the paragraph that follows, and only when it
  holds exactly one wiki link: either a `wikiLink` node, or text runs of one
  style that read `[[target]]` or `[[target|alias]]`, which it turns into the
  node. A missing key reads as its default. Otherwise the block is left as it is
  (`link-card-marker.ts:121-125`).
- The link's alias and marks (`bold`, `italic`, and the others of §12.7) are
  unchanged by a marker (`link-card-marker.ts:50-73`).

A client that does not implement the section reads the line as an unknown HTML
comment (§12.8) and shows the plain link; dropping the line on its next write
forgets the settings and nothing else.

## 12.8 The five out-of-band encodings

**Normative.** These live outside plain markdown. Two of them are **in-fragment
encodings**, carried inside `prosemirror`, and three are **sibling roots** — the
two categories are different and MUST NOT be conflated.

**Sibling roots** (all under the §12.5 preservation rule):

| Encoding         | Root                                                                      | Anchor                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| suggestion marks | `criticMarkupMarks`                                                       | `packages/shared/src/critic-markup/yjs.ts:9`; CriticMarkup parser at `packages/shared/src/critic-markup/parser.ts:153` |
| link references  | `linkReferenceDefinitions`, `linkReferenceUsages`; stripped from the body | `packages/shared/src/link-references.ts:158-159`                                                                       |
| preserved source | `markdownSource`                                                          | `packages/shared/src/markdown-source.ts:154`                                                                           |

**In-fragment encodings**, carried inside `prosemirror`, **with no preservation
duty beyond the fragment itself**:

| Encoding       | Form                                                                                                                                                                | Anchor                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| inline colours | `MEMRYICO<n>:` / `:MEMRYICC;` tokens masking a `<span style=…>`                                                                                                     | `packages/shared/src/inline-colors.ts:72-74`                                                                             |
| block markers  | `<!-- align:… -->`, `<!-- table-align:{…} -->`, `<!-- table-layout:{…} -->`, `<!-- colors:{…} -->`, `<!-- table-colors:{…} -->`, `<!-- link-card:{…} -->` (§12.7.4) | `packages/shared/src/block-markers.ts:30`, `:59`, `:139`; `packages/shared/src/block-colors.ts:11`, `:44`, `:79`, `:131` |

Date mentions (`packages/shared/src/date-mention.ts:32`, `:103`) are likewise
in-fragment, not a root.

### 12.8.1 Rule index of the conformance corpus

**Normative.** Every rule of §12.6 to §12.8 that a converter must reproduce has one row below: an identifier, the section that owns it, a note that carries the construct (positive) and a near miss that must stay the author's markdown (negative). The notes are `packages/contracts/test-vectors/markdown-convert/corpus/<id>.pos.md` and `<id>.neg.md`, and `grammar-corpus.json` holds the oracle's answer for each. A rule added to §12.6 to §12.8 gets a row here, and the verifier (`packages/contracts/src/__tests__/markdown-convert.test.ts`) fails when a row has no positive or no negative note, or a note has no row. The table is the source of the identifiers; `apps/desktop/scripts/markdown-oracle/grammar-rules.ts` writes the notes and refuses to run when its identifiers differ from these.

| Rule                                | Section | Positive note (first 70 bytes)                                           | Negative note (first 70 bytes)                                           |
| ----------------------------------- | ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `heading-1`                         | §12.6   | `# Title 1⏎⏎body⏎`                                                       | `#Title 1⏎`                                                              |
| `heading-2`                         | §12.6   | `## Title 2⏎⏎body⏎`                                                      | `##Title 2⏎`                                                             |
| `heading-3`                         | §12.6   | `### Title 3⏎⏎body⏎`                                                     | `###Title 3⏎`                                                            |
| `heading-4`                         | §12.6   | `#### Title 4⏎⏎body⏎`                                                    | `####Title 4⏎`                                                           |
| `heading-5`                         | §12.6   | `##### Title 5⏎⏎body⏎`                                                   | `#####Title 5⏎`                                                          |
| `heading-6`                         | §12.6   | `###### Title 6⏎⏎body⏎`                                                  | `######Title 6⏎`                                                         |
| `heading-seven-hashes`              | §12.6   | `###### six⏎`                                                            | `####### seven⏎`                                                         |
| `heading-toggle`                    | §12.6   | `<details>⏎<summary># Heading toggle</summary>⏎⏎body⏎⏎</details>⏎`       | `<details>⏎<summary>#Heading toggle</summary>⏎</details>⏎`               |
| `paragraph`                         | §12.6   | `plain text⏎`                                                            | `\# not a heading⏎`                                                      |
| `paragraph-hard-break`              | §12.6   | `a  ⏎b⏎`                                                                 | `a ⏎b⏎`                                                                  |
| `bullet-dash`                       | §12.6   | `- one⏎- two⏎`                                                           | `-one⏎-two⏎`                                                             |
| `bullet-star`                       | §12.6   | `* one⏎* two⏎`                                                           | `*one⏎*two⏎`                                                             |
| `bullet-plus`                       | §12.6   | `+ one⏎+ two⏎`                                                           | `+one⏎+two⏎`                                                             |
| `bullet-nested`                     | §12.6   | `- a⏎  - b⏎    - c⏎`                                                     | `- a⏎ - b⏎`                                                              |
| `bullet-loose`                      | §12.6   | `- a⏎⏎- b⏎`                                                              | `- a⏎⏎⏎⏎- b⏎`                                                            |
| `bullet-empty-item`                 | §12.6   | `- ⏎- b⏎`                                                                | `-⏎`                                                                     |
| `ordered`                           | §12.6   | `1. a⏎2. b⏎`                                                             | `1.a⏎2.b⏎`                                                               |
| `ordered-start`                     | §12.6   | `5. a⏎6. b⏎`                                                             | `5) a⏎`                                                                  |
| `ordered-nested`                    | §12.6   | `1. a⏎   1. b⏎`                                                          | `1. a⏎  1. b⏎`                                                           |
| `ordered-paren`                     | §12.6   | `1) a⏎2) b⏎`                                                             | `1 ) a⏎`                                                                 |
| `task-open`                         | §12.6   | `- [ ] todo⏎`                                                            | `- [] todo⏎`                                                             |
| `task-done`                         | §12.6   | `- [x] done⏎`                                                            | `- [X ] done⏎`                                                           |
| `task-upper`                        | §12.6   | `- [X] done⏎`                                                            | `- [y] nope⏎`                                                            |
| `task-nested`                       | §12.6   | `- [ ] a⏎  - [x] b⏎`                                                     | `- [ ]a⏎`                                                                |
| `quote`                             | §12.6   | `> quoted⏎`                                                              | `>quoted⏎`                                                               |
| `quote-multi`                       | §12.6   | `> a⏎> b⏎`                                                               | `> a⏎b⏎`                                                                 |
| `quote-nested`                      | §12.6   | `> a⏎>⏎> > b⏎`                                                           | `>> b⏎`                                                                  |
| `quote-with-list`                   | §12.6   | `> - a⏎> - b⏎`                                                           | `> -a⏎`                                                                  |
| `quote-with-code`                   | §12.6   | `> '''⏎> x⏎> '''⏎`                                                       | `> '''⏎> x⏎`                                                             |
| `callout-info`                      | §12.6   | `> [!info]⏎> body of info⏎`                                              | `> [!INFO]⏎> body⏎`                                                      |
| `callout-warning`                   | §12.6   | `> [!warning]⏎> body of warning⏎`                                        | `> [!WARNING]⏎> body⏎`                                                   |
| `callout-error`                     | §12.6   | `> [!error]⏎> body of error⏎`                                            | `> [!ERROR]⏎> body⏎`                                                     |
| `callout-success`                   | §12.6   | `> [!success]⏎> body of success⏎`                                        | `> [!SUCCESS]⏎> body⏎`                                                   |
| `callout-note`                      | §12.6   | `> [!note]⏎> body of note⏎`                                              | `> [!NOTE]⏎> body⏎`                                                      |
| `callout-abstract`                  | §12.6   | `> [!abstract]⏎> body of abstract⏎`                                      | `> [!ABSTRACT]⏎> body⏎`                                                  |
| `callout-todo`                      | §12.6   | `> [!todo]⏎> body of todo⏎`                                              | `> [!TODO]⏎> body⏎`                                                      |
| `callout-tip`                       | §12.6   | `> [!tip]⏎> body of tip⏎`                                                | `> [!TIP]⏎> body⏎`                                                       |
| `callout-important`                 | §12.6   | `> [!important]⏎> body of important⏎`                                    | `> [!IMPORTANT]⏎> body⏎`                                                 |
| `callout-question`                  | §12.6   | `> [!question]⏎> body of question⏎`                                      | `> [!QUESTION]⏎> body⏎`                                                  |
| `callout-example`                   | §12.6   | `> [!example]⏎> body of example⏎`                                        | `> [!EXAMPLE]⏎> body⏎`                                                   |
| `callout-quote`                     | §12.6   | `> [!quote]⏎> body of quote⏎`                                            | `> [!QUOTE]⏎> body⏎`                                                     |
| `callout-bug`                       | §12.6   | `> [!bug]⏎> body of bug⏎`                                                | `> [!BUG]⏎> body⏎`                                                       |
| `callout-folded`                    | §12.6   | `> [!info]-⏎> hidden⏎`                                                   | `> [!info] -⏎> hidden⏎`                                                  |
| `callout-open-fold`                 | §12.6   | `> [!info]+⏎> open⏎`                                                     | `> [!info]++⏎> x⏎`                                                       |
| `callout-with-title`                | §12.6   | `> [!tip] Title⏎> body⏎`                                                 | `> [!tip]Title⏎> body⏎`                                                  |
| `callout-with-list`                 | §12.6   | `> [!note]⏎> - a⏎> - b⏎`                                                 | `> [!note]⏎> - [ ] a⏎`                                                   |
| `callout-unknown-type`              | §12.6   | `> [!danger]⏎> body⏎`                                                    | `> [!Danger-Zone]⏎> body⏎`                                               |
| `callout-empty`                     | §12.6   | `> [!info]⏎`                                                             | `> [!]⏎`                                                                 |
| `callout-nested-quote`              | §12.6   | `> [!info]⏎> > inner⏎`                                                   | `> [!info]⏎>> inner⏎`                                                    |
| `code-fence`                        | §12.6   | `'''⏎code⏎'''⏎`                                                          | `'''⏎code⏎`                                                              |
| `code-fence-lang`                   | §12.6   | `'''ts⏎const a = 1⏎'''⏎`                                                 | `''' ts extra words⏎x⏎'''⏎`                                              |
| `code-fence-tilde`                  | §12.6   | `~~~⏎x⏎~~~⏎`                                                             | `~~⏎x⏎~~⏎`                                                               |
| `code-fence-long`                   | §12.6   | `''''⏎'''⏎''''⏎`                                                         | `'''⏎''''⏎`                                                              |
| `code-fence-empty`                  | §12.6   | `'''⏎'''⏎`                                                               | `''''''⏎`                                                                |
| `code-indented`                     | §12.6   | `    indented code⏎`                                                     | `   not code⏎`                                                           |
| `code-keeps-markers`                | §12.6   | `'''⏎<!-- align:center -->⏎'''⏎`                                         | `<!-- align:center -->⏎`                                                 |
| `math-block`                        | §12.6   | `$$⏎x^2⏎$$⏎`                                                             | `$$x^2$$⏎`                                                               |
| `math-block-multiline`              | §12.6   | `$$⏎a⏎b⏎$$⏎`                                                             | `  $$⏎a⏎$$⏎`                                                             |
| `math-unterminated`                 | §12.6   | `$$⏎x⏎⏎text⏎`                                                            | `$$ ⏎x⏎$$ ⏎`                                                             |
| `divider`                           | §12.6   | `a⏎⏎---⏎⏎b⏎`                                                             | `a⏎--⏎b⏎`                                                                |
| `divider-star`                      | §12.6   | `***⏎`                                                                   | `**⏎`                                                                    |
| `divider-underscore`                | §12.6   | `___⏎`                                                                   | `__⏎`                                                                    |
| `table`                             | §12.6   | `\| a \| b \|⏎\| - \| - \|⏎\| 1 \| 2 \|⏎`                                | `\| a \| b \|⏎\| 1 \| 2 \|⏎`                                             |
| `table-align`                       | §12.6   | `\| a \| b \|⏎\| :- \| -: \|⏎\| 1 \| 2 \|⏎`                              | `\| a \| b \|⏎\| :-: :- \|⏎\| 1 \| 2 \|⏎`                                |
| `table-ragged`                      | §12.6   | `\| a \| b \|⏎\| - \| - \|⏎\| 1 \|⏎`                                     | `\| a \| b \|⏎\| - \|⏎\| 1 \| 2 \|⏎`                                     |
| `table-pipe-escape`                 | §12.6   | `\| a \\                                                                 | b \| c \|⏎\| - \| - \|⏎\| 1 \| 2 \|⏎`                                    | `\| a \| b \|⏎\| - \| - \|⏎\| 1 \⏎` |
| `table-empty-cell`                  | §12.6   | `\| a \| b \|⏎\| - \| - \|⏎\|  \| 2 \|⏎`                                 | `\| a \| b \|⏎\| - \| - \|⏎\|\|⏎`                                        |
| `table-inline`                      | §12.6   | `\| **a** \| 'b' \|⏎\| - \| - \|⏎\| [l](u) \| ~~s~~ \|⏎`                 | `\| **a \| b** \|⏎\| - \| - \|⏎`                                         |
| `table-html`                        | §12.6   | `<table><tr><td colspan="2">x</td></tr><tr><td>a</td><td>b</td></tr></t` | `<table><tr><td colspan="x">x</td></tr></table>⏎`                        |
| `table-rowspan`                     | §12.6   | `<table><tr><td rowspan="2">x</td><td>a</td></tr><tr><td>b</td></tr></t` | `<table><tr><td rowspan="0">x</td></tr></table>⏎`                        |
| `table-align-marker`                | §12.6   | `<!-- table-align:["left","center"] -->⏎\| a \| b \|⏎\| - \| - \|⏎\| 1 ` | `<!-- table-align:[left] -->⏎\| a \| b \|⏎\| - \| - \|⏎`                 |
| `table-colors-marker`               | §12.6   | `<!-- table-colors:{"0:0":{"textColor":"red"}} -->⏎\| a \|⏎\| - \|⏎\| 1` | `<!-- table-colors:{ -->⏎\| a \|⏎\| - \|⏎`                               |
| `image`                             | §12.6   | `![alt](https://example.com/a.png)⏎`                                     | `![alt] (https://example.com/a.png)⏎`                                    |
| `image-title`                       | §12.6   | `![alt](a.png "title")⏎`                                                 | `![alt](a.png title)⏎`                                                   |
| `image-width`                       | §12.6   | `![alt\|300](a.png)⏎`                                                    | `![alt\|3x0](a.png)⏎`                                                    |
| `image-relative`                    | §12.6   | `![](./img/a b.png)⏎`                                                    | `![](<>)⏎`                                                               |
| `image-reserved-char`               | §12.6   | `![a](http://h/a^b\|c)⏎`                                                 | `![a](http://h/a b)⏎`                                                    |
| `image-file-url`                    | §12.6   | `![a](file:///C\|/x.png)⏎`                                               | `![a](file:/x.png⏎`                                                      |
| `file-marker`                       | §12.6   | `<!-- file:{"url":"a.pdf","name":"a.pdf","size":10,"mimeType":"applicat` | `<!-- file:{"url":"a.pdf" -->⏎`                                          |
| `file-marker-order`                 | §12.6   | `<!-- file:{"url":"a.pdf","name":"a","size":1,"mimeType":"x/y","width":` | `<!-- file:{"name":"a","url":"a.pdf"} -->⏎`                              |
| `file-marker-link`                  | §12.6   | `<!-- file:{"url":"a.pdf","name":"a","size":1,"mimeType":"application/p` | `<!-- file:{"url":"a.pdf","name":"a","size":1,"mimeType":"x/y","display` |
| `file-marker-align`                 | §12.6   | `<!-- file:{"url":"a.png","name":"a","size":1,"mimeType":"image/png","a` | `<!-- file:{"url":"a.png","name":"a","size":1,"mimeType":"image/png","a` |
| `file-marker-escape`                | §12.6   | `<!-- file:{"url":"a.pdf","name":"a--b.pdf","size":1,"mimeType":"x/y"} ` | `<!-- file:{"url":"a.pdf","name":"a-->b","size":1,"mimeType":"x/y"} -->` |
| `whiteboard`                        | §12.6   | `![whiteboard](memry://canvas/V1StGXR8_Z5jdHi6B-myT)⏎`                   | `![whiteboard](https://example.com/c.png)⏎`                              |
| `whiteboard-inline`                 | §12.6   | `text⏎⏎![whiteboard](memry://canvas/abc)⏎`                               | `text ![whiteboard](memry://canvas/abc) more⏎`                           |
| `whiteboard-empty-id`               | §12.6   | `![whiteboard](memry://canvas/)⏎`                                        | `![whiteboard](memry://canvas/a b)⏎`                                     |
| `whiteboard-in-fence`               | §12.6   | `'''⏎![whiteboard](memry://canvas/abc)⏎'''⏎`                             | `    ![whiteboard](memry://canvas/abc)⏎`                                 |
| `toggle`                            | §12.6   | `<details>⏎<summary>Title</summary>⏎⏎body⏎⏎</details>⏎`                  | `<details>⏎<summary>Title</summary>⏎body⏎`                               |
| `toggle-open`                       | §12.6   | `<details open>⏎<summary>T</summary>⏎⏎b⏎⏎</details>⏎`                    | `<details closed>⏎<summary>T</summary>⏎⏎b⏎⏎</details>⏎`                  |
| `toggle-nested`                     | §12.6   | `<details>⏎<summary>O</summary>⏎⏎<details>⏎<summary>I</summary>⏎⏎x⏎⏎</d` | `<details><details>⏎`                                                    |
| `toggle-inline-summary`             | §12.6   | `<details>⏎<summary>**bold** 'c'</summary>⏎⏎b⏎⏎</details>⏎`              | `<details>⏎<summary></summary>⏎⏎b⏎⏎</details>⏎`                          |
| `toggle-list`                       | §12.6   | `<details>⏎<summary>T</summary>⏎⏎- a⏎- b⏎⏎</details>⏎`                   | `<details>⏎<summary>T</summary>⏎- a⏎</details>⏎`                         |
| `columns`                           | §12.6   | `<!-- memry:columns -->⏎<div data-column-list>⏎<div data-column>⏎⏎a⏎⏎</` | `<div data-column>⏎⏎a⏎⏎</div>⏎`                                          |
| `align-marker-center`               | §12.6   | `<!-- align:center -->⏎text⏎`                                            | `<!-- align:middle -->⏎text⏎`                                            |
| `align-marker-right`                | §12.6   | `<!-- align:right -->⏎text⏎`                                             | `<!-- align:right-->⏎text⏎`                                              |
| `align-marker-justify`              | §12.6   | `<!-- align:justify -->⏎text⏎`                                           | `<!--align:justify-->⏎text⏎`                                             |
| `align-marker-heading`              | §12.6   | `<!-- align:center -->⏎# H⏎`                                             | `<!-- align:center -->⏎⏎⏎# H⏎`                                           |
| `align-marker-orphan`               | §12.6   | `<!-- align:center -->⏎`                                                 | `<!-- align:center --> trailing⏎`                                        |
| `colors-marker`                     | §12.6   | `<!-- colors:{"textColor":"red"} -->⏎text⏎`                              | `<!-- colors:{"textColor":} -->⏎text⏎`                                   |
| `colors-marker-background`          | §12.6   | `<!-- colors:{"backgroundColor":"blue"} -->⏎# H⏎`                        | `<!-- colors: -->⏎# H⏎`                                                  |
| `link-card-marker`                  | §12.6   | `<!-- link-card:{"display":"card"} -->⏎[a](https://example.com)⏎`        | `<!-- link-card:{"display":"card" -->⏎[a](https://example.com)⏎`         |
| `block-nesting-marker`              | §12.6   | `<!-- memry:block-nesting-level=1 -->⏎text⏎`                             | `<!-- memry:block-nesting-level=x -->⏎text⏎`                             |
| `view-block`                        | §12.6   | `'''memry-view⏎{"query":"x"}⏎'''⏎`                                       | `'''memry-views⏎{"query":"x"}⏎'''⏎`                                      |
| `portal-block`                      | §12.6   | `'''memry-portal⏎{"noteId":"n1"}⏎'''⏎`                                   | `'''memry-portal extra⏎{}⏎'''⏎`                                          |
| `html-block`                        | §12.6   | `<div>raw</div>⏎`                                                        | `<div>raw⏎`                                                              |
| `html-block-figure`                 | §12.6   | `<figure><img src="a.png" alt="a"><figcaption>c</figcaption></figure>⏎`  | `<figure>⏎`                                                              |
| `html-comment-block`                | §12.6   | `<!-- note -->⏎⏎text⏎`                                                   | `<!-- note⏎⏎text⏎`                                                       |
| `html-comment-multiline`            | §12.6   | `<!--⏎line⏎⏎break⏎-->⏎⏎text⏎`                                            | `<!--⏎line⏎⏎break⏎`                                                      |
| `percent-comment`                   | §12.6   | `a %%hidden%% b⏎`                                                        | `a %%unclosed b⏎`                                                        |
| `blank-lines`                       | §12.6   | `a⏎⏎⏎⏎b⏎`                                                                | `a⏎⏎b⏎`                                                                  |
| `crlf`                              | §12.6   | `a␍⏎␍⏎b␍⏎`                                                               | `a␍b␍`                                                                   |
| `empty-body`                        | §12.6   | ``                                                                       | `⏎⏎`                                                                     |
| `frontmatter`                       | §12.6   | `---⏎title: T⏎---⏎body⏎`                                                 | `---⏎title: T⏎body⏎`                                                     |
| `frontmatter-empty`                 | §12.6   | `---⏎---⏎body⏎`                                                          | `--- ⏎---⏎body⏎`                                                         |
| `frontmatter-crlf`                  | §12.6   | `---␍⏎title: T␍⏎---␍⏎body␍⏎`                                             | `---␍⏎title: T␍⏎--␍⏎body␍⏎`                                              |
| `frontmatter-bom`                   | §12.6   | `﻿---⏎title: T⏎---⏎body⏎`                                                 | `﻿⏎---⏎title: T⏎---⏎`                                                     |
| `frontmatter-unicode-title`         | §12.6   | `---⏎title: Çay ☕⏎---⏎body⏎`                                            | `---⏎title: [unclosed⏎---⏎body⏎`                                         |
| `bold`                              | §12.7   | `**b**⏎`                                                                 | `** b**⏎`                                                                |
| `bold-underscore`                   | §12.7   | `__b__⏎`                                                                 | `__ b__⏎`                                                                |
| `italic`                            | §12.7   | `*i*⏎`                                                                   | `* i*⏎`                                                                  |
| `italic-underscore`                 | §12.7   | `_i_⏎`                                                                   | `snake_case_word⏎`                                                       |
| `bold-italic`                       | §12.7   | `***bi***⏎`                                                              | `***bi*⏎`                                                                |
| `strike`                            | §12.7   | `~~s~~⏎`                                                                 | `~~ s~~⏎`                                                                |
| `inline-code`                       | §12.7   | `'code'⏎`                                                                | `'code⏎`                                                                 |
| `inline-code-double`                | §12.7   | `'' a'b ''⏎`                                                             | `'' a'b '⏎`                                                              |
| `inline-code-spaces`                | §12.7   | `'  a  '⏎`                                                               | `' '⏎`                                                                   |
| `underline`                         | §12.7   | `<u>u</u>⏎`                                                              | `<u>u⏎`                                                                  |
| `highlight`                         | §12.7   | `==h==⏎`                                                                 | `== h==⏎`                                                                |
| `superscript`                       | §12.7   | `x<sup>2</sup>⏎`                                                         | `x<sup>2⏎`                                                               |
| `subscript`                         | §12.7   | `H<sub>2</sub>O⏎`                                                        | `H<sub>2⏎`                                                               |
| `text-color`                        | §12.7   | `<span style="color: red">t</span>⏎`                                     | `<span style="color:">t</span>⏎`                                         |
| `background-color`                  | §12.7   | `<span style="background-color: yellow">t</span>⏎`                       | `<span style="background-color">t</span>⏎`                               |
| `link`                              | §12.7   | `[t](https://example.com)⏎`                                              | `[t] (https://example.com)⏎`                                             |
| `link-title`                        | §12.7   | `[t](https://example.com "T")⏎`                                          | `[t](https://example.com T)⏎`                                            |
| `link-angle`                        | §12.7   | `[t](<a b>)⏎`                                                            | `[t](<a b)⏎`                                                             |
| `link-parens`                       | §12.7   | `[t](https://e.com/a_(b))⏎`                                              | `[t](https://e.com/a_(b)⏎`                                               |
| `link-reference`                    | §12.7   | `[t][r]⏎⏎[r]: https://example.com⏎`                                      | `[t][r]⏎`                                                                |
| `link-reference-title`              | §12.7   | `[t][r]⏎⏎[r]: https://example.com "T"⏎`                                  | `[r]: ⏎`                                                                 |
| `link-autolink`                     | §12.7   | `<https://example.com>⏎`                                                 | `<https://example.com⏎`                                                  |
| `link-bare`                         | §12.7   | `see https://example.com/a now⏎`                                         | `see https:// now⏎`                                                      |
| `link-in-code`                      | §12.7   | `'[t](u)'⏎`                                                              | `['t'](u)⏎`                                                              |
| `link-hard-break`                   | §12.7   | `[one  ⏎two](https://example.com)⏎`                                      | `[one\⏎two](u)⏎`                                                         |
| `wiki-link`                         | §12.7   | `[[Target]]⏎`                                                            | `[[Target]⏎`                                                             |
| `wiki-link-alias`                   | §12.7   | `[[Target\|alias]]⏎`                                                     | `[[Target\|]]⏎`                                                          |
| `wiki-link-empty`                   | §12.7   | `[[]]⏎`                                                                  | `[[ ]]⏎`                                                                 |
| `wiki-link-in-code`                 | §12.7   | `'[[Target]]'⏎`                                                          | `[ [Target]]⏎`                                                           |
| `hash-tag`                          | §12.7   | `#tag⏎⏎text #tag-two⏎`                                                   | `#⏎⏎# ⏎`                                                                 |
| `hash-tag-digits`                   | §12.7   | `a #2024 b⏎`                                                             | `a#tag⏎`                                                                 |
| `date-mention`                      | §12.7   | `((date:2026-01-02))⏎`                                                   | `((date:2026 01))⏎`                                                      |
| `date-mention-range`                | §12.7   | `((date:2026-01-02;2026-01-05))⏎`                                        | `((date:))⏎`                                                             |
| `link-mention`                      | §12.7   | `((mention:https%3A%2F%2Fexample.com))⏎`                                 | `((mention:))⏎`                                                          |
| `inline-image`                      | §12.7   | `text ![a](a.png) more⏎`                                                 | `text !\[a](a.png) more⏎`                                                |
| `inline-image-width`                | §12.7   | `text ![a\|20](a.png) more⏎`                                             | `text ![a\|](a.png) more⏎`                                               |
| `inline-checkbox`                   | §12.7   | `\| a \|⏎\| - \|⏎\| [ ] x \|⏎`                                           | `\| a \|⏎\| - \|⏎\| [] x \|⏎`                                            |
| `html-comment-inline`               | §12.7   | `a <!-- hidden --> b⏎`                                                   | `a <!- hidden --> b⏎`                                                    |
| `html-comment-in-code`              | §12.7   | `use '<!-- x -->' here⏎`                                                 | `use <!-- x here⏎`                                                       |
| `html-comment-in-link`              | §12.7   | `[a <!-- c --> b](u)⏎`                                                   | `[a <!-- c b](u)⏎`                                                       |
| `html-comment-in-table`             | §12.7   | `\| a \| b \|⏎\| - \| - \|⏎\| x <!-- c --> \| y \|⏎`                     | `\| a \| b \|⏎\| - \| - \|⏎\| x <!-- c \| y \|⏎`                         |
| `html-comment-bold`                 | §12.7   | `**a <!-- b --> c**⏎`                                                    | `**a <!-- b c**⏎`                                                        |
| `escape-star`                       | §12.7   | `a \* b⏎`                                                                | `a * b⏎`                                                                 |
| `escape-bracket`                    | §12.7   | `\[a\](b)⏎`                                                              | `\[a](b)⏎`                                                               |
| `escape-backtick`                   | §12.7   | `a \' b⏎`                                                                | `a ' b⏎`                                                                 |
| `escape-hash`                       | §12.7   | `\# no⏎`                                                                 | `\#no⏎`                                                                  |
| `escape-pipe-in-table`              | §12.7   | `\| a \\                                                                 | b \|⏎\| - \|⏎\| 1 \|⏎`                                                   | `\| a \\\| b \|⏎\| - \|⏎\| 1 \|⏎`   |
| `entity-amp`                        | §12.7   | `a &amp; b⏎`                                                             | `a &ampx b⏎`                                                             |
| `entity-numeric`                    | §12.7   | `&#65;&#x42;⏎`                                                           | `&#x;⏎`                                                                  |
| `emoji`                             | §12.7   | `a 😀 b⏎`                                                                | `a � b⏎`                                                                 |
| `cjk`                               | §12.7   | `日本語の文章 **強調**⏎`                                                 | `日本語**強調 ⏎`                                                         |
| `combining-marks`                   | §12.7   | `é ä⏎`                                                                   | `́⏎`                                                                      |
| `rtl`                               | §12.7   | `مرحبا **بالعالم**⏎`                                                     | `مرحبا ** بالعالم**⏎`                                                    |
| `non-ascii-writing-run`             | §12.7   | `çay <!--ghost-->x<!--/ghost--> ☕⏎`                                     | `çay <!--ghost-->x ☕⏎`                                                  |
| `critic-addition`                   | §12.8   | `a {++add++} b⏎`                                                         | `a {++add b⏎`                                                            |
| `critic-deletion`                   | §12.8   | `a {--del--} b⏎`                                                         | `a {--del-} b⏎`                                                          |
| `critic-substitution`               | §12.8   | `a {~~old~>new~~} b⏎`                                                    | `a {~~old~new~~} b⏎`                                                     |
| `critic-comment`                    | §12.8   | `a {>>note<<} b⏎`                                                        | `a {>>note} b⏎`                                                          |
| `critic-highlight`                  | §12.8   | `a {==hi==} b⏎`                                                          | `a {==hi=} b⏎`                                                           |
| `critic-in-code`                    | §12.8   | `'{++a++}'⏎`                                                             | `{ ++a++ }⏎`                                                             |
| `critic-in-fence`                   | §12.8   | `'''⏎{++a++}⏎'''⏎`                                                       | `    {++a++}⏎`                                                           |
| `critic-nested-marks`               | §12.8   | `{++**b**++}⏎`                                                           | `{++**b++}**⏎`                                                           |
| `writing-ghost`                     | §12.8   | `a <!--ghost-->g<!--/ghost--> b⏎`                                        | `a <!--ghost--> b⏎`                                                      |
| `writing-alt`                       | §12.8   | `a <!--alt:k1-->x<!--/alt:k1--> b⏎`                                      | `a <!--alt:-->x<!--/alt:--> b⏎`                                          |
| `writing-ghost-unclosed`            | §12.8   | `<!--ghost-->g<!--/ghost-->⏎`                                            | `<!--/ghost-->g<!--ghost-->⏎`                                            |
| `writing-in-code`                   | §12.8   | `'<!--ghost-->'⏎`                                                        | `<!-- ghost -->⏎`                                                        |
| `writing-in-fence`                  | §12.8   | `'''⏎<!--ghost-->⏎'''⏎`                                                  | `<!--ghost-->⏎`                                                          |
| `source-spelling-bullet`            | §12.8   | `* a⏎* b⏎`                                                               | `*a⏎`                                                                    |
| `source-spelling-emphasis`          | §12.8   | `__a__ and *b*⏎`                                                         | `__ a__⏎`                                                                |
| `source-spelling-heading-setext`    | §12.8   | `Title⏎=====⏎`                                                           | `Title⏎=⏎`                                                               |
| `source-spelling-setext-2`          | §12.8   | `Title⏎-----⏎`                                                           | `Title⏎--⏎`                                                              |
| `source-spelling-hr`                | §12.8   | `***⏎`                                                                   | `* *⏎`                                                                   |
| `source-spelling-ordered`           | §12.8   | `1) a⏎2) b⏎`                                                             | `1)a⏎`                                                                   |
| `source-spelling-blank-gaps`        | §12.8   | `a⏎⏎⏎⏎b⏎`                                                                | `a⏎⏎⏎b⏎`                                                                 |
| `source-spelling-fence-tilde`       | §12.8   | `~~~js⏎x⏎~~~⏎`                                                           | `~~js⏎x⏎~~⏎`                                                             |
| `source-spelling-trailing-ws`       | §12.8   | `a  ⏎b	⏎`                                                               | `a ⏎b⏎`                                                                  |
| `source-spelling-no-final-newline`  | §12.8   | `a⏎⏎b`                                                                   | `a⏎⏎b⏎⏎`                                                                 |
| `source-spelling-crlf`              | §12.8   | `a␍⏎␍⏎b␍⏎`                                                               | `a␍⏎b⏎␍⏎`                                                                |
| `frontmatter-keys-order`            | §12.8   | `---⏎z: 1⏎a: 2⏎---⏎body⏎`                                                | `---⏎z: 1⏎a: 2⏎body⏎`                                                    |
| `frontmatter-writing`               | §12.8   | `---⏎writing:⏎  alt: []⏎---⏎body⏎`                                       | `---⏎writing: [⏎---⏎body⏎`                                               |
| `code-fence-lang-js`                | §12.6   | `'''js⏎x⏎'''⏎`                                                           | `'''js 'x⏎x⏎'''⏎`                                                        |
| `code-fence-lang-python`            | §12.6   | `'''python⏎x⏎'''⏎`                                                       | `'''python 'x⏎x⏎'''⏎`                                                    |
| `code-fence-lang-cpp`               | §12.6   | `'''cpp⏎x⏎'''⏎`                                                          | `'''cpp 'x⏎x⏎'''⏎`                                                       |
| `code-fence-lang-csharp`            | §12.6   | `'''csharp⏎x⏎'''⏎`                                                       | `'''csharp 'x⏎x⏎'''⏎`                                                    |
| `code-fence-lang-shell-session`     | §12.6   | `'''shell-session⏎x⏎'''⏎`                                                | `'''shell-session 'x⏎x⏎'''⏎`                                             |
| `code-fence-lang-memry-view`        | §12.6   | `'''memry-view⏎x⏎'''⏎`                                                   | `'''memry-view 'x⏎x⏎'''⏎`                                                |
| `bullet-depth-2`                    | §12.6   | `- l0⏎  - l1⏎`                                                           | `- l0⏎ - l1⏎`                                                            |
| `quote-depth-2`                     | §12.6   | `> > x⏎`                                                                 | `>>x⏎`                                                                   |
| `bullet-depth-3`                    | §12.6   | `- l0⏎  - l1⏎    - l2⏎`                                                  | `- l0⏎ - l1⏎  - l2⏎`                                                     |
| `quote-depth-3`                     | §12.6   | `> > > x⏎`                                                               | `>>>x⏎`                                                                  |
| `bullet-depth-5`                    | §12.6   | `- l0⏎  - l1⏎    - l2⏎      - l3⏎        - l4⏎`                          | `- l0⏎ - l1⏎  - l2⏎   - l3⏎    - l4⏎`                                    |
| `quote-depth-5`                     | §12.6   | `> > > > > x⏎`                                                           | `>>>>>x⏎`                                                                |
| `table-cell-b`                      | §12.6   | `\| a \|⏎\| - \|⏎\| **b** \|⏎`                                           | `\| a \|⏎\| - \|⏎\| **b**⏎`                                              |
| `table-cell-c`                      | §12.6   | `\| a \|⏎\| - \|⏎\| 'c' \|⏎`                                             | `\| a \|⏎\| - \|⏎\| 'c'⏎`                                                |
| `table-cell-lu`                     | §12.6   | `\| a \|⏎\| - \|⏎\| [l](u) \|⏎`                                          | `\| a \|⏎\| - \|⏎\| [l](u)⏎`                                             |
| `table-cell-s`                      | §12.6   | `\| a \|⏎\| - \|⏎\| ~~s~~ \|⏎`                                           | `\| a \|⏎\| - \|⏎\| ~~s~~⏎`                                              |
| `table-cell-h`                      | §12.6   | `\| a \|⏎\| - \|⏎\| ==h== \|⏎`                                           | `\| a \|⏎\| - \|⏎\| ==h==⏎`                                              |
| `table-cell-uuu`                    | §12.6   | `\| a \|⏎\| - \|⏎\| <u>u</u> \|⏎`                                        | `\| a \|⏎\| - \|⏎\| <u>u</u>⏎`                                           |
| `table-cell-w`                      | §12.6   | `\| a \|⏎\| - \|⏎\| [[w]] \|⏎`                                           | `\| a \|⏎\| - \|⏎\| [[w]]⏎`                                              |
| `table-cell-tag`                    | §12.6   | `\| a \|⏎\| - \|⏎\| #tag \|⏎`                                            | `\| a \|⏎\| - \|⏎\| #tag⏎`                                               |
| `inline-mark-bold-around-link`      | §12.7   | `**[t](u)**⏎`                                                            | `**[t](u)⏎`                                                              |
| `inline-mark-bold-around-wiki`      | §12.7   | `**[[w]]**⏎`                                                             | `**[[w]⏎`                                                                |
| `inline-mark-italic-around-link`    | §12.7   | `*[t](u)*⏎`                                                              | `*[t](u)⏎`                                                               |
| `inline-mark-italic-around-wiki`    | §12.7   | `*[[w]]*⏎`                                                               | `*[[w]⏎`                                                                 |
| `inline-mark-strike-around-link`    | §12.7   | `~~[t](u)~~⏎`                                                            | `~~[t](u)⏎`                                                              |
| `inline-mark-strike-around-wiki`    | §12.7   | `~~[[w]]~~⏎`                                                             | `~~[[w]⏎`                                                                |
| `inline-mark-highlight-around-link` | §12.7   | `==[t](u)==⏎`                                                            | `==[t](u)⏎`                                                              |
| `inline-mark-highlight-around-wiki` | §12.7   | `==[[w]]==⏎`                                                             | `==[[w]⏎`                                                                |
| `inline-mark-code-around-link`      | §12.7   | `'[t](u)'⏎`                                                              | `'[t](u)⏎`                                                               |
| `inline-mark-code-around-wiki`      | §12.7   | `'[[w]]'⏎`                                                               | `'[[w]⏎`                                                                 |

## 12.9 The type registry FR-040 enumerates

**Normative.** `createMemrySchema` produces exactly **39** types
(`packages/editor-schema/src/schema.ts:52-77`), checked in as
`packages/editor-schema/src/registry-manifest.json` and asserted in both
directions by `packages/editor-schema/src/__tests__/registry-parity.test.ts`.

| Group          | Count | Types                                                                                                                                                                                                                                                                                          |
| -------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blocks         |    23 | `audio`, `bookmark`, `bulletListItem`, `callout`, `checkListItem`, `codeBlock`, `column`, `columnList`, `diagram`, `divider`, `file`, `heading`, `image`, `mathBlock`, `numberedListItem`, `paragraph`, `quote`, `table`, `taskBlock`, `toggleListItem`, `video`, `whiteboard`, `youtubeEmbed` |
| inline content |     9 | `dateMention`, `hashTag`, `htmlComment`, `inlineCheckbox`, `inlineImage`, `link`, `linkMention`, `text`, `wikiLink`                                                                                                                                                                            |
| styles         |     7 | `backgroundColor`, `bold`, `code`, `italic`, `strike`, `textColor`, `underline`                                                                                                                                                                                                                |

`file` and `toggleListItem` are Memry specifications overriding BlockNote
defaults of the same name
(`packages/editor-schema/src/schema.ts:57-61`, where `impl.blocks` is spread over
`defaultBlockSpecs`).

`checkListItem` is BlockNote's own with one prop added, `plain` (boolean,
default `false`, `packages/editor-schema/src/blocks/plain-checkbox.ts`). A plain
checkbox is one the user keeps as a checkbox: a client that turns checkboxes
into tasks MUST skip it (desktop `scan-task-intents.ts`, the core's
`conversion_candidates`). A writer emits `plain=false` like every other
declared default. A reader built before the prop existed ignores the attribute
rather than deleting the node, so the only cost of an old client is that it
converts the line into a task, as it did every checkbox. On disk the flag is the
`{check}` marker (§12.6); a markdown seed that does not strip it MUST fall back
for that line rather than keep the marker as text.

`diagram` is a Mermaid diagram, and it is the one type whose renderer spec comes
from a third-party package (`@blocknote/diagram-block`) rather than from
`@memry/editor-schema`. Its config is restated in
`packages/editor-schema/src/blocks/configs.ts` for the main process, which
cannot carry the package's React and ~3 MB of mermaid; the two are held equal
by the renderer↔main parity gate
(`apps/desktop/src/renderer/src/components/note/content-area/editor-schema.test.ts`),
which compares every block's config field by field.

**On disk a diagram is a ` ```mermaid ` fence and nothing else** — no marker, no
sidecar comment. A client that does not implement the type reads the fence back
as a plain `codeBlock` whose language is `mermaid` and writes the same bytes out
again, so the block degrades to a code block rather than to nothing. The reverse
also holds: a ` ```mermaid ` fence written by Obsidian, GitHub or an older Memry
build opens as a diagram, because the parse rule runs before `codeBlock`'s
(`packages/editor-schema/src/blocks/server-specs.ts`, `diagramParsing`).

A diagram's source is LITERAL text (`content: 'plain'`, `meta.code`), so the
markdown-parse repairs that strip the pretty-printer's indentation out of prose
skip it, exactly as they skip a code block
(`packages/editor-schema/src/parse-markdown.ts`, `LITERAL_TEXT_BLOCK_TYPES`).

`whiteboard` holds a REFERENCE, not a drawing: its only prop is `canvasId`, and
the ink lives in the canvas's own `canvases/<Title>.excalidraw` file, synced as a
canvas item. One canvas may be embedded by any number of notes. A client that
does not draw canvases MUST still build the node (y-prosemirror deletes a node
its schema cannot build, and the delete replicates) and MUST write back the
§12.6 marker unchanged.

`columnList` and `column` lay blocks out side by side. A `columnList` holds two
or more `column`s and nothing else; a `column` holds blocks and carries `width`
(number, default `1`, a flex-grow weight). The node names, groups, content
expressions and `width` are `@blocknote/xl-multi-column`'s, restated headless in
`packages/editor-schema/src/blocks/column-specs.ts` so the main process builds
them without React; the desktop renderer swaps in the
package's `column` spec for resize and drag-to-column. `columnList` adds
`regionId` and `settings` (strings, default `''`).

**On disk a column list is a Multi-Column Markdown region**, the syntax of
Obsidian's Multi-Column Markdown plugin
(`packages/editor-schema/src/blocks/columns.ts`):

````
--- start-multi-column: <regionId>
```column-settings
Number of Columns: 2
Column Size: [25%, 75%]
```

<column 1 blocks>

--- end-column ---

<column 2 blocks>

--- end-multi-column
````

A reader MUST accept every spelling the plugin accepts (`multi-column-start`,
`column-end` / `column-break` / `break-column`, `multi-column-end`, the `===`
forms, the `settings` and `multi-column-settings` fence names) and Pandoc
fenced divs (`::: columns` … `::: columnbreak` / `:::` … `:::`). Writers emit
the form above only. `settings` holds the fence verbatim and is written back
byte-for-byte while its column count and sizes still match the columns; a
resize or a column added or removed rewrites those two lines and keeps every
other. A region with no id is given one derived from the block id on first
write. A region that is unterminated or has a single column stays markdown.
A client built before these types DELETES them on load (§12.1), so their
introduction is paired with a write-version floor (chapter 11).

**The registration invariant**: every spec is registered under its own
`config.type`, enforced at construction for blocks and inline content alike
(`packages/editor-schema/src/schema.ts:74-75`, implementation at
`packages/editor-schema/src/spec-keys.ts:60-71`). A spec keyed `wikilink` under
`wikiLink` is a failed schema build, not a note that quietly loses a wiki link.

**Adding a type to the schema is therefore also an edit to this table, to
`registry-manifest.json` and to spec.md FR-040** (chapter 00 §0.8, obligation 3).

## 12.10 Preserved source and the three-way merge — Q12.3, Q12.4

**These are desktop write-back behaviour. A non-desktop client relies on them but
MUST NOT reproduce them**: `restoreMarkdownSource` and `mergeMarkdownSource` run
only inside desktop main's `yDocToMarkdown`. The core never calls them.

**Normative, as desktop behaviour:**

- `restoreMarkdownSource(canonicalNow, source, canonicalize)` returns `source`
  **untouched** when the canonical form is unchanged
  (`packages/shared/src/markdown-source.ts:71-73`).
- Trailing newlines are trimmed on both sides before comparison, because an open
  editor keeps an empty trailing paragraph (`:66`).
- **A merge is never trusted unproven**: the merged text is re-parsed and used
  only if it canonicalises back to the same canonical form, or to the same text
  the canonical form itself canonicalises to. The second case covers a
  paragraph that ends in a space or a tab, which no parse keeps. Otherwise the
  house style wins (`packages/shared/src/markdown-source.ts:75-85`).
- The merge itself (`:100-148`): line diffs of the source and the canonical form
  against a common base, both computed with `markdownAlignmentKey`
  (`:243-255`, which strips heading, bullet and quote markers, strips `_` and
  `*`, and collapses whitespace); hunks sorted by base position; adjacent hunks
  with no stable base line between them coalesced into one region; then per
  region: ours-only wins ours, theirs-only wins theirs, and **a genuine
  both-sides conflict resolves to _ours_, the house style** (`:139-143`).
- The channel is the `markdownSource` Y.Map root, one key holding
  `{source, htmlComments: true}` (`packages/shared/src/markdown-source.ts:182-191`).
  Builds before #2741 wrote `{source}` alone, and their parse dropped every HTML
  comment from the document, so desktop reads a record without `htmlComments`
  with comments dropped too (`apps/desktop/src/main/sync/blocknote-converter.ts:225-231`).
  The write is skipped when the value is already identical, so no spurious Y
  update (`:189`). Recording is budgeted at
  `MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES = floor(NOTE_SYNC_MAX_BYTES / 2)`
  (`apps/desktop/src/main/sync/blocknote-converter.ts:505`).

**Q12.3 — the conflict rule.** A user's hand-written formatting loses to the
house style. **This is correct and frozen as desktop behaviour. A second
implementation is NOT required to reproduce the diff or the alignment key**,
because it never runs the merge.

**Q12.4 — `MAX_EDIT_DISTANCE = 2000`** aborts the whole merge with `null`
(`packages/shared/src/markdown-source.ts:228`, applied at `:110`, `:290`), which
falls back to house style. **It is one writer's implementation budget, not a
protocol constant.** A client MUST NOT model it, and desktop MAY change it
without a protocol change.

**Disposition of Q12.3: answered (desktop write-back behaviour; the core never
merges). Disposition of Q12.4: answered (an implementation budget of one writer,
not a protocol constant).**

## 12.11 The cross-shell digest SC-010 compares

**Normative**, defined here rather than left to each harness:

| Item                     | Digest                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------ |
| a note                   | SHA-256 over the UTF-8 bytes of `title + "\n" + extract_text(doc)`                   |
| a task or journal record | SHA-256 over the canonical JSON (chapter 06 §6.4.2) of that record's syncable fields |

`extract_text`'s rules are §12.1.3 and its bytes are pinned by the
`text-extract.json` vector class, so two ports are held to the same output
before any digest is compared and **a mismatch means the content differs rather
than the extractors differing**. Note §12.1.3.1: the extractors agree on
dropping literal angle brackets, so a digest match does not prove the note's
text survived intact — only that both shells lost the same bytes.
