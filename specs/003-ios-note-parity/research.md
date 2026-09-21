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

## Q2 — Where does the property write path belong?

Open. Answered by N700.

---

## Q3 — Does the Rust core reimplement manifest signing?

Open. Answered by N205.
