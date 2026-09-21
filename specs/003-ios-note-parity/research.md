# Research: iOS note parity

Answers to the open questions in [plan.md](./plan.md) §7, each written by the
task that answered it. Nothing here is speculative — an entry lands when the
code that settles it lands.

---

## Q1 — Does a `tableCell` carry a `blockContainer` id?

**No. Answered by N010.**

BlockNote builds a cell as `tableCell > tableParagraph > text`, with no
`blockContainer` and no id anywhere in between
(`@blocknote/core`'s `tableContentToNodes`: it calls
`schema.nodes[isHeader ? 'tableHeader' : 'tableCell'].createChecked({...props,
colwidth}, schema.nodes.tableParagraph.createChecked(...))`). The only id in a
table is on the `blockContainer` wrapping the `table` block itself. The
attributes a cell does carry are `colspan`, `rowspan`, `colwidth`,
`backgroundColor`, `textColor` and `textAlignment`.

`crates/memry-core/tests/crdt_blocks.rs` asserts it rather than leaving it in
prose: `a_table_crosses_with_its_rows_columns_widths_and_colours` checks that
every cell's `block_id` is `None`.

**Consequence for N402, which was written to shrink if the answer went the
other way: it does not shrink.** `SetText` addresses a block by its
`blockContainer` id and there is nothing to address, so a cell needs its own
operation keyed by the table's id plus a row and column index —
`SetCellText { table_id, row, col, text }`. The same is true of every other
cell-scoped operation (N403's structure edits, N404's cell props): they are all
addressed positionally, and positional addressing under concurrent edits is a
real hazard that Phase E has to state a rule for.

### What N010 had to change to answer it

`extract_blocks` treated `table` and `tableRow` as _containers_
(`crates/memry-core/src/crdt/blocks.rs`), and only `blockGroup` raised depth.
Three things followed, all of them defects:

- every cell of every row arrived at one depth, with no row boundary and no
  column count, so a shell could not tell a 2×3 table from six paragraphs;
- the table's `blockContainer` id was carried down onto the **first cell**,
  because the container's id is given to the first block pushed under it — so
  the table block itself had no handle an edit could name;
- `colwidth` never crossed at all.

`table` and `tableRow` are now blocks in the block walk, which gives the table
its id back and the rows their boundaries. The **text** walk still treats them
as containers, and that difference is deliberate: `extract_text` emits one line
per cell and nothing for the table or the row (chapter 12 §12.1.3), and the
block walk rendered through `blocks_to_text` produces those same bytes. The
existing parity assertion in `crdt_blocks.rs` covers it, and
`a_table_is_a_block_and_keeps_its_id` asserts it directly for a table.

Structure that a flat depth list still cannot express — which row a cell is in,
how wide a column is, which cells are headers — is a second read,
`Notes.table(noteId, blockId) -> TableContent?`. A shell asks for it when it
meets a `table` block and not before, and skips the table's descendant blocks
in the flat list by depth.

---

## Why the write class cannot compare update bytes (N100)

**The problem.** Every other CRDT vector class compares bytes. `crdt-update.json`
gets away with it because it pins that the _transport_ does not inspect the
bytes — the same recorded blob goes in and comes out. A write class cannot do
that, because it has to compare an update **this port produced** against one
**the other port produced**, and those legitimately differ.

A Yjs update is a list of structs keyed by `(clientID, clock)`. The `clientID`
is part of the encoding, not metadata around it, and the clock is per client.
So `yrs` and `yjs` performing the identical edit on the identical base document
emit different bytes, and there is no normalisation that makes them equal
without decoding both — at which point you are comparing documents, not bytes.
Pinning the `clientID` does not rescue it either: struct ordering, left/right
origin ids and the run-length packing of insertions are all free choices an
implementation is allowed to make differently while producing a document that
converges to the same state.

That is the whole point of a CRDT: **two different updates that converge are
both correct.** A byte comparison would therefore fail on correct
implementations and pass on nothing extra.

**What the class compares instead: the resulting document.** Each case is a
base document, one operation, and the expected document **after** the
operation, rendered through a canonical fragment serialisation that both ports
emit identically (N101). A port applies the operation to the base and
re-renders; the rendering must match byte for byte.

