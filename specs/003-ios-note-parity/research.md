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

## Q2 — Where does the property write path belong?

Open. Answered by N700.

---

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
