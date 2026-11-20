//! Readwise: the pure planners that decide what a book, Reader document or journal day looks
//! like in the vault (`packages/importers/src/readwise/`), and the image file names
//! (`apps/desktop/src/main/readwise/images.ts`). The section markers, the hash and the
//! rendered bytes are a vault format that Electron, iOS and this build share, so
//! `tests/readwise_vectors.rs` holds every function here to the vectors the TypeScript writes
//! (`packages/contracts/test-vectors/readwise/`).
//!
//! The I/O seams beside them: the HTTP client (`client`), the Reader request budget
//! (`limiter`) and the token in the keychain (`token`).
//!
//! Strings are Rust strings where TypeScript has UTF-16: offsets are bytes, the hash and every
//! ordering of text run over UTF-16 code units as in JS. A Readwise payload with a lone
//! surrogate cannot reach here (`serde_json` refuses it), so no JS string the planners see is
//! lost.
//!
//! Time zones: Electron's `Intl.DateTimeFormat` reads the IANA data its ICU ships, this build
//! the data compiled into `chrono-tz`. The vectors hold the two equal for the zones they cover;
//! a zone whose rules change in a tzdb release one side has and the other lacks can put a
//! highlight's day one apart until both update.
//!
//! Departures from the TypeScript, on purpose. Each changes only input TypeScript mishandles,
//! so no vector changes; a vault that Electron and this build both write can see a section
//! rewritten between the two forms, which ends when Electron is retired.
//! - A highlight tag named `constructor` or `__proto__` is an ordinary tag. TypeScript looks
//!   tags up in a plain object (`HEADING_TAGS`), whose prototype makes both heading markers.
//! - `readwise_url` and `location_type` reach a `[label](url)` link. TypeScript writes them
//!   raw, so a payload can end the link or the line and add a remote image, a wiki link, a tag,
//!   a second end marker or a frontmatter-shaped block, or open a code span that swallows the
//!   link. Here a URL that is not `http(s)://` or holds a character outside RFC 3986 or one of
//!   `[`, `]`, `(`, `)` becomes `https://readwise.io/open/{id}`, and a location type keeps
//!   only its letters, digits and spaces, on one line (`highlights::highlight_url`,
//!   `location_label`).
//! - `escapeLine` breaks `[[` with `/\[\[/g`, which replaces without overlap and skips `[\[`,
//!   so highlight text such as `[[[x]]` or `[\[x]]` (which the markdown parser reads as
//!   `[[x]]`) keeps a wiki link. Here a line where such an opener has a `]` after it puts the
//!   zero-width space after every `[` that a `[` or `\[` follows; any other line keeps
//!   TypeScript's bytes (`text::escape_line`).

pub mod client;
pub mod highlights;
pub mod images;
pub mod journal;
pub mod limiter;
pub mod plan_append;
pub mod plan_note;
pub mod reader;
pub mod section;
pub mod text;
pub mod token;
pub mod types;

use std::cell::Cell;

/// What a planner could not do. TypeScript throws `RangeError: Invalid time value` from
/// `toISOString` when a section's `last` would fall past the end of the JS Date range.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("RangeError: Invalid time value")]
    InvalidTime,
    /// `planReaderNote` throws `TypeError` on a `null` Reader tag, or a tag name that is truthy
    /// and not a string.
    #[error("TypeError: a Reader tag is null or has a name that is not a string")]
    ReaderTag,
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
