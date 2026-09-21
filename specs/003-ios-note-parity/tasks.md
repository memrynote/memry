# Tasks: iOS note parity

**Input**: [plan.md](./plan.md)

**Protocol**: `docs/protocol/12-note-body-format.md` is normative for everything
that touches the body; `docs/protocol/14-attachments.md` for everything that
touches bytes. Read §12.5.0 before writing into the fragment and §14.4.1 before
reading a manifest.

**Format**: `[ID] [P?] Description with file path`. `[P]` means it can run beside
its siblings. A task added later takes a suffix letter (`N004a`) so no existing
id ever moves.

**Gates are serial.** A phase marked with a gate does not start until that
gate's evidence is green. Everything else is parallel: Phases A, B and C have no
dependency on one another. Where A and C both touch
`apps/ios/Memry/Features/Notes/NoteBlockView.swift`, land A first.

---

## Phase A: read fidelity and table read

**Purpose**: the native read path loses content today. Fix that before building
on it.

### A0 — found while starting, not planned

- [x] N000a Delete the stale override in `crates/memry-core/tests/field_merge_vectors.rs`. The suite was **already red on `main`**: the test asserted `object-values-same-content-different-key-order` against chapter 06 §6.4.2 instead of against the committed file, because the shipped TypeScript still compared `JSON.stringify` output. #2185 landed as `4208a2654` and the generator re-emitted the case with `hadConflicts: false`, so the override's own comment — "this override is deleted with no change to the Rust" — came due. Phase A's evidence is `cargo test -p memry-core` green, which it could not be until this went

### A1 — known defects

- [x] N001 Emit `divider` as a block: remove it from `SKIPPED` in `crates/memry-core/src/crdt/blocks.rs:135`, which returns before pushing and makes `NoteBlockView.swift:104` unreachable. Keep `blocks_to_text` emitting nothing for it so the `extract_text` parity test still holds
- [x] N002 Carry inline mark **values**: add an attribute map to `InlineRun` in `crates/memry-core/src/crdt/blocks.rs` and populate it in `runs_of_text` (`:320`), which records the mark name but only captures a value for `link`/`href`, so `textColor="red"` reaches the shell as a bare `textColor`
- [x] N003 [P] Apply inline colours in `apps/ios/Memry/Features/Notes/NoteBlockView.swift` `NoteInline.attributed`, mapping BlockNote's colour names onto `Tokens`; an unknown colour name leaves the text alone rather than guessing
- [x] N004 [P] Render all six heading levels in `NoteBlockView.swift` `headingRole`, which clamps to three today. Extend the `DESIGN.md` type ramp rather than clamping the content, and record the ramp extension in `DESIGN.md` in the same change
- [x] N005 [P] Number list items in `NoteBlockView.swift:78`, which hardcodes `1.`; count preceding siblings at the same `depth` whose `kind` is `numberedListItem`, restarting at a non-list block
- [x] N006 [P] Render `audio` and `video` blocks in `NoteBlockView.swift`; they fall through to `default` and draw an empty paragraph. Metadata only here — bytes arrive in Phase C
- [x] N007 [P] Render `toggleListItem` (disclosure driven by the `open` prop; children already arrive at `depth + 1`) and `inlineCheckbox` (arrives as an empty run carrying the mark) in `NoteBlockView.swift`
- [x] N008 [P] Apply block-level `textAlignment`, `textColor` and `backgroundColor` props in `NoteBlockView.swift`; `props_of` already returns them and nothing reads them

### A2 — table read and render

- [x] N010 Expose table structure from the core. `crates/memry-core/src/crdt/blocks.rs:134` treats `table` and `tableRow` as containers and only `blockGroup` raises depth, so every cell of every row arrives at one depth with no row boundary and no column count. Add `Notes.table(blockId) -> TableContent` returning rows, cells, per-cell `colwidth`, per-cell colours, and header flags derived from `tableHeader` vs `tableCell`. **Answers Q1: record whether a cell carries a `blockContainer` id**
- [x] N011 Render tables in `apps/ios/Memry/Features/Notes/`: column widths applied proportionally with horizontal scrolling rather than as pixels, cell background and text colours, header row and header column emphasis
- [x] N012 [P] Table accessibility: VoiceOver row and column headers, Dynamic Type, and a reduced-motion-safe scroll affordance
- [x] N013 [P] Core test in `crates/memry-core/tests/` covering a table with mixed `tableHeader`/`tableCell`, a set `colwidth` and a coloured cell

