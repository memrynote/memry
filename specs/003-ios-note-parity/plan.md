# Plan: iOS note parity — read and edit a note body natively

**Goal**: a user opens a note on iOS and sees what desktop shows, loses nothing,
and can edit it — create, read, update and delete every block type, every inline
type, the metadata around the body, and attachments in both directions.

**Input**: `docs/protocol/12-note-body-format.md`,
`docs/protocol/14-attachments.md`,
`packages/editor-schema/src/registry-manifest.json`, the desktop note page
(`apps/desktop/src/renderer/src/pages/note.tsx` and
`apps/desktop/src/renderer/src/components/note/`).

**Tasks**: [tasks.md](./tasks.md).

---

## 1. Where this starts

The notes rollout landed a native read path: `Notes.blocks(id)` hands the shell a
flat block list, `NoteBlockView.swift` draws it, tags and typed properties
render, wiki links resolve on tap, and search reaches note bodies through the
core's FTS index. `Notes.editBlock` landed four write operations in the core with
no shell calling them.

This plan adds the rest.

## 2. Scope

### In

| Area            | What                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| Body render     | all 18 blocks, 8 inline types and 7 styles of the FR-040 registry      |
| Body edit       | create, update, delete for every block type, including table structure |
| Inline          | marks, colours, links, wiki links, tags, date mentions                 |
| Metadata        | title, icon, cover, tags, the 10 property types                        |
| Attachments     | **download and upload** — see §3 D4                                    |
| Review comments | **read only**                                                          |
| Page shell      | backlinks, find in note, export, templates, reminders, folder CRUD     |

### Out, deliberately

Confirmed with Kaan. Each shows a clear limitation rather than a partial
imitation (`DESIGN.md`).

| Area                       | Why                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Mind map                   | a 21-file canvas surface; not a phone interaction                                                                            |
| Local graph panel          | same                                                                                                                         |
| Version history            | desktop-only surface over the update log                                                                                     |
| Review comment **writing** | §12.5.1 forbids a non-desktop client writing `criticMarkupMarks`; a client that rewrites elements corrupts byte-offset marks |
| Template editor            | authoring templates stays on desktop                                                                                         |

### Never, by protocol

Not scope decisions — protocol rules, recorded so a future session does not
"fix" them.

- **iOS never writes markdown.** §12.1: markdown conversion runs only inside the
  editor bundle. The file on disk is produced by desktop main's `yDocToMarkdown`,
  which re-serialises the whole document when a remote update arrives
  (`apps/desktop/src/main/sync/crdt-writeback.ts:459`, `:586`). Table layout and
  colour markers are regenerated there from the document, so iOS never needs to
  know a marker's byte format.
- **iOS never writes `criticMarkupMarks`, `linkReference*` or `markdownSource`**
  (§12.5.1).
- **iOS never replaces the whole fragment.** §12.5.0.1: a delete-and-reseed
  converges and silently loses a concurrent edit from another device.
- **iOS never infers "this note has no attachments" from an absent
  `attachmentReferences`** (§14.7, chapter 13 §13.4).

## 3. Decisions

### D1. Node construction lives in Rust, not in Swift

Inserting a table row means building a `tableRow > tableCell > tableParagraph`
tree. §12.5.0 is explicit about what happens when a writer gets the shape wrong:
y-prosemirror answers a node its schema cannot construct by **deleting the
element**, the update applies, the document encodes, `extract_text` may still
return the text, and the next desktop to open the note renders it without the
block.

So `crates/memry-core/src/crdt/body_edit.rs` grows into a schema-aware writer.
Swift sends an operation name and parameters and never knows a node shape. A
future Android shell inherits it.

### D2. Parity is measured, not asserted

`extract_blocks` has no vector class. `crates/memry-core/tests/crdt_blocks.rs`
only asserts that the block walk and the text walk agree **with each other**,
which is why both dropping `divider` passes today.

SC-010's cross-shell digest does not help: §12.11 defines it over
`title + "\n" + extract_text(doc)`, so a shell can lose every inline colour and
still match.

Two new vector classes, following the three rules in
`packages/contracts/test-vectors/README.md`:

- **`note-blocks.json`** — read direction. Document bytes in, expected `Block[]`
  out.
- **`block-edit.json`** — write direction. Base document plus an operation, and
  the expected resulting document.

**The blocker, and how it is answered.** Y update bytes cannot be compared across
ports: an update encodes `clientID` and clock, so `yrs` and `yjs` performing the
same edit legitimately differ. The write class therefore compares the **resulting
document structure** — node names, sorted attribute sets, nesting, text —
through a canonical fragment serialisation both ports produce. Designing that
serialisation is task N101 and the rest of Phase B depends on it.

The corpus lives in `packages/editor-schema/src/conformance.ts` beside
`ROUNDTRIP_CASES`, because that is where BlockNote already is, and contracts
exports it the way `markdown-roundtrip` already exports that corpus. This keeps
rule 1 ("vectors come out of production code paths") without adding
`@blocknote/server-util` to `@memry/contracts`.

### D3. Native text input is a spike before it is a plan

Everything in Phase F depends on how a caret, a selection and an IME behave
across block boundaries. The spike (N300) decides between one `UITextView` per
block and a document-wide TextKit 2 layout, and its evidence lands in
`apps/ios/SpikeEvidence/` before the phase is scheduled.

