//! Markdown conversion in both directions, the Rust port of the Electron
//! converter (`apps/desktop/src/main/sync/blocknote-converter.ts` and the
//! packages under it). Compiled only with the cargo feature `markdown`; the iOS
//! build keeps it off.
//!
//! Stage 1 of the port (#3522): the byte-exact frontmatter rules and the
//! large-file classifier. The `markdown-convert` conformance class in
//! `packages/contracts/test-vectors/markdown-convert/` is the proof, generated
//! by running the TypeScript converter in place (`apps/desktop/scripts/markdown-oracle`).

pub mod frontmatter;
pub mod shared;

pub mod pm;
pub mod yxml;

pub mod bn;

pub mod convert;
pub mod schema;