This is stronger than it sounds, and it is what the parity gap needed. The old
self-consistency test compared `extract_blocks` against `blocks_to_text` — two
walks of one port, which agree with each other whether or not either is right,
which is exactly how dropping `divider` passed. The canonical form carries node
names, nesting, sorted attributes and text, so a writer that builds
`tableRow > tableParagraph` instead of `tableRow > tableCell > tableParagraph`
fails, and §12.5.0's silent-deletion trap becomes a red build rather than a
note that renders wrong on the next desktop that opens it.

**What it deliberately does not carry**: the `blockContainer` ids of newly
inserted blocks, which are v4 UUIDs a writer mints. A case that asserts
placement passes the id in as an operation parameter, so it is an input rather
than a random output.

### What the write class found on its first run (N107)

Four cases ship `pending`, and none of them is a known-bad input written to be
red. Each is a defect in the reference writer that no existing test could see,
because nothing existed to compare the writer's output against.

**The append path adds a second top-level child.** `insert_paragraph` with no
`after` appends to the _fragment_, which puts a `blockContainer` beside the
existing `blockGroup`. §12.5.0 is explicit about the consequence:
y-prosemirror cannot construct a `doc` with two top-level children and answers
by **deleting the element**, silently. The update applies, the document
encodes, `extract_text` may still return the text, and the next desktop to open
the note renders it without the block. The chapter names this the single most
dangerous thing a writing client can get wrong, and the core shipped it.

**Props are written as strings rather than in their declared types.**
`SetProp` carries a `String` and `insert_attribute` stores one, so `checked`
lands as the string `"true"` where BlockNote writes the boolean `true`, and
`level` lands as `"5"` where BlockNote writes `5`.

This is not cosmetic. Unticking a box stores `"false"`, and a non-empty string
is truthy — so a box the user cleared on iOS reads as **ticked** anywhere that
tests the prop for truth. It is latent today only because no shell calls
`Notes.editBlock`, which is precisely why it has to be fixed before one does.
The heading case has hidden itself for a different reason: `extract_text` reads
the level with a JavaScript-style digit-prefix parse, so the `#` marker comes
out right either way.

A conforming writer writes a prop in its **declared type**. That needs the
writer to know each block type's prop schema, which is what N400 exists to
build and why node construction belongs in Rust rather than in Swift (plan
§3 D1).

**Inserted blocks omit their declared props.** BlockNote's own paragraph
carries `backgroundColor`, `textAlignment` and `textColor` at their declared
defaults; `insert_paragraph` writes a bare `paragraph`. Both documents render
identically, so nothing is lost today — but they are not the same document, so
iOS cannot be held to byte parity with desktop until the writer knows the
declared props.

Worth recording because the chapter misled here: §12.5.0 says "a block's props
are omitted when they equal their declared defaults", which describes the
hand-built `text-extract` fixtures and **not** BlockNote's writer. The chapter
now says so explicitly.

---

## Q4 — How does an `image` block bind to an attachment id? (found by N206)

**Answered by N206a: the basename of `manifest.filename`, scoped to one note's
reference list. Not a guess \u2014 it is what desktop already does, in both
directions.**

Option 3 is ruled out: nothing on the note payload carries a url-to-id map.
The payload has exactly two attachment fields (`sync-payloads.ts:265-266`), and
the singular `attachmentId` is **not** a cover or a primary image. The redriver
says what it is outright: "Binary note: the note file itself IS the
attachment" (`attachment-download-redriver.ts:89-91`) \u2014 a note that _is_ a PDF
rather than a note that _contains_ one. N208's cover is a different field and
must not be read from here.

Option 1 is unnecessary, because the binding is already implied by two pieces
of desktop behaviour that meet in the middle:

- **Download** materialises an embedded attachment at
  `path.join(targetPath, sanitizeFilename(path.basename(manifest.filename)))`
  where `targetPath` is `getNoteAttachmentsDir(vaultPath, noteId)`, i.e.
  `<vault>/attachments/<noteId>/` (`attachments.ts:717-719`,
  `vault/attachments.ts:257-259`). The filename comes from the **signed,
  decrypted** manifest, and is basenamed and sanitised so a crafted manifest
  cannot escape the directory.
