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

| Direction             | Mechanism                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| markdown → document   | the optional `seedMarkdown` field on the `doc-load` message (`packages/contracts/src/webview-bridge.ts:41-59`), applied by the guest **only when the document is genuinely empty** (`packages/editor-web/src/main.ts:446-453`) |
| document → markdown   | the `export-markdown` message (`packages/contracts/src/webview-bridge.ts:224-228`, handled at `packages/editor-web/src/main.ts:234-238`)                                                                                       |
| document → plain text | `extract_text`, the **only** text operation a non-editor client owns: a plain-text walk of the `prosemirror` fragment that keeps headings and list markers, drops everything else, and claims no markdown fidelity             |

**There is no `seed-from-markdown` message.** That name appears in planning
documents and is a proposed rename; the production field is `doc-load.seedMarkdown`.

### 12.1.1 The guest does not run desktop's pipeline

**Normative, and a client MUST NOT assume otherwise.** The guest calls
BlockNote's `tryParseMarkdownToBlocks`
(`packages/editor-web/src/main.ts:448`) and `blocksToMarkdownLossy`
(`packages/editor-web/src/main.ts:238`) and **nothing else**: no frontmatter
split, no critic-markup strip, no link-reference strip, no inline-colour masking,
no source record.

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

## 12.2 FR-041 holds structurally, with three carve-outs

**The structural argument.** A non-desktop client never writes a vault file;
desktop is the only writer; and desktop writes from the Y.Doc
(`apps/desktop/src/main/sync/crdt-writeback.ts:459-466`, `:552-560`).
`restoreMarkdownSource` returns the source untouched when `ours === base`
(`packages/shared/src/markdown-source.ts:68`),
`serializeParsedMarkdownNote` re-emits the raw frontmatter block and the body
verbatim when unedited (`packages/app-core/src/markdown.ts:86-92`), and
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

**Normative** (`packages/app-core/src/markdown.ts:21-40`):

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
(`packages/app-core/src/markdown.ts:51-62`).

### 12.4.2 The preservation rule

**Normative** (`packages/app-core/src/markdown.ts:78-97`):

- unless the frontmatter was edited, **the original raw block is re-emitted
  verbatim** (`:86-88`), which is what preserves comments, key order, quoting, CR
  bytes and the BOM;
- if the body is unchanged **it too is emitted verbatim** (`:90-92`);
- an edited body has its EOLs converted to the file's dominant EOL and the file's
  final-newline presence re-applied (`:94-96`). **Per-line EOL preservation is
  out of scope by design** (`:75-76`).

New files are written **LF only with a single trailing newline**, and user
content never flows through `matter.stringify`
(`packages/app-core/src/markdown.ts:128-139`).

### 12.4.3 The decision: the only guarantee is the verbatim path

**Decision, 2026-09-13 — option B. This is the normative rule.**

**A frontmatter block that the CRDT tag array, remote tags and remote properties
all left alone is re-emitted byte for byte
(`packages/app-core/src/markdown.ts:86-88`). When any of those alters it, the
block is regenerated and clients MUST NOT depend on key order, quoting style,
comment survival, or scalar spelling. A non-desktop client MUST NOT emit YAML at
all.**

The regenerated order is a composition of JavaScript semantics and js-yaml
defaults, **not a policy**: `stringifyFrontmatterBlock` drops `undefined`, emits
`''` for zero keys, and hands the object to `matter.stringify`
(`packages/app-core/src/markdown.ts:126-135`); gray-matter 4.0.3 does
`Object.assign({}, file.data, data)` and calls `yaml.safeDump`; js-yaml 3.15.1
defaults are `sortKeys: false`, `lineWidth: 80`, `noCompatMode: false`.

Per path:

| Path              | Behaviour                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRDT write-back   | `{ ...existing }` then `merged.tags = yjsTags` (`apps/desktop/src/main/sync/crdt-writeback.ts:949-953`) — existing keys hold position, `tags` is **appended only if absent**. Journal `{ ...existing, date }` (`:966`) behaves the same                                                                                     |
| remote tags       | assignment or `delete` in place (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:357-361`, `:404-408`)                                                                                                                                                                                                            |
| remote properties | `replacePropertiesOnRoot` normalises, deletes every property key, then re-adds them in the **record's** order (`apps/desktop/src/main/vault/frontmatter.ts:414-434`, `:438-449`, `:452-461`). **Editing one property moves every property to the end of the block.**                                                        |
| new file          | `serializeNote` → `normalizePropertiesToRoot` → `writeMarkdownNote` (`apps/desktop/src/main/vault/frontmatter.ts:186-188`, `packages/app-core/src/markdown.ts:131-139`); a remote create builds `{tags?, aliases?, properties?}` in that literal order (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:601-607`) |

**Value re-spelling is part of the same loss.** `parseNote` uses js-yaml
`safeLoad`, so `date: 2026-07-05` becomes a `Date`
(acknowledged at `apps/desktop/src/main/sync/crdt-writeback.ts:983`) and the
dumper re-emits it as `toISOString()`, i.e.
`2026-07-05T00:00:00.000Z`. **Any frontmatter edit rewrites every bare date.**
Comments, quoting style and blank lines survive only on the verbatim path
(`packages/app-core/src/markdown.ts:16-19`).

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
| toggle           | `<details data-memry-toggle>` / `<summary>…</summary>` / blank / body / blank / `</details>`; the expanded variant adds ` open` | `:439`, `:446-447`, `:487-519` |

**Claiming rules matter as much as the forms:**

- the callout marker regex is strict — `> [!note]` and `> [!info] A title` are
  deliberately **not** claimed
  (`packages/editor-schema/src/blocks/markdown.ts:32-36`);
- a run abutting more quote lines is refused whole (`:93`);
- **a run is claimed only by proof**: the body must re-serialise byte for byte
  (`:145`);
- structured quotes refuse a `>text` line and claim only a run that is separated
  or nested (`:220-226`);
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

**Normative.** `createMemrySchema` produces exactly **33** types
(`packages/editor-schema/src/schema.ts:52-77`), checked in as
`packages/editor-schema/src/registry-manifest.json` and asserted in both
directions by `packages/editor-schema/src/__tests__/registry-parity.test.ts`.

| Group          | Count | Types                                                                                                                                                                                                                            |
| -------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blocks         |    18 | `audio`, `bookmark`, `bulletListItem`, `callout`, `checkListItem`, `codeBlock`, `divider`, `file`, `heading`, `image`, `numberedListItem`, `paragraph`, `quote`, `table`, `taskBlock`, `toggleListItem`, `video`, `youtubeEmbed` |
| inline content |     8 | `dateMention`, `hashTag`, `inlineCheckbox`, `inlineImage`, `link`, `linkMention`, `text`, `wikiLink`                                                                                                                             |
| styles         |     7 | `backgroundColor`, `bold`, `code`, `italic`, `strike`, `textColor`, `underline`                                                                                                                                                  |

`file` and `toggleListItem` are Memry specifications overriding BlockNote
defaults of the same name
(`packages/editor-schema/src/schema.ts:57-61`, where `impl.blocks` is spread over
`defaultBlockSpecs`).

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

`extract_text` is specified by the `text-extract.json` vector class, so two ports
are pinned to the same output before any digest is compared and **a mismatch
means the content differs rather than the extractors differing**.
