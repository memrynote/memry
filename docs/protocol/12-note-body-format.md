# 12 — The note body format

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

This is the chapter FR-041 and SC-010 rest on. A body written by one client and
read by another must be byte-identical where this chapter says it is.

## 12.1 Who converts markdown — Q12.2

**Normative. Markdown-to-document and document-to-markdown both run inside the
editor bundle. A non-editor client never parses and never serialises BlockNote
markdown.**

"The editor bundle" means **a WebView on mobile and a headless editor in the
Electron main process on desktop**
(`apps/desktop/src/main/sync/blocknote-converter.ts:1` (`ServerBlockNoteEditor`), `:99-106`). It is
**not** "the WebView" in general.

The two directions:

| Direction                                  | Mechanism                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| markdown → document, **verbatim**          | the optional `seedMarkdown` field on the `doc-load` message, applied by the guest **only when the document is genuinely empty**                                                                                    |
| markdown → document, **frontmatter split** | the `seed-from-markdown` message, answered by `markdown-seed`                                                                                                                                                      |
| document → markdown                        | the `export-markdown` message, answered by `markdown-export`                                                                                                                                                       |
| document → plain text                      | `extract_text`, the **only** text operation a non-editor client owns: a plain-text walk of the `prosemirror` fragment that keeps headings and list markers, drops everything else, and claims no markdown fidelity |

#### 12.1.0 There are two markdown → document paths, and they differ deliberately

An earlier revision of this chapter said "**there is no `seed-from-markdown`
message** … that name is a proposed rename". That was true when it was written
and is **no longer true**: the message exists, and it is not a rename of
`doc-load.seedMarkdown` — both paths are live and they behave differently on
purpose.

|             | `doc-load.seedMarkdown`                      | `seed-from-markdown`                   |
| ----------- | -------------------------------------------- | -------------------------------------- |
| frontmatter | **not split** — the input is parsed verbatim | **split off and discarded**            |
| when        | a document is opened and is genuinely empty  | note creation and template application |
| answered by | nothing; it rides on `doc-load`              | `markdown-seed`                        |

**Why the new path discards frontmatter rather than reading it.** A new note's
`tags` and `properties` come from the note record, which the core has already
written (chapter 13 §13.7.1, §13.7.6). A guest that re-derived them from the
frontmatter block would be a second source of truth for the same two fields,
disagreeing with the record the moment the two were written from different
inputs. The core still does no markdown handling at all — **frontmatter
included** — because the split happens in the bundle.

**Both messages are additive at `BRIDGE_PROTOCOL_VERSION` 1.** Adding a member
to a discriminated union cannot change how an existing message parses, so a host
that never sends `seed-from-markdown` behaves exactly as it did.

**A parse failure MUST NOT be reported as an empty document.** `markdown-seed`
carries a three-way result — `seeded`, `skipped` with a reason, or `error` with a
non-empty detail — and the document is left untouched on either throw. The
distinction is load-bearing rather than cosmetic: the host clears
`note_bodies.seed_markdown` on `seeded` and `skipped` and **keeps** it on
`error`, and until a seed lands that column is the only copy of what the user
asked for (data-model §A.3). A request naming a document that is not mounted is
**answered** with an error rather than met with silence, because silence strands
that lifecycle with no way to tell "not yet" from "never".

### 12.1.1 The guest does not run desktop's pipeline

**Normative, and a client MUST NOT assume otherwise.** The guest calls
BlockNote's `tryParseMarkdownToBlocks` and `blocksToMarkdownLossy`
(`packages/editor-web/src/markdown-bridge.ts`) and **nothing else**: no
critic-markup strip, no link-reference strip, no inline-colour masking, no
source record.