- **Read** resolves a block's url against the vault, treating
  `attachments/<noteId>/\u2026` as root-relative rather than note-relative
  (`vault/attachment-actions.ts:113-115`).

So the file desktop writes for an attachment id and the file a block's url
names are the same path, and the only varying part is
`basename(manifest.filename)`. That is the binding.

**The collision I worried about does not exist at the scope I worried about.**
Each note has its own attachments directory, so two notes both referencing
`screenshot.png` never meet. The residual case is one note referencing two
attachments whose filenames share a basename \u2014 and desktop cannot distinguish
those either, because both materialise to the same path and one overwrites the
other. iOS therefore **refuses an ambiguous match and draws the placeholder**
rather than picking one, which is the only answer that cannot show the wrong
picture.

**A url carrying a scheme is not a vault attachment.** `resolveAttachment`
refuses `http:`, `data:` and absolute paths deliberately, and calls a remote
image "ordinary content, not a defect". iOS keeps that distinction rather than
hunting for an attachment that was never uploaded.

The rule, then: percent-decode the url, take its basename, and match it against
`basename(manifest.filename)` among **this note's** cached references. Exactly
one match binds; zero or more than one draws the placeholder.

---

### Original statement of the question

Not in the original question list, because nothing suggested the two ends did
not already meet. They do not.

A note's `attachmentReferences` carries **attachment ids** (§14.7), and
`GET /sync/attachments/<id>/manifest` is keyed by exactly that. But an `image`
block in the body carries a `url`, and on desktop that url is a
**vault-relative file path**: `resolveAttachment(noteId, url)` joins it against
the note's directory inside the vault root and hands back a file
(`apps/desktop/src/main/vault/attachment-actions.ts:76`). A url with a scheme
or a leading slash is deliberately _not_ a vault attachment and is refused.

So desktop never needs the binding this phase needs: it has a file tree and the
block's url is a path into it. **iOS has no vault file tree at all** — the body
is a CRDT document and the attachment channel is the only source of bytes — so
nothing on the phone turns `pictures/diagram.png` into an attachment id.

**Why the obvious rule is not good enough to just write.** Matching the url's
basename against `manifest.filename` looks like it works and is not sound:
nothing makes a filename unique within a vault, so two notes referencing
`screenshot.png` in two folders collide, and a note referencing two attachments
whose files share a basename cannot be disambiguated at all. A wrong match here
shows **the wrong picture in the wrong note**, which is worse than showing a
placeholder.

There is a second thread to follow before deciding. Desktop's
`recordUploadedAttachment` writes **`attachmentId` singular** onto the note's
metadata alongside the plural `attachmentReferences`
(`apps/desktop/src/main/sync/note-attachment-metadata.ts:22-24`), and mirrors
only the singular one into the index cache. If that field is the note's cover
or primary image it is what N208 should read, and it is not a general answer
for a body block.

Candidate answers, none picked yet:

1. the manifest gains the vault-relative path the upload used, so a reader
   matches the same string the block carries — needs a writer change and a
   compatibility story for every manifest already written;
2. the reader matches on basename and **refuses** an ambiguous match rather
   than guessing, drawing the placeholder instead;
3. something already on the note payload carries the binding and this is a read
   nobody has found yet.

Option 3 has to be ruled out before either of the others is built, because
changing a written format to recover information already on the wire would be
the expensive wrong answer.

## Q3 — Does the Rust core reimplement manifest signing?

**It reimplements it, held by a conformance vector. Answered by N205.**

The task offered two options: reimplement against
`packages/sync-client/src/push/attachment-manifest.ts` with a vector holding
the two ports together, or lift the shared logic somewhere both call. **The
second option does not exist**, and that is most of the answer: there is no
shared runtime. The core is a standalone Rust port that a Swift shell links as
a static library; it cannot call a TypeScript module, and §14.4.1 forbids the
third option of not verifying at all. So the real choice was only
"reimplement carefully" against "reimplement carelessly".

It is also far smaller than "the largest unknown in this phase" suggested,
because the core already owns every primitive:

