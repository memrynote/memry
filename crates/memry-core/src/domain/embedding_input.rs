//! The text fed to the embedding model, ported from desktop's
//! `apps/desktop/src/main/lib/embedding-input.ts` and pinned by the
//! `embedding-input` vector class and `docs/protocol/15-embedding-input.md`.
//!
//! Every length, slice and `lastIndexOf` counts UTF-16 code units, so the work
//! happens on `Vec<u16>`. Text returns through `String::from_utf16_lossy`: a cut
//! that splits a surrogate pair gives U+FFFD, which is what the generator's
//! `toWellFormed()` gives on desktop's output. Trims are JavaScript's `trim`,
//! never `str::trim`, which also strips U+0085.

use super::journal_rules::is_js_whitespace;

/// Bumped on desktop whenever the shaped text changes. A Rust test holds it to
/// the vector class's `meta.inputVersion`.
pub const EMBEDDING_INPUT_VERSION: u32 = 6;
pub const MAX_INPUT_UNITS: usize = 4000;
pub const MAX_WINDOWS: usize = 16;
pub const MAX_CHUNK_TITLE_UNITS: usize = 200;
pub const MIN_TEXT_UNITS: usize = 10;

const QUERY_PREFIX: &str = "task: search result | query: ";
const CHUNK_BREAKS: [&str; 4] = ["\n\n", "\n", ". ", " "];

/// One model input, at most [`MAX_INPUT_UNITS`] UTF-16 units. Only this module
/// builds one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window(String);

impl Window {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn from_units(units: &[u16]) -> Self {
        Window(String::from_utf16_lossy(
            &units[..units.len().min(MAX_INPUT_UNITS)],
        ))
    }
}

/// `buildQueryEmbeddingInput`. `None` for a blank query.
pub fn query_input(query: &str) -> Option<Window> {
    let query = units(query);
    let text = js_trim(&query);
    if text.is_empty() {
        return None;
    }
    Some(Window::from_units(
        &[&units(QUERY_PREFIX)[..], text].concat(),
    ))
}

/// `buildEmbeddingInput` for the `document` task: the one window of a note,
/// cut at [`MAX_INPUT_UNITS`]. `None` when the note is too short to embed.
pub fn document_input(title: &str, content: &str) -> Option<Window> {
    let (title, content) = (units(title), units(content));
    let (title, content) = (js_trim(&title), js_trim(&content));
    if title.len() + content.len() < MIN_TEXT_UNITS {
        return None;
    }
    Some(Window::from_units(&[&header(title)[..], content].concat()))
}

/// `buildEmbeddingChunks`: the head window, then up to [`MAX_WINDOWS`] in all,
/// each behind the same title header. A window breaks at the last paragraph,
/// line, sentence or word boundary in its second half, else at the budget.
/// Later windows under [`MIN_TEXT_UNITS`] are dropped. Empty when the note is
/// too short to embed.
pub fn chunks(title: &str, content: &str) -> Vec<Window> {
    let (title, content) = (units(title), units(content));
    let (title, mut rest) = (js_trim(&title), js_trim(&content));
    if title.len() + rest.len() < MIN_TEXT_UNITS {
        return Vec::new();
    }
    let header = header(&title[..title.len().min(MAX_CHUNK_TITLE_UNITS)]);
    let budget = MAX_INPUT_UNITS - header.len();
    let mut pieces: Vec<&[u16]> = Vec::new();
    while pieces.len() < MAX_WINDOWS {
        if rest.len() <= budget {
            pieces.push(rest);
            break;
        }
        let cut = chunk_cut(rest, budget);
        pieces.push(js_trim(&rest[..cut]));
        rest = js_trim(&rest[cut..]);
    }
    pieces
        .into_iter()
        .enumerate()
        .filter(|(index, piece)| *index == 0 || piece.len() >= MIN_TEXT_UNITS)
        .map(|(_, piece)| Window::from_units(&[&header[..], piece].concat()))
        .collect()
}

/// `findChunkCut`: just past the last separator found at or after half the
/// budget, trying each separator in [`CHUNK_BREAKS`] order.
fn chunk_cut(text: &[u16], budget: usize) -> usize {
    let window = &text[..budget];
    for separator in CHUNK_BREAKS {
        let separator = units(separator);
        let at = window
            .windows(separator.len())
            .rposition(|candidate| candidate == separator.as_slice());
        // `at >= budget / 2` in JS, where the division is not floored.
        if let Some(at) = at.filter(|at| 2 * at >= budget) {
            return at + separator.len();
        }
    }
    budget
}

/// `title: {title or none} | text: `.
fn header(title: &[u16]) -> Vec<u16> {
    let title = if title.is_empty() {
        units("none")
    } else {
        title.to_vec()
    };
    [&units("title: ")[..], &title, &units(" | text: ")].concat()
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `String.prototype.trim` over code units. Every JS whitespace character is
/// in the BMP, and a lone surrogate is never whitespace.
fn js_trim(text: &[u16]) -> &[u16] {
    let space = |unit: &u16| char::from_u32(u32::from(*unit)).is_some_and(is_js_whitespace);
    let start = text
        .iter()
        .position(|unit| !space(unit))
        .unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|unit| !space(unit))
        .map_or(start, |at| at + 1);
    &text[start..end]
}