**The one exception is the frontmatter split, and only on `seed-from-markdown`.**
That path calls the shared splitter (`packages/shared/src/frontmatter-split.ts`)
before handing the body to BlockNote. `doc-load.seedMarkdown` still splits
nothing — it parses its input verbatim — and §12.1.0 tabulates the difference.
The splitter is shared rather than reimplemented: it moved to `@memry/shared`
unchanged so the bundle can import it without pulling in gray-matter, and
`@memry/app-core` re-exports it, so there is exactly one implementation in the
tree.

Desktop additionally runs, inbound, `prepareFragmentSeed` → `applyFragmentSeed`
(`apps/desktop/src/main/sync/blocknote-converter.ts:462-475`) and
`recordMarkdownSourceInYDoc` (`:477-491`, `:517-541`); and outbound,
`blocksToMarkdownPreserving` + `restoreLinkReferences` (`:236-238`) +
`restoreMarkdownSource` (`:161`) + `serializeCriticMarkup`
(`apps/desktop/src/main/sync/crdt-writeback.ts:459-466`).

Block and inline **specs** are shared
(`packages/editor-web/src/blocks.ts:20-27`), so the block grammar of §12.6 and
§12.7 matches. **The out-of-band layer of §12.8 does not.**

### 12.1.2 What this means for a non-editor client

**Normative.** Such a client:

- MUST NOT parse or serialise BlockNote markdown;
- MUST route note creation, duplication and template application through the
  editor bundle;
- owns `extract_text` and nothing else;
- needs **no markdown grammar and no BlockNote block model**;
- MUST preserve the Y.Doc roots of §12.5 exactly across an apply-then-encode
  cycle. That, not a markdown grammar, is its whole obligation here.

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

## 12.2 FR-041 holds structurally, with three carve-outs

**The structural argument.** A non-desktop client never writes a vault file;
desktop is the only writer; and desktop writes from the Y.Doc
(`apps/desktop/src/main/sync/crdt-writeback.ts:459-466`, `:552-560`).
`restoreMarkdownSource` returns the source untouched when `ours === base`
(`packages/shared/src/markdown-source.ts:68`),
`serializeParsedMarkdownNote` re-emits the raw frontmatter block and the body
verbatim when unedited (`packages/app-core/src/markdown.ts:62-68`), and
`writebackExisting` skips the write entirely when the bytes match
(`apps/desktop/src/main/sync/crdt-writeback.ts:563-566`).

**Three carve-outs a client MUST know:**

- **Carve-out A — a non-desktop client's markdown does reach disk on create and
  duplicate.** A note record push carries `content` only on `create`
  (`apps/desktop/src/main/sync/item-handlers/note-handler-sync-helpers.ts:50-56`),
  and the reference phone's `createNote` is "the ONE operation that carries the
  body in the record payload"
  (`apps/mobile/src/features/notes/note-ops.ts:221-223`). `duplicateNote` sets
  `content` from the guest's `blocksToMarkdownLossy` output
  (`apps/mobile/src/features/notes/note-ops.ts:361`), and desktop writes a new
  remote note's file as `serializeNote(frontmatter, data.content)`
  (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:598-609`).
  **So "a client that cannot serialise markdown cannot write a vault file" is
  false as stated: the invariant is scoped to _existing_ notes, and the
  create-time `content` path is the exception.**
- **Carve-out B — a tag or property edit regenerates frontmatter**
  (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:353-371`,
  `:400-420`). See §12.4.
- **Carve-out C — a non-empty `criticMarkupMarks` disables source restoration**
  (`apps/desktop/src/main/sync/blocknote-converter.ts:158`), so a note carrying
  suggestions is **never** byte-identical after any write-back, on any client.