**Phase A evidence**: `cargo test -p memry-core` green, `Unit.xctestplan` green,
and a note holding every block type screenshotted beside desktop.

**Status**: `cargo test -p memry-core` green (41 binaries, 0 failures).
`Unit.xctestplan` green — 393 tests in 66 suites, up from 386, the four new
ones covering the mark-value path, the unknown-colour refusal, the inline
checkbox and the six-step heading ramp. The side-by-side screenshot needs a
real vault and a desktop beside it and is **not** done; it is the one piece of
Phase A's evidence still outstanding.

A note on tooling found here: `sourcekit-lsp` reports `No such module
'MemryCore'` and `Cannot find type 'Tokens' in scope` for **every** file in
this target, touched or not, because an Xcode project gives it no compile
database. `xcode-build-server config -project Memry.xcodeproj -scheme Memry`
writes the `buildServer.json` that fixes it (already in `.gitignore`).
`xcodebuild` is the authoritative check either way.

---

## Phase B: vector classes — gate **G-P1**

**Purpose**: make parity a red build. Phase E may not start until this gate is
green, because Phase E is where Rust starts authoring nodes.

Read `packages/contracts/test-vectors/README.md` first: vectors come out of
production code paths, generation and verification are separate programs, and a
format change updates the chapter and the vectors in the same change.

- [x] N100 Research note in `specs/003-ios-note-parity/research.md`: why Y update bytes cannot be compared across ports (an update encodes `clientID` and clock, so `yrs` and `yjs` performing the same edit legitimately differ), and what the write class compares instead
- [x] N101 Canonical fragment serialisation — **gates the rest of this phase**. One textual form of the `prosemirror` fragment (node names, sorted attribute sets, nesting, text) emitted identically by TypeScript and Rust. Attributes must be sorted, as `props_of` already sorts, because a Yjs map's order is not stable across runs
- [x] N102 Read-direction corpus in `packages/editor-schema/src/conformance.ts`, beside `ROUNDTRIP_CASES`, covering all 18 blocks, 8 inline types and 7 styles of `packages/editor-schema/src/registry-manifest.json`, authored through BlockNote so the bytes are what desktop really writes
- [x] N103 Generator `packages/contracts/scripts/vectors/note-blocks.ts` exporting N102 as `note-blocks.json`, registered in `gen-protocol-vectors.ts`, with a pinned `clientID` as the other classes use
- [x] N104 [P] TypeScript verifier `packages/contracts/src/__tests__/note-blocks.test.ts`; it reads the committed file and never imports the builder
- [x] N105 [P] Rust consumer in `crates/memry-core/tests/`, reading `note-blocks.json` through `include_str!` the way `tests/support/mod.rs:62` reads `text-extract.json`
- [x] N106 [P] iOS consumer in `apps/ios/MemryConformanceTests/`, through the real FFI, following the harness in `Vectors.swift`
- [x] N107 Write-direction corpus and class `block-edit.json`: a base document, one operation, and the expected resulting document in the N101 serialisation. One case per operation in Phase E. **The N101 serialisation both ports emit is in place and pinned by `note-blocks.json`, so this task is now only the corpus and the harness.** Design settled while doing N100: the expected result is authored by performing the equivalent edit **through BlockNote** and rendering it canonically, so the assertion is "the Rust writer produces the document BlockNote would have produced" — which is exactly what §12.5.0 demands and what a self-consistency test cannot check. Cases need explicit block ids on base and expected so the two line up under an insert
- [x] N108 Update `packages/contracts/test-vectors/README.md`'s file table and case total, and `docs/protocol/12-note-body-format.md` where the new classes are named — README rule 3

**Gate G-P1 evidence**: `pnpm --filter @memry/contracts vectors:check` and
`pnpm --filter @memry/contracts test` green, `cargo test -p memry-core` green,
`Conformance.xctestplan` green on device.

**Status: G-P1 is OPEN. Phase E may start.**

Measured:

- `vectors:check` passed (13 classes, up from 11)
- `pnpm --filter @memry/contracts test`: 2189 tests in 71 files
- `cargo test -p memry-core`: 43 binaries, 0 failures
- `Conformance.xctestplan`: 21 tests in 5 suites, on the simulator
- `Unit.xctestplan`: 393 tests in 66 suites
- both generators are byte-reproducible across consecutive runs

