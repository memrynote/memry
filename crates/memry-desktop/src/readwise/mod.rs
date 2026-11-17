//! Readwise: the pure planners that decide what a book, Reader document or journal day looks
//! like in the vault (`packages/importers/src/readwise/`), and the image file names
//! (`apps/desktop/src/main/readwise/images.ts`). The section markers, the hash and the
//! rendered bytes are a vault format that Electron, iOS and this build share, so
//! `tests/readwise_vectors.rs` holds every function here to the vectors the TypeScript writes
//! (`packages/contracts/test-vectors/readwise/`).
//!
//! Strings are Rust strings where TypeScript has UTF-16: offsets are bytes, the hash and every
//! ordering of text run over UTF-16 code units as in JS. A Readwise payload with a lone
//! surrogate cannot reach here (`serde_json` refuses it), so no JS string the planners see is
//! lost.

pub mod highlights;
pub mod images;
pub mod journal;
pub mod plan_append;
pub mod plan_note;
pub mod reader;
pub mod section;
pub mod text;
pub mod types;

use std::cell::Cell;

/// What a planner could not do. TypeScript throws `RangeError: Invalid time value` from
/// `toISOString` when a section's `last` would fall past the end of the JS Date range.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("RangeError: Invalid time value")]
    InvalidTime,
}

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// One unit of planner work: a line read, a highlight rendered, a URL or id looked up.
pub(crate) fn step() {
    STEPS.with(|steps| steps.set(steps.get() + 1));
}

/// Steps the planners took on this thread, for the complexity tests (`memry-test-kit`).
#[doc(hidden)]
pub fn planner_steps() -> usize {
    STEPS.with(Cell::get)
}