`lexical-ios` was evaluated and rejected: it carries a document model
incompatible with the y-prosemirror fragment, it has no Yjs binding in Swift, and
its README states it is "in pre-release with no guarantee of support". We would
pay for a document model and need only caret, IME and selection.

### D4. Attachments are full scope, and they move early

`specs/002-native-foundation-ios/spec.md:358` scoped iOS to inline image download
only, with `file`/`audio`/`video` metadata-only and **all upload deferred**. Kaan
has overridden that: the user must see every attachment and must be able to add
one.

This is not a preference change, it is a protocol scope change, and it lands in
the same phase: `docs/protocol/14-attachments.md`'s "scoped read-only and
deferred" marker and the 002 out-of-scope table both move in Phase C.

It moves **early** because three surfaces block on it — the cover image, the
`image` block, and inserting a picture while editing — and because full CRUD
without "add a picture" is not full CRUD.

Consequences the chapter imposes, each a task rather than a footnote:

- signature verification happens **before** unwrap and decrypt (§14.4.1); a
  conforming reader keeps that order
- an unresolvable signer device is a hard failure, not a fallback
- quota is reserved against **ciphertext** size, not plaintext (§14.8)
- `CHUNK_SIZE` is not a contract constant; `chunkSize` is carried per file in the
  manifest (§14.9)
- a client that can delete an attachment **MUST** dereference (§14.8) — which we
  now can, so we must
- `attachmentReferences` lives on the note's metadata, not derived from the body
  (§14.7)

**Ambiguity found and resolved here.** FR-045 says "inline image bytes", but in
our schema `image` is a _block_ and `inlineImage` is the table-cell-only variant
(§12.7.1). The intent is pictures in the note body, which is the `image` block.
Phase C covers both, and N213 corrects the wording in the 002 spec.

### D5. Three answers from Kaan, recorded

- **Heading levels**: iOS renders all six. `NoteBlockView.headingRole` clamps to
  three today; the type ramp extends rather than the content clamping (N004).
- **Undo**: native, not a yrs `UndoManager` in the core. An undo stack over the
  operations the shell issued (N509). The trade accepted: iOS and desktop undo
  granularity may differ.
- **Review comments**: reading is in scope (N604). Only writing is forbidden.

## 4. Known defects this plan fixes

Found while auditing; each has a task.

| Defect                                                                                  | Evidence                                                                                                                                                                  | Task       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `divider` never reaches the shell                                                       | `crdt/blocks.rs:135` `SKIPPED` returns before pushing the block, so `NoteBlockView.swift:104` `case "divider"` is unreachable                                             | N001       |
| Inline colour values are dropped                                                        | `crdt/blocks.rs:320` `runs_of_text` keeps the mark name but only captures a value for `link`/`href`                                                                       | N002       |
| Headings clamp to three levels                                                          | `NoteBlockView.swift` `headingRole`                                                                                                                                       | N004       |
| Every numbered list item renders `1.`                                                   | `NoteBlockView.swift:78` hardcodes the marker                                                                                                                             | N005       |
| `audio`, `video`, `toggleListItem`, `inlineCheckbox` fall through to an empty paragraph | absent from the `NoteBlockView` switch                                                                                                                                    | N006, N007 |
| Table structure is unrecoverable                                                        | `crdt/blocks.rs:134` treats `table` and `tableRow` as containers and only `blockGroup` raises depth, so every cell of every row arrives at one depth with no row boundary | N010       |

## 5. Phases

```
A  read fidelity and table read    N0xx   independent, start now
B  vector classes                  N1xx   gate G-P1
C  attachments, both directions    N2xx   independent of B; needs no editor
D  text input spike                N3xx   gate G-P2
E  core write operations           N4xx   needs G-P1
F  iOS editing surface             N5xx   needs G-P2 and E
G  inline richness                 N6xx   needs F
H  metadata surface                N7xx   reads independent; editors need F
I  page shell                      N8xx
```

The two gates are the only serial constraints. A, B and C run in parallel: C
touches the attachment channel and the block views, B touches contracts and the
core's read walk, A touches the read walk and the block views. Sequence A before
C where they collide in `NoteBlockView.swift`.

Table **reading and rendering** is in Phase A and ships early. Table **editing**
is in E and F, because a cell cannot take text until the input surface exists.

## 6. Verification

Per phase, not at the end.

- `cargo test -p memry-core` for core walks, writer operations and the attachment
  path
- `pnpm --filter @memry/contracts vectors:check` for vector drift
- `pnpm --filter @memry/contracts test` for the verifiers
- `xcodebuild test` against `TestPlans/Unit.xctestplan` for shell logic
- `TestPlans/Conformance.xctestplan` for the vector classes through the real FFI
- `pnpm docs:impact --base <base> --strict` whenever a protocol chapter moves
- the round-trip acceptance list at the end of tasks.md, on a real vault

## 7. Open questions

Each is bound to the task that answers it; none blocks starting.

- **Q1** — Does a `tableCell` carry a `blockContainer` id? If it does, `SetText`
  addresses a cell today and N402 shrinks to a test plus a rename. Answered by
  N010.
- **Q2** — Does the property write path belong in the core's domain layer beside
  `domain/note_meta.rs`, or in the note record payload handler? Answered by N700.
- **Q3** — Does the Rust core reimplement manifest signing, or does the shared
  logic move out of `packages/sync-client/src/push/attachment-manifest.ts` into
  something both ports call? Answered by N205, and it is the largest unknown in
  Phase C.