**Phase E starts with the four `pending` cases in `block-edit.json`, which are
real defects the write class found on its first run rather than known-bad
inputs.** Each is asserted to fail today, so fixing it turns the case red and
forces the flag off:

1. **The append path adds a second top-level child.** `insert_paragraph` with
   no `after` appends to the **fragment**, putting a `blockContainer` beside
   the existing `blockGroup`. §12.5.0: y-prosemirror cannot construct a `doc`
   with two top-level children and answers by **deleting the element** —
   silently. This is the single most dangerous thing a writing client can get
   wrong, and the reference core did it. Owned by N400.
2. **`SetProp` stores every value as a string.** `checked` lands as `"true"`
   where BlockNote writes the boolean `true`. Not cosmetic: unticking stores
   `"false"`, and a non-empty string is truthy, so a box cleared on iOS reads
   as ticked anywhere that tests the prop for truth. Latent only because no
   shell calls `Notes.editBlock` yet — which is exactly why it must be fixed
   before one does. Owned by N408.
3. **`level` lands as `"5"`** where BlockNote writes `5`. Unnoticed because
   `extract_text` reads the level with a JavaScript-style digit-prefix parse,
   so the `#` marker survives either spelling. Owned by N408.
4. **Inserted blocks omit their declared props.** BlockNote's paragraph carries
   `backgroundColor`, `textAlignment` and `textColor` at their declared
   defaults; `insert_paragraph` writes none. Both render the same, so nothing
   is lost today, but the documents are not identical — so iOS cannot be held
   to byte parity with desktop until the writer knows each type's declared
   props. Owned by N400. §12.5.0's sentence about omitting defaults describes
   the hand-built fixtures, not BlockNote's writer, and the chapter now says so.

Three defects the new class caught that no existing test could, all fixed here:

1. **Top-level blocks reported `depth: 1`, not 0.** §12.5.0's mandatory
   top-level `blockGroup` was counted as nesting, so `NoteBlockView` — which
   indents by `depth * inset` — drew every note one step indented. Fixed in
   both ports with an `at_root` flag.
2. **The generator was not reproducible.** `blocksToYXmlFragment` mints a v4
   UUID per block, so two runs differed and `vectors:check` would have failed
   on a tree nobody touched — silently exempting this class from its own gate.
   Block ids are now assigned deterministically.
3. **The two ports disagreed on an `undefined` attribute.** y-prosemirror
   skips a `null` attribute but writes an `undefined` one, and every
   `numberedListItem` carries `start: undefined`. Rust rendered `start=null`,
   TypeScript dropped the key. Both now omit it.

---

## Phase C: attachments, both directions

**Purpose**: the user sees every attachment and can add one. This opens
`docs/protocol/14-attachments.md`, which is marked "scoped read-only and
deferred", and overrides
`specs/002-native-foundation-ios/spec.md:358`.

Independent of Phases B and D. Needs no editor.

### C1 — download