**Core obligation.** The `content` a client puts in a create record becomes vault
bytes verbatim on desktop. Prefer sending `content: ''` on create unless seeding
from a template, and prefer copying the Y.Doc on duplicate
(`apps/mobile/src/editor/clone-y-subtree.ts:12-18` establishes "the host copies,
it never builds"), using `content` only as a fallback.

**Open, and recorded as such: whether the guest's `blocksToMarkdownLossy` output
is acceptable as create-time `content` is undefined.** The guest serialiser does
no colour masking, no link-reference restore and no critic serialisation
(§12.1.1), and **no test pins it against
`packages/editor-schema/src/conformance.ts`** — the corpus is asserted only by
the two desktop suites. Until either the corpus is added to the editor-web suite
or a normative rule is written, **create-time `content` is best-effort and the
Y.Doc pushed alongside is authoritative. Do not rely on create-time `content`
being canonical.**

## 12.3 The body fragment and document ids

**Normative.** The body is an `XmlFragment` named **`prosemirror`**, declared
twice with the same value: `CRDT_FRAGMENT_NAME`
(`packages/contracts/src/ipc-crdt.ts:57`, pinned by
`packages/contracts/src/ipc-crdt.test.ts:38`) and `BRIDGE_FRAGMENT_NAME`
(`packages/contracts/src/webview-bridge.ts:35`). Its layout is what
y-prosemirror gives a BlockNote document.

**Document ids are bare.** Desktop keys every Y.Doc by the bare note id, with no
namespace prefix (`apps/desktop/src/main/sync/crdt-provider.ts:1106`, `:1347`).
Journal documents are keyed by the journal record's id (chapter 07 §7.1).

**The two-namespace local update log** — `<docId>` for server sequence numbers,
`local.<docId>` for local ones
(`apps/mobile/src/editor/session.ts:27`, `:35-40`) — **is a storage convention
invented by one client, not a protocol fact.** A conforming client MAY choose any
local storage layout.

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

**Normative** (`packages/app-core/src/markdown.ts:54-74`):

- unless the frontmatter was edited, **the original raw block is re-emitted
  verbatim** (`:86-88`), which is what preserves comments, key order, quoting, CR
  bytes and the BOM;
- if the body is unchanged **it too is emitted verbatim** (`:90-92`);
- an edited body has its EOLs converted to the file's dominant EOL and the file's
  final-newline presence re-applied (`:94-96`). **Per-line EOL preservation is
  out of scope by design** (`:75-76`).

New files are written **LF only with a single trailing newline**, and user
content never flows through `matter.stringify`
(`packages/app-core/src/markdown.ts:104-115`).

### 12.4.3 The decision: the only guarantee is the verbatim path

**Decision, 2026-09-13 — option B. This is the normative rule.**

**A frontmatter block that the CRDT tag array, remote tags and remote properties
all left alone is re-emitted byte for byte
(`packages/app-core/src/markdown.ts:62-64`). When any of those alters it, the
block is regenerated and clients MUST NOT depend on key order, quoting style,
comment survival, or scalar spelling. A non-desktop client MUST NOT emit YAML at
all.**

The regenerated order is a composition of JavaScript semantics and js-yaml
defaults, **not a policy**: `stringifyFrontmatterBlock` drops `undefined`, emits
`''` for zero keys, and hands the object to `matter.stringify`
(`packages/app-core/src/markdown.ts:102-111`); gray-matter 4.0.3 does
`Object.assign({}, file.data, data)` and calls `yaml.safeDump`; js-yaml 3.15.1
defaults are `sortKeys: false`, `lineWidth: 80`, `noCompatMode: false`.

Per path:

| Path              | Behaviour                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRDT write-back   | `{ ...existing }` then `merged.tags = yjsTags` (`apps/desktop/src/main/sync/crdt-writeback.ts:949-953`) — existing keys hold position, `tags` is **appended only if absent**. Journal `{ ...existing, date }` (`:966`) behaves the same                                                                                     |
| remote tags       | assignment or `delete` in place (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:357-361`, `:404-408`)                                                                                                                                                                                                            |
| remote properties | `replacePropertiesOnRoot` normalises, deletes every property key, then re-adds them in the **record's** order (`apps/desktop/src/main/vault/frontmatter.ts:414-434`, `:438-449`, `:452-461`). **Editing one property moves every property to the end of the block.**                                                        |
| new file          | `serializeNote` → `normalizePropertiesToRoot` → `writeMarkdownNote` (`apps/desktop/src/main/vault/frontmatter.ts:186-188`, `packages/app-core/src/markdown.ts:107-115`); a remote create builds `{tags?, aliases?, properties?}` in that literal order (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:601-607`) |

**Value re-spelling is part of the same loss.** `parseNote` uses js-yaml
`safeLoad`, so `date: 2026-07-05` becomes a `Date`
(acknowledged at `apps/desktop/src/main/sync/crdt-writeback.ts:983`) and the
dumper re-emits it as `toISOString()`, i.e.
`2026-07-05T00:00:00.000Z`. **Any frontmatter edit rewrites every bare date.**
Comments, quoting style and blank lines survive only on the verbatim path
(`packages/app-core/src/markdown.ts:5-13`).

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

| Root                       | Type                     | Writer                                                                                                                                                                                                  | Reader                                                                                                      | Consequence of dropping it                                                                                                                                                |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prosemirror`              | XmlFragment              | the editor bundle via y-prosemirror; desktop seed at `apps/desktop/src/main/sync/blocknote-converter.ts:193`, `apps/desktop/src/main/sync/crdt-feed.ts:69`                                              | everything                                                                                                  | **the body is lost**                                                                                                                                                      |
| `meta`                     | Map (`title`, `date`)    | `apps/desktop/src/main/sync/crdt-provider.ts:1163-1165`, `:1184-1186`                                                                                                                                   | `apps/desktop/src/main/sync/crdt-writeback.ts:684-685`, `:706`                                              | a remotely created note materialises as `Untitled` with the wrong `createdAt`                                                                                             |
| `tags`                     | Array\<string\>          | `apps/desktop/src/main/sync/crdt-provider.ts:1167-1171`, `apps/desktop/src/main/sync/crdt-feed.ts:93-99`                                                                                                | `apps/desktop/src/main/sync/crdt-writeback.ts:993-1001` → `:950-955`                                        | desktop keeps the file's tags while the array is empty (the `yjsTags.length > 0` guard at `:952`), so a drop is **silent divergence** until a later record push overrides |
| `markdownSource`           | Map (`record: {source}`) | `packages/shared/src/markdown-source.ts:159-167` via `apps/desktop/src/main/sync/blocknote-converter.ts:517-541`, `apps/desktop/src/main/sync/crdt-feed.ts:80`                                          | `apps/desktop/src/main/sync/blocknote-converter.ts:156`, `:161`                                             | foreign-vault bytes are re-spelled to house style on the next write-back: a `git diff` across the user's file, violating FR-041's "change only the edited region"         |
| `linkReferenceDefinitions` | Array                    | `packages/shared/src/link-references.ts:178` via `apps/desktop/src/main/sync/blocknote-converter.ts:470-471`                                                                                            | `packages/shared/src/link-references.ts:187`, `apps/desktop/src/main/sync/blocknote-converter.ts:237-238`   | reference-link definitions are deleted and `[docs][d]` is inlined                                                                                                         |
| `linkReferenceUsages`      | Array                    | same (`packages/shared/src/link-references.ts:179`)                                                                                                                                                     | same (`:191`)                                                                                               | same                                                                                                                                                                      |
| `criticMarkupMarks`        | Array                    | `packages/shared/src/critic-markup/yjs.ts:34-45` via `apps/desktop/src/main/sync/blocknote-converter.ts:469`; renderer `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx:602` | `apps/desktop/src/main/sync/crdt-writeback.ts:466`, `apps/desktop/src/main/sync/blocknote-converter.ts:158` | **every suggestion and comment is deleted from the file on the next write-back, and source restoration flips back on, so the body is additionally re-spelled**            |

Root name constants:
`CRITIC_MARKUP_MARKS_ARRAY = 'criticMarkupMarks'`
(`packages/shared/src/critic-markup/yjs.ts:9`),
`LINK_REFERENCE_DEFINITIONS_ARRAY` and `LINK_REFERENCE_USAGES_ARRAY`
(`packages/shared/src/link-references.ts:158-159`),
`MARKDOWN_SOURCE_MAP = 'markdownSource'`
(`packages/shared/src/markdown-source.ts:142`).

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

The reference clients already do this
(`apps/mobile/src/editor/doc-manager.ts:410`, `:427`;
`apps/desktop/src/main/sync/crdt-provider.ts:433`, `:444`, `:560`, `:712`,
`:820`, `:876`, `:1127`).

**A non-editor client** reads `prosemirror` for `extract_text` and **MUST NOT
delete or normalise other roots as a side effect**. It **MUST NOT** write
`criticMarkupMarks`, `linkReference*` or `markdownSource` — byte-offset marks and
source records are desktop-derived and a client that touches them corrupts them.
It **MAY** write `meta` and `tags` with
`apps/desktop/src/main/sync/crdt-provider.ts:1163-1171` semantics: set-if-absent
on create, whole-array replace on a tag edit
(`apps/desktop/src/main/sync/crdt-feed.ts:96-99`).

The critic-markup reader **drops any element failing shape validation** — `id`,
`kind`, `visibleText`, finite `start <= end`
(`packages/shared/src/critic-markup/yjs.ts:55-66`) — so a client that rewrites
elements MUST keep that shape exactly.

### 12.5.2 The `meta` key set

**Normative: two keys are defined, `title` and `date`
(`apps/desktop/src/main/sync/crdt-provider.ts:1164-1165`, `:1185-1186`). Every
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
(`apps/desktop/src/main/sync/crdt-provider.ts:1039-1044`), so `markdownSource`
and the two `linkReference*` roots are typed only once a seed or a
`yDocToMarkdown` touches them.

Compaction fires via `setImmediate` when the encoded document passes 1 MiB with
no editor open (`apps/desktop/src/main/sync/crdt-provider.ts:1387-1395`,
threshold at `:47-49`) and its output replaces both the pushed snapshot and local
persistence (`:1458`, `:1479-1486`), while write-back is debounced 500 ms
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

| Block            | On-disk form                                                                                                                    | Anchor                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| callout          | `> [!info\|warning\|error\|success]` alone on its line, then one `> ` per non-empty content line                                | `:26`, `:45-50`                |
| structured quote | one `> ` per line, a bare `>` for each blank line between the quote's own blocks                                                | `:165-170`                     |
| youtube embed    | `![embed](videoUrl)`                                                                                                            | `:304`, `:307`                 |
| bookmark         | `![bookmark](url)`                                                                                                              | `:305`, `:311`                 |
| file             | `<!-- file:{…} -->`, an HTML comment with JSON props                                                                            | `:349`, `:358`, `:399`         |
| math             | `$$` alone on its line, the LaTeX source, then `$$`; the body's blank lines are dropped                                         | `:428`, `:440-449`             |
| toggle           | `<details data-memry-toggle>` / `<summary>…</summary>` / blank / body / blank / `</details>`; the expanded variant adds ` open` | `:518`, `:525-526`, `:566-598` |

**Claiming rules matter as much as the forms:**

- the callout marker regex is strict — `> [!note]` and `> [!info] A title` are
  deliberately **not** claimed
  (`packages/editor-schema/src/blocks/markdown.ts:32-36`);
- a run abutting more quote lines is refused whole (`:93`);
- **a run is claimed only by proof**: the body must re-serialise byte for byte
  (`:145`);
- structured quotes refuse a `>text` line and claim only a run that is separated
  or nested (`:220-226`);
- a math run is claimed only when it OWNS its paragraph at both ends and
  `serializeMathBlock` reproduces it byte for byte
  (`packages/editor-schema/src/blocks/markdown.ts:478-496`), so a one-line
  `$$x$$`, an indented fence, a fence with trailing spaces and an unterminated
  one all stay the author's markdown;
- **the file marker's JSON key order is fixed** as `url, name, size, mimeType`,
  then `width` and `height` only when greater than zero and `align` only when set
  and not `left`, so legacy markers stay byte-identical (`:384-399`);
- the comment-terminator escape replaces only the `>` in `-->` and `--!>` with
  `>`, so a filename containing `--` keeps its bytes (`:373`).

## 12.7 Inline grammar

**Normative:**

| Inline type      | On-disk form                                                                     | Anchor                                                            |
| ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `wikiLink`       | `[[target]]`, or `[[target\|alias]]` when the alias differs                      | `packages/editor-schema/src/inline/wiki-link.ts:130-133`          |
| `hashTag`        | `#tag` as a bare span's text                                                     | `packages/editor-schema/src/inline/hash-tag.ts:39-43`             |
| `dateMention`    | `((date:<payload>))`, payload alphabet `[A-Za-z0-9,;_-]`                         | `packages/shared/src/date-mention.ts:32`, `:103`                  |
| `linkMention`    | `((mention:<encoded url>))`                                                      | `packages/editor-schema/src/inline/link-mention.ts:25`, `:50`     |
| `inlineImage`    | `![alt](src)`, width carried in the alt as `alt\|300` with a purely numeric tail | `packages/editor-schema/src/inline/inline-image.ts:85-92`         |
| `inlineCheckbox` | `<input type=checkbox>`-shaped DOM                                               | `packages/editor-schema/src/inline/inline-checkbox.ts:79`, `:112` |

`linkMention` encodes **seven characters beyond `encodeURIComponent`** —
`! ' ( ) * ~ _` — so the token alphabet closes to `[A-Za-z0-9.%-]`
(`packages/editor-schema/src/inline/link-mention.ts:39-48`), with a wider legacy
acceptance union at `:66`.

`wikiLink` style marks nest **outer to inner** as
`bold, italic, underline, strike, code`
(`packages/editor-schema/src/inline/wiki-link.ts:148-154`); `underline` is
chip-only and reaches disk through inline-colour span masking instead (§12.8).

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

## 12.8 The five out-of-band encodings

**Normative.** These live outside plain markdown. Two of them are **in-fragment
encodings**, carried inside `prosemirror`, and three are **sibling roots** — the
two categories are different and MUST NOT be conflated.

**Sibling roots** (all under the §12.5 preservation rule):

| Encoding         | Root                                                                      | Anchor                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| suggestion marks | `criticMarkupMarks`                                                       | `packages/shared/src/critic-markup/yjs.ts:9`; CriticMarkup parser at `packages/shared/src/critic-markup/parser.ts:153` |
| link references  | `linkReferenceDefinitions`, `linkReferenceUsages`; stripped from the body | `packages/shared/src/link-references.ts:158-159`                                                                       |
| preserved source | `markdownSource`                                                          | `packages/shared/src/markdown-source.ts:142`                                                                           |

**In-fragment encodings**, carried inside `prosemirror`, **with no preservation
duty beyond the fragment itself**:

| Encoding       | Form                                                                                                | Anchor                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| inline colours | `MEMRYICO<n>:` / `:MEMRYICC;` tokens masking a `<span style=…>`                                     | `packages/shared/src/inline-colors.ts:72-74`                                                                     |
| block markers  | `<!-- align:… -->`, `<!-- table-layout:{…} -->`, `<!-- colors:{…} -->`, `<!-- table-colors:{…} -->` | `packages/shared/src/block-markers.ts:28`, `:62`; `packages/shared/src/block-colors.ts:11`, `:44`, `:79`, `:131` |

Date mentions (`packages/shared/src/date-mention.ts:32`, `:103`) are likewise
in-fragment, not a root.

## 12.9 The type registry FR-040 enumerates

**Normative.** `createMemrySchema` produces exactly **35** types
(`packages/editor-schema/src/schema.ts:52-77`), checked in as
`packages/editor-schema/src/registry-manifest.json` and asserted in both
directions by `packages/editor-schema/src/__tests__/registry-parity.test.ts`.

| Group          | Count | Types                                                                                                                                                                                                                                                    |
| -------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blocks         |    20 | `audio`, `bookmark`, `bulletListItem`, `callout`, `checkListItem`, `codeBlock`, `diagram`, `divider`, `file`, `heading`, `image`, `mathBlock`, `numberedListItem`, `paragraph`, `quote`, `table`, `taskBlock`, `toggleListItem`, `video`, `youtubeEmbed` |
| inline content |     8 | `dateMention`, `hashTag`, `inlineCheckbox`, `inlineImage`, `link`, `linkMention`, `text`, `wikiLink`                                                                                                                                                     |
| styles         |     7 | `backgroundColor`, `bold`, `code`, `italic`, `strike`, `textColor`, `underline`                                                                                                                                                                          |

`file` and `toggleListItem` are Memry specifications overriding BlockNote
defaults of the same name
(`packages/editor-schema/src/schema.ts:57-61`, where `impl.blocks` is spread over
`defaultBlockSpecs`).

`diagram` is a Mermaid diagram, and it is the one type whose renderer spec comes
from a third-party package (`@blocknote/diagram-block`) rather than from
`@memry/editor-schema`. Its config is restated in
`packages/editor-schema/src/blocks/configs.ts` for the main process and the
mobile WebView, neither of which can carry the package's React and ~3 MB of
mermaid; the two are held equal by the renderer↔main parity gate
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
only inside desktop main's `yDocToMarkdown`. The guest and a non-editor core
never call them.

**Normative, as desktop behaviour:**

- `restoreMarkdownSource(canonicalNow, source, canonicalize)` returns `source`
  **untouched** when the canonical form is unchanged
  (`packages/shared/src/markdown-source.ts:66-68`).
- Trailing newlines are trimmed on both sides before comparison, because an open
  editor keeps an empty trailing paragraph (`:66`).
- **A merge is never trusted unproven**: the merged text is re-parsed and used
  only if it canonicalises back to the same canonical form; otherwise the house
  style wins (`packages/shared/src/markdown-source.ts:70-72`).
- The merge itself (`:88-136`): line diffs of the source and the canonical form
  against a common base, both computed with `markdownAlignmentKey`
  (`:215-221`, which strips heading, bullet and quote markers, strips `_` and
  `*`, and collapses whitespace); hunks sorted by base position; adjacent hunks
  with no stable base line between them coalesced into one region; then per
  region: ours-only wins ours, theirs-only wins theirs, and **a genuine
  both-sides conflict resolves to _ours_, the house style** (`:127-131`).
- The channel is the `markdownSource` Y.Map root, one key holding `{source}`
  (`packages/shared/src/markdown-source.ts:142`, `:159-167`). The write is
  skipped when the value is already identical, so no spurious Y update
  (`:165`). Recording is budgeted at
  `MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES = floor(NOTE_SYNC_MAX_BYTES / 2)`
  (`apps/desktop/src/main/sync/blocknote-converter.ts:505`).

**Q12.3 — the conflict rule.** A user's hand-written formatting loses to the
house style. **This is correct and frozen as desktop behaviour. A second
implementation is NOT required to reproduce the diff or the alignment key**,
because it never runs the merge.

**Q12.4 — `MAX_EDIT_DISTANCE = 2000`** aborts the whole merge with `null`
(`packages/shared/src/markdown-source.ts:200`, applied at `:98`, `:284`), which
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