| Piece                            | Already in the core                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| the CBOR field order             | `crypto/cbor.rs:55` `ATTACHMENT_MANIFEST`, already present and already reachable through `by_name` |
| canonical CBOR encoding          | `crypto::cbor::encode`, pinned by `cbor-canonical.json`                                            |
| detached Ed25519 sign and verify | `crypto::sodium::sign_detached` and `sign_verify_detached`, pinned by `crypto-vectors.json`        |
| AEAD encrypt and decrypt         | `crypto::sodium::aead_encrypt` and `aead_decrypt`, pinned by `crypto-vectors.json`                 |
| file-key wrap and unwrap         | the same AEAD under the vault key, exactly as `protocol::envelope` already does for a record       |

So N205 is assembly, not cryptography: build the four-field map in
`ATTACHMENT_MANIFEST` order, sign it, and on read **verify before unwrapping
and decrypting**. That order is normative (§14.4.1) and it is the one thing an
assembler is likely to get backwards, because the natural way to write the
function is to decrypt first and check the signature afterwards.

**Where the real risk sits, and what the vector therefore pins.** The signature
covers the four envelope fields, not the manifest body, and the body crosses as
`JSON.stringify(manifest)`. A Rust writer that emitted the same fields in a
different order, or spelled a number differently, would produce a manifest the
TypeScript reader still parses — JSON object order means nothing to a parser —
so nothing would fail loudly and the two ports would drift silently. The class
therefore pins the **manifest bytes** as well as the envelope, and is generated
from the TypeScript writer so the Rust port is held to what desktop really
emits.

---

## The editor architecture (N300, N301)

**One `UITextView` per block, in a lazy list.** Measured in
`apps/ios/SpikeEvidence/N300-editor-architecture.md`; the harness is
`apps/ios/MemryTests/EditorArchitectureSpikeTests.swift`, so the figures can be
re-run rather than believed.

### Why, in the order the evidence actually landed

**The obvious comparison points the other way, and it is the wrong
comparison.** Building all 500 blocks as text views costs 0.8s against
0.0007s for one document-wide TextKit 2 layout — three orders of magnitude,
and it describes an architecture nobody ships. A lazy list holds a screenful.
Measured against the shape that deploys, a screenful of text views costs
**0.0179s against 0.0195s to lay out the whole note**, and the document-wide
side cannot make that trade: one layout cannot be partially resident, so
opening a note means laying out all of it.

**A keystroke is 4.8x cheaper per-block** — 0.000295s against 0.00141s. A note
is laid out once and typed into thousands of times, so this is the figure the
decision rests on rather than the opening cost.

**Half the registry is not text.** Nine of the eighteen block types — table,
image, audio, video, file, bookmark, divider, `taskBlock`, `youtubeEmbed` —
are not characters in a string. A document-wide layout hosts them only as
attachments, which means building those views anyway _and_ pinning each to a
character range.

**And the core's write surface is block-addressed.** Every `BlockEdit` takes a
block id, or a table id plus row and column. A document-wide layout would need
an offset-to-block reconciliation layer on every edit, and that layer is
exactly where an edit lands on the wrong block without anything failing.

### What this costs, stated rather than buried

**Caret and selection across block boundaries become the shell's work.**
Document-wide gets both free — crossing a boundary is an offset change inside
one range. Per-block, crossing is a change of first responder that the shell
implements and restores, and a selection spanning three blocks is three
selections it coordinates. That is N501's job, and it is the accepted trade,
not an oversight.

**Undo spans views rather than one `UITextView`'s built-in stack**, which is
why N509 specifies a native undo stack over the operations the shell issued.
**iOS and desktop undo granularity may therefore differ** — desktop groups by
ProseMirror transaction, iOS by issued operation — and that difference is
accepted rather than engineered away.

**The open risk is at boundaries.** Dictation, autocorrect and IME composition
are `UITextView` behaviours, and per-block keeps a real `UITextView` per
editable block, so each works unchanged _within_ a block. An IME composing
across a block break, or dictation running past the end of a paragraph, is the
case that carries risk. **The spike did not measure any of them** — a test
process cannot — and nothing above is presented as evidence about them. The
risk is carried into N501 as an open risk.