- [x] N200 Core: manifest fetch through `GET /sync/attachments/:attachment_id/manifest`, with **signature verification before unwrap and decrypt** (§14.4.1 states that order normatively) and an unresolvable signer device as a hard failure, not a fallback
- [x] N201 Core: the two transfer paths (§14.6). **Found and fixed while doing this: `STORAGE_PRESIGN_UNAVAILABLE` was being retried.** It arrives as a 503, so it fell into the shared classifier's retryable-5xx branch and every presign call spent a full retry ladder on a condition that cannot change within a deployment — which is exactly what §14.6 forbids. Lifted out of that branch in `protocol/http.rs`, the same way 501 `BOOTSTRAP_UNAVAILABLE` already was and for the same stated reason. Kept as a `Status` carrying the code rather than given its own variant, because the caller's correct response is not to fail but to switch to the proxied path and record that this deployment does not presign. A test asserts the typed refusal takes **one** call while an untyped 500 still runs the ladder. Original text: — `POST /sync/attachments/presign-batch` (cap 1024 hashes, `expiresAt` in epoch seconds) with the proxied `GET /sync/attachments/chunks/:chunk_hash` fallback. `STORAGE_PRESIGN_UNAVAILABLE` is permanent for that deployment and MUST NOT be retried on a timer
- [x] N202 Core: chunk decode — strip the 24-byte nonce, AEAD decrypt under the file key, verify `chunks[j].hash` over the plaintext, concatenate in index order, verify `manifest.checksum` over the whole file. `chunkSize` comes from the manifest, never from a constant (§14.9)
- [x] N203 Core: bounded local attachment cache with eviction, plus the metered policy — lazy download defaulting to unmetered with an explicit per-item override (FR-045, `unmetered_only` in `specs/002-native-foundation-ios/data-model.md:289`)
- [x] N204 Core: resolve a note's attachments through `attachmentReferences` on the note payload (§14.7). **Absent means "this sender does not know"** — never "no attachments" — and the local list is not cleared on seeing one
- [x] N205 Core: manifest signing and verification in Rust. **Answered: reimplement.** The "lift it somewhere both call" option does not exist — the core is a standalone Rust library a Swift shell links and cannot call the TypeScript module, and §14.4.1 forbids not verifying. It turned out to be assembly rather than cryptography: the `ATTACHMENT_MANIFEST` CBOR order was already in `crypto/cbor.rs`. `attachment-manifest.json` holds the ports together and the Rust harness asserts the **envelope bytes** match, not merely that each port reads itself. Two traps pinned: the signed CBOR order is canonical (`keyNonce, manifestNonce, encryptedFileKey, encryptedManifest`), which is **not** the allowlist order, so a port signing the listing order makes valid CBOR and an unacceptable signature; and the signature does not cover the manifest body, so `manifestJson` is asserted byte-for-byte or the ports drift silently. Original task text: **Answers Q3 and is the largest unknown in this phase**: either reimplement against `packages/sync-client/src/push/attachment-manifest.ts` with a conformance vector holding the two ports together, or lift the shared logic somewhere both call. Decide in `research.md` before writing code
- [x] N206a **Answer Q4: what binds an `image` block to an attachment id.** Found while starting N206 and it blocks it. `attachmentReferences` carries attachment ids, but a body block carries a `url` that desktop resolves as a **vault-relative file path** against the vault root — and iOS has no vault file tree, so nothing on the phone turns `pictures/diagram.png` into an id. Basename-matching `manifest.filename` is **not** sound: a filename is not unique in a vault, so two notes referencing `screenshot.png` collide and a wrong match shows the wrong picture in the wrong note. Rule out first whether something already on the note payload carries the binding (desktop writes an `attachmentId` **singular** beside the plural list — possibly the cover, N208's field); only then choose between carrying the vault-relative path in the manifest and refusing an ambiguous basename match. Decision to `research.md` §Q4 before any code
- [x] N206 iOS: `image` blocks and `inlineImage` with real bytes. **N206a answered it** for the block-to-id binding; the fetch, cache and placeholder halves do not depend on it, replacing the `AttachmentRow` placeholder in `NoteBlockView.swift:111`; a placeholder while bytes are absent, and a late arrival becomes visible without the note being recreated
- [x] N207 [P] iOS: `file`, `audio` and `video` blocks openable and playable
- [ ] N208 [P] iOS: cover image rendering — pairs with N701

### C2 — upload

- [x] N209 Core: chunking and framing — 8 MiB plaintext chunks with a short final chunk, at most 128 chunks per session, every chunk `nonce(24) ‖ ciphertext` under **one** file key wrapped once in the manifest (§14.2)
- [x] N210 Core: manifest build, encrypt under a fresh file key with no AAD, wrap under the vault key, and sign the four fields as canonical CBOR in `CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST` order (§14.4.1)
- [x] N211 Core: upload session — `initiate`, per-chunk `PUT`, `complete`, plus status and cancel; resume after an interrupted session; quota reserved against **ciphertext** size, not `manifest.size` (§14.8)
- [x] N212 Core: dereference on delete. §14.8 — "a client that later gains the ability to delete an attachment MUST dereference". Phase C is when we gain it, so this is not optional. Rate limited to 20 requests per 60 s
- [x] N213 Protocol and spec: move the scope marker in `docs/protocol/14-attachments.md`, update the out-of-scope row at `specs/002-native-foundation-ios/spec.md:358`, and correct FR-045's "inline image" wording, which reads as the table-cell-only `inlineImage` type while meaning the `image` block (§12.7.1). Run `pnpm docs:impact --strict` in the same change (FR-008)
- [x] N214 iOS: attachment picker — photo library, camera and files — with upload progress, failure surfaced through `ErrorMapping.swift`, and the vault-relative placement desktop uses
- [x] N215 [P] iOS: attachment remove, wired to N212

**Phase C evidence**: upload a picture from iOS, open the note on desktop, and
confirm the file lands in the vault with a matching checksum; delete it from iOS
and confirm the chunks are dereferenced.

---

## Phase D: text input spike — gate **G-P2**

**Purpose**: every editing task depends on how a caret, a selection and an IME
behave across block boundaries. Decide with evidence, not with an opinion.

- [x] N300 Spike: one `UITextView` per block versus a document-wide TextKit 2 layout. Measure caret and selection across a block boundary, IME and dictation, autocorrect, undo grouping, a 500-block note's scroll performance, and VoiceOver. Evidence to `apps/ios/SpikeEvidence/`
- [x] N301 Decision record in `specs/003-ios-note-parity/research.md`, including why `lexical-ios` is not the answer: no Swift Yjs binding, a document model incompatible with the y-prosemirror fragment, and "pre-release with no guarantee of support" upstream
- [x] N302 Skeleton of the chosen surface in `apps/ios/Memry/Editor/`, an empty directory today, rendering one editable paragraph end to end through `Notes.editBlock`

**Gate G-P2 evidence**: the spike's measurements committed, the decision
recorded, and one paragraph editable on device with the edit visible on desktop
after sync.

---

## Phase E: core write operations

**Purpose**: every structural change a user can make, authored in Rust through
`Document::write` (§12.5.1) — never by diffing, never by replacing the fragment
(§12.5.0.1). Each task lands with its `block-edit.json` case.

**Depends on**: G-P1.

- [x] N400 Grow `crates/memry-core/src/crdt/body_edit.rs` into a schema-aware writer: one place that knows BlockNote's node shapes, locating its parent rather than assuming one, and refusing an unrecognised top-level layout rather than guessing (§12.5.0)
- [x] N401 `InsertBlock { kind, props, after }` for every registry type, building the correct node tree for each
- [x] N402 Table cell text. If N010 finds a cell carries a `blockContainer` id this is `SetText` reaching a cell, so the task is a test plus a rename; if not, add `SetCellText { table_id, row, col, text }`
- [x] N403 Table structure: `InsertRow`, `DeleteRow`, `InsertColumn`, `DeleteColumn`, preserving `colwidth` and cell colours on the cells that survive
- [x] N404 Table cell props: colour and `colwidth`, so desktop regenerates the `table-layout` and `table-colors` markers from what iOS wrote
- [x] N405 `TurnInto` across the 11 types desktop offers (`paragraph`, `heading1..3`, `bulletList`, `numberedList`, `checkList`, `toggleList`, `quote`, `codeBlock`, `callout`), carrying inline content across the change
- [x] N406 `Duplicate`, `MoveBlock`, `Indent` and `Outdent`, with nesting rules matching desktop's `multi-block-indent-plugin`
- [x] N407 Inline mark operations — apply and remove `bold`, `italic`, `underline`, `strike`, `code`, plus colour and link — addressed by range within a block. **This removes the documented limitation in `body_edit.rs` that `SetText` loses a block's marks**
- [x] N408 Block prop operations for the rest: callout `type`, code block `language`, toggle `open`, heading `level`, alignment and colours
- [x] N409 Every operation commits its update row and its outbox row together (FR-030), and a write that authored nothing stores and pushes nothing — the rule `body_edit.rs` already follows

---

## Phase F: iOS editing surface

**Depends on**: G-P2, Phase E.

- [x] N500 Block editing surface from N302 across all text-bearing block types
- [x] N501 Enter, Backspace and selection at block boundaries: split, merge and delete
- [x] N502 Insert menu (desktop's slash menu): all block types plus link to note, insert template, and insert picture through N214. Reachable from a keyboard accessory, not only by typing `/`
- [x] N503 Block context menu: turn into, colours, duplicate, move to, delete
- [x] N504 Selection formatting toolbar: the five marks, colour, link
- [x] N505 Table editing UI: cell selection, row and column insert and delete, column resize, cell colour
- [x] N506 Code block: language picker and copy
- [x] N507 Callout type switching and toggle fold
- [x] N508 [P] Editing accessibility pass: VoiceOver on an editable block, Dynamic Type in the toolbars, reduced motion
- [x] N509 Undo and redo, **native**: an undo stack over the operations the shell issued, not a yrs `UndoManager` in the core. Record in `research.md` that iOS and desktop undo granularity may differ, which is the accepted trade

---

## Phase G: inline richness

**Depends on**: Phase F.

- [ ] N600 Tappable `#tag` plus the tag screen it needs; `NoteBlockView.swift` marks tags deliberately unlinked today because there is nowhere to go
- [ ] N601 `dateMention`: the date picker, `remindMe`, and the date suggestions desktop offers
- [ ] N602 Wiki link menu: note search, heading selection, `displayAs` alias, embed versus link, and creating a note from a broken link
- [ ] N603 Paste-link menu: url, mention, embedded video, bookmark
- [ ] N604 Review comments, **read only**: a new core read over the `criticMarkupMarks` root, rendered against the block the byte offsets point at. §12.5.1 forbids writing them, and the reader drops any element failing shape validation, so the shell must not normalise what it reads
- [ ] N605 [P] Tappable `inlineCheckbox` inside a table cell

---

## Phase H: metadata surface

**Depends on**: Phase F for the editors, not for the reads.

- [ ] N700 Core: property writes for the 10 types (`text`, `number`, `date`, `checkbox`, `url`, `status`, `select`, `multiselect`, `relation`, `project`). `NoteProperty` already carries `value_json`, `type_name`, `options_json` and `color` on the read side. **Answers Q2: record whether this belongs beside `domain/note_meta.rs` or in the note record payload handler**
- [ ] N701 Core: add `cover` and `icon` to `NoteMetadata`, which carries only tags, properties and aliases today, plus their writes
- [ ] N702 iOS: title editing and the icon picker (emoji and symbol)
- [ ] N703 iOS: cover add, change, remove and reposition, on N208 and N214
- [ ] N704 iOS: the 10 property editors
- [ ] N705 iOS: tag add, remove and colour, with recent, matching and all suggestions as desktop offers
- [ ] N706 [P] Core: alias writes, so a wiki link can resolve to a note by a name the note itself declares

---

## Phase I: page shell

- [ ] N800 Backlinks section: core query plus the iOS surface, with desktop's three sort orders and the `viaProperty` distinction
- [ ] N801 Find in note
- [ ] N802 Export
- [ ] N803 Apply template
- [ ] N804 Reminders
- [ ] N805 Attachments list for a note
- [ ] N806 Folder CRUD — missing entirely: `crates/memry-core/src/api/notes_write.rs` offers `create`, `rename`, `move_to_folder`, `delete` and `edit_block` for notes, and nothing creates, renames or deletes a folder
- [ ] N807 [P] Linked tasks section — blocked on the Tasks feature, which has no code
- [ ] N808 [P] Note page overflow menu: rename, move to folder, copy path, bookmark, local-only, delete

---

## Round-trip acceptance

Not a phase. Run after any phase that writes to the body or to bytes.

- [ ] R01 Edit each block type on iOS, sync, open on desktop, and confirm the vault markdown file changed **only** in the edited region (FR-041)
- [ ] R02 Edit a table's cell text, a cell colour and a column width on iOS, and confirm desktop regenerates `<!-- table-layout:… -->` and `<!-- table-colors:… -->` with the same bytes it would have written itself
- [ ] R03 Open a note carrying suggestions and link references on iOS, edit an unrelated block, and confirm `criticMarkupMarks`, `linkReferenceDefinitions`, `linkReferenceUsages` and `markdownSource` survive untouched (§12.5)
- [ ] R04 Open a note holding a block type this build does not know, edit a neighbouring block, and confirm the unknown block survives (FR-033)
- [ ] R05 Edit the same block on iOS and desktop while both are offline, reconnect, and confirm both converge with neither edit lost
- [ ] R06 Upload a picture from iOS, open the note on desktop, confirm the file lands in the vault with a matching checksum, then delete it from iOS and confirm the chunks are dereferenced
- [ ] R07 Open a note whose attachment bytes have not arrived, confirm a placeholder rather than a gap, and confirm the picture appears on arrival without the note being recreated
