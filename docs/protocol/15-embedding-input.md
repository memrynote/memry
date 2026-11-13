# 15 — Embedding input

**Status**: normative between implementations. **Device-local, never on the
wire.** Every normative sentence carries a `path:line` citation (chapter 00
§0.1).

The text an implementation feeds its embedding model for a note or a search
query. No byte of it, and no vector built from it, leaves the device. It is
specified because two implementations build vectors from it: desktop
(`apps/desktop/src/main/lib/embedding-input.ts`) and the Rust core
(`crates/memry-core/src/domain/embedding_input.rs`). When both feed the same
model the same text, a query on one device ranks notes the way it does on the
other.

The `embedding-input` vector class
(`packages/contracts/test-vectors/embedding-input.json`) pins every rule below.
Its generator imports desktop's module
(`packages/contracts/scripts/vectors/embedding-input.ts`), and
`crates/memry-core/tests/embedding_input_vectors.rs` replays it through the
core. The class's `meta` carries the constants, because
`protocol-chapters.test.ts` cannot import desktop code.

## 15.1 Units

**Normative.** Every length, slice and search counts **UTF-16 code units**,
JavaScript's `string.length` (`embedding-input.ts:79`, `:98-99`, `:119-122`).
A cut can split a surrogate pair. Each lone surrogate a cut leaves is read as
U+FFFD, the result of `toWellFormed()`
(`packages/contracts/scripts/vectors/embedding-input.ts:238`).

**Normative.** "Trim" is JavaScript's `String.prototype.trim`
(`embedding-input.ts:72-73`, `:94-95`, `:108-109`, `:129`). It strips U+FEFF
and keeps U+0085, unlike Rust's `str::trim`.

## 15.2 Constants

| Constant                  | Value  | Citation                 |
| ------------------------- | ------ | ------------------------ |
| window limit              | `4000` | `embedding-input.ts:18`  |
| windows per note          | `16`   | `embedding-input.ts:25`  |
| title units in a chunk    | `200`  | `embedding-input.ts:30`  |
| minimum title + body      | `10`   | `embedding-input.ts:37`  |
| `EMBEDDING_INPUT_VERSION` | `6`    | `embedding-input.ts:144` |

**Normative.** A change to any rule in this chapter bumps
`EMBEDDING_INPUT_VERSION` (`embedding-input.ts:134-144`), so stored vectors
rebuild. The core asserts its own constant equals the class's
`meta.inputVersion` (`crates/memry-core/tests/embedding_input_vectors.rs:20-29`), so
a desktop bump fails Rust CI until the port is reviewed. On desktop, version 6
also covers a similarity vector the core does not build. In the core, 6 means
the shaping this chapter pins.

## 15.3 Query input

**Normative.** The query is trimmed. A blank query has no input. Otherwise the
input is `task: search result | query: ` followed by the trimmed query, cut at
4000 units (`embedding-input.ts:60`, `:128-132`).

## 15.4 Note windows

**Normative.** Title and content are each trimmed. When the trimmed title's
length plus the trimmed content's length is under 10, the note has no windows
(`embedding-input.ts:94-96`).

**Normative.** Every window is `header + piece`. The header is
`title: {T} | text: `, where `T` is the trimmed title's first 200 units, or
`none` when the trimmed title is empty (`embedding-input.ts:98`). The budget
is 4000 minus the header's length (`:99`).

**Normative.** The content is split into pieces, at most 16
(`embedding-input.ts:100-110`):

1. When the rest fits the budget, it is the last piece.
2. Otherwise the cut is found in the rest's first `budget` units. For each
   separator in order `\n\n`, `\n`, `. `, ` `, take its last occurrence. The
   first one whose start is at or after `budget / 2`, with no rounding, sets
   the cut just past it. With none, the cut is `budget`
   (`embedding-input.ts:116-125`).
3. The piece is the rest before the cut, trimmed. The new rest is the rest
   after the cut, trimmed.

**Normative.** The first piece is always kept, even when empty. A later piece
under 10 units is dropped (`embedding-input.ts:111-113`). Window 0 is the head
window.

## 15.5 Document input

**Normative.** The single-window document input uses the same minimum and the
header with the **whole** trimmed title, not its first 200 units, then the
whole trimmed content, cut at 4000 units (`embedding-input.ts:68-80`). The
core pins it for drift and does not embed it.