### Why `lexical-ios` is not the answer

Evaluated and rejected; plan.md §3 D3 records the same conclusion.

**There is no Swift Yjs binding.** Lexical's document model would have to be
reconciled with the `prosemirror` Y.XmlFragment on every edit, which is the
offset-to-block reconciliation problem above with an extra document model in
the middle. The core already exposes block-addressed operations that map 1:1
to what a per-block surface issues.

**Its document model is incompatible with the y-prosemirror fragment.**
Lexical nodes are not ProseMirror nodes; §12.5.0 is normative about the exact
node shapes BlockNote can construct, and a node y-prosemirror cannot build is
deleted silently. Adopting a second model would mean holding _three_ shapes in
agreement — Lexical's, ProseMirror's, and the canonical rendering — instead of
one.

**And upstream describes it as pre-release with no guarantee of support.**
That is a poor foundation for the surface a user types into.

---

## The `clientID` is derived from the device id (found by R05)

Writing the offline-convergence test produced garbled text rather than a
merge: two paragraphs written on two devices came back as
`"written on the phoneop"`. Not a lost edit — a **corrupted** one.

The cause is that `DocumentRegistry::new(device_id, sink)` derives the Y.Doc
`clientID` from the device id, and the test had opened both sides under the
same name. Two Yjs documents sharing a `clientID` mint **conflicting struct
ids**, so their updates do not merge; they interleave into nonsense.

It was a defect in the test rather than in the core, and it is recorded
because the failure mode is so misleading. Yjs's guarantee is convergence
_given distinct clients_, and nothing in the API reminds a caller of the
precondition. A harness that shares a device id across "two devices" produces
a result that looks like a CRDT bug and is not one.

**The rule for any future multi-device test**: same document id, different
device ids. That is what two real devices are, and
`roundtrip_acceptance.rs::opened_on` exists to make it hard to get wrong.

## What R01, R02, R06 and R07 still need

R03, R04 and R05 are proved in `crates/memry-core/tests/roundtrip_acceptance.rs`
because all three are properties of the CRDT layer and a core test can hold
them honestly.

**The other four are not done, and are not counted as done.** Each needs a
second real client:

- **R01** and **R02** need desktop to write the vault markdown file, so that
  "changed only in the edited region" and "the same `table-layout` bytes it
  would have written itself" can be compared against a real file.
- **R06** needs a server holding chunks, to confirm an uploaded picture lands
  with a matching checksum and that its chunks are dereferenced on delete.
- **R07** needs bytes that genuinely have not arrived yet.

An in-process approximation asserting something weaker under those names would
be worse than leaving them open, because it would read as coverage.

---

## Q2 — Where does the property write path belong?

**Beside the projection, in `domain/properties.rs`, and it was already there.
Answered by N700.**

The task offered two homes: next to `domain/note_meta.rs`, or in the note
record payload handler. Neither is right, and the reason is that a property
value is not metadata _about_ a note and not a field _of_ the record — it is
one key inside the record's free-form `properties` object (§13.7.1). Writing
one means reading that object, changing one key, and pushing the whole object
back, which is exactly what `domain/properties.rs` already did for `set` and
`clear`.

**So N700 was mostly exposure rather than implementation.** The domain half —
including FR-048's retype refusal — predates this feature. What was missing is
that nothing reached it: no API method existed, so no shell could call it.
`NotesWriter::set_property` and `clear_property` are that surface.

Two decisions worth recording:

**The value crosses as JSON text, not a typed union.** §13.7.1 lets a property
hold any JSON, and a closed enum at the FFI would have to drop or coerce
whatever did not fit. It is also what makes _one_ call serve all ten property
types instead of ten near-identical calls, since the shell already reads
`type_name` alongside the value.

**`PropertyWriteError` is a separate type from `PropertyError`.** The domain
error carries `&'static str` discriminants, which do not cross the FFI.
Reshaping a domain type to suit the binding generator is the wrong direction
of dependency, so the API layer owns its own error and converts. `Retyped`
stays a distinct case rather than collapsing into a storage failure, because
FR-048 is about a surface being able to say "that is not a valid value for
this property" rather than "something went wrong".
