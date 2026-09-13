# Specification defect log

**Feature**: 002-native-foundation-ios | **Gate**: G3 (zero open entries), G5 (re-checked)

## The rule

SC-002 says the protocol specification is complete enough to build against. This file
is how that is measured rather than asserted.

**Every question that required reading TypeScript source during core development is
logged here.** If a Rust author had to open `packages/sync-client`, `apps/desktop` or
`apps/sync-server` to find out what the protocol does, the specification did not say
it, and that is a defect in the specification, not a note about the reader.

**An entry is closed by a change to the specification**, meaning a chapter under
`docs/protocol/` and, when a format is involved, the vectors that pin it. An entry is
not closed by writing the answer into Rust code, into a comment, into a commit
message, or into this file's notes column.

**Zero open entries is a gate.** G3 requires it before Rust feature work proceeds past
the vector tier, and G5 re-checks it before the headless round trip counts as
evidence. An open entry at either point stops the phase; it does not get carried.

Log the entry when the question is asked, not when it is answered. An entry that was
opened and closed in the same afternoon is the healthy case and is still worth having,
because the count of entries per chapter is the only signal available about which
chapters are thin.

## Entries

| #   | Date       | Chapter | Question                                                                                                                                                                                                                                                                                                                                                               | Source that had to be read                                                                                                                                                                                       | Spec change that closed it                                                                                                                                                                                                                                                                                                           | Status     |
| --- | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | 2026-09-13 | 04 §4.1 | Which deflate implementation and which compression level reproduce `pako.deflate`'s bytes? §4.1 said "a zlib wrapper — `flate2::ZlibEncoder`, not `DeflateEncoder`", which is necessary and not sufficient: `flate2`'s default `miniz_oxide` backend and its `zlib-rs` backend both emit a valid, longer, non-identical stream at level 6 and fail `compression.json`. | `node_modules/pako` run directly against the committed vector to recover the level, and `python3 -c "import zlib"` to confirm stock zlib reproduces it. The chapter named neither a level nor an implementation. | New §4.1.1, "The deflate implementation is part of the format": level 6, stock zlib, the explicit `default-features = false, features = ["zlib"]` selection, the three backends that fail, and why a round-trip test cannot catch any of it. No vector changed — the bytes were always right, the chapter's guidance was incomplete. | **Closed** |

**Open**: 0. **Closed**: 1.
