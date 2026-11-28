//! The text fed to the embedding model for a note, a typed query, or a page or
//! image with its text, ported from desktop's
//! `apps/desktop/src/main/lib/embedding-input.ts` and pinned by the
//! `embedding-input` vector class (`docs/protocol/15-embedding-input.md`) and
//! the Electron oracle's cases
//! (`packages/contracts/test-vectors/embedding-input-electron.json`).
//!
//! Every length, slice and `lastIndexOf` counts UTF-16 code units, so the work
//! happens on `Vec<u16>`, and a window holds exactly the text desktop embedded.
//! Text returns through `String::from_utf16_lossy`: a cut that splits a
//! surrogate pair gives U+FFFD, which is what the generators' `toWellFormed()`
//! gives on desktop's output. Trims are JavaScript's `trim`, never `str::trim`,
//! which also strips U+0085.

use super::journal_rules::is_js_whitespace;

/// Bumped on desktop whenever the shaped text or the token cap changes. A Rust
/// test holds it to the vector class's `meta.inputVersion`, another to the
/// oracle's `constants.embeddingInputVersion`. Stored vectors stamped with an
/// older version are rebuilt (`input_version`).
pub const EMBEDDING_INPUT_VERSION: u32 = 7;
/// Desktop's v6: the text of [`EMBEDDING_INPUT_VERSION`] fed to the model
/// without [`cap_tokens`]. The Tauri desktop's text path (`memry-ml`
/// `token_ids`) does not cap tokens yet, so the index.db note and transcript
/// vectors it builds (`note_embeddings`, `voice_embeddings`) carry this stamp,
/// and Electron, which caps, rebuilds them rather than trusting them.
pub const UNCAPPED_EMBEDDING_INPUT_VERSION: u32 = 6;
/// Bump when the bytes fed to the vision encoder change, so image vectors are rebuilt.
pub const IMAGE_EMBEDDING_INPUT_VERSION: u32 = 2;
pub const MAX_INPUT_UNITS: usize = 4000;
/// Tokens of one model input, BOS and EOS included. Units do not bound tokens:
/// a 4000-unit window of CJK Extension B is ~8000, and attention memory grows
/// with the square of the count.
pub const MAX_INPUT_TOKENS: usize = 1536;
pub const MAX_WINDOWS: usize = 16;
pub const MAX_CHUNK_TITLE_UNITS: usize = 200;
pub const MIN_TEXT_UNITS: usize = 10;
/// Desktop's name for [`MAX_INPUT_UNITS`].
pub const MAX_EMBEDDING_INPUT_LENGTH: usize = MAX_INPUT_UNITS;
/// Desktop's name for [`MAX_WINDOWS`].
pub const MAX_EMBEDDING_CHUNKS: usize = MAX_WINDOWS;
/// Units of note text a reader hands to [`chunks`]; the rest is never used.
pub const MAX_EMBEDDABLE_CONTENT_LENGTH: usize = MAX_INPUT_UNITS * MAX_WINDOWS;
/// Units of a page's or image's own text that join its pixels in one vector.
pub const MAX_INTERLEAVED_TEXT_LENGTH: usize = 2500;

const QUERY_PREFIX: &str = "task: search result | query: ";
const SIMILARITY_PREFIX: &str = "task: sentence similarity | query: ";
const CHUNK_BREAKS: [&str; 4] = ["\n\n", "\n", ". ", " "];

/// What a note's vector is for: read by search (`Document`) or compared with
/// another note (`Similarity`, both sides share the symmetric prefix).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingTask {
    Document,
    Similarity,
}

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

/// `buildEmbeddingInput` for the `similarity` task: the title leads, then a
/// newline, then the text; an untitled note starts at its text. `None` when the
/// note is too short to embed.
fn similarity_input(title: &str, content: &str) -> Option<Window> {
    let (title, content) = (units(title), units(content));
    let (title, content) = (js_trim(&title), js_trim(&content));
    if title.len() + content.len() < MIN_TEXT_UNITS {
        return None;
    }
    let newline: &[u16] = if title.is_empty() { &[] } else { &[0x0a] };
    Some(Window::from_units(
        &[&units(SIMILARITY_PREFIX)[..], title, newline, content].concat(),
    ))
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

/// `capEmbeddingTokens`: past [`MAX_INPUT_TOKENS`], the first tokens and then
/// the input's last one, so the model still sees its closing EOS.
pub fn cap_tokens(ids: &mut Vec<u32>) {
    if ids.len() > MAX_INPUT_TOKENS {
        let last = ids[ids.len() - 1];
        ids.truncate(MAX_INPUT_TOKENS - 1);
        ids.push(last);
    }
}

/// The text fed to the model for one note or inbox item, for `task`: the
/// [`document_input`] or similarity window as a string, empty when the note is
/// too short to embed.
pub fn build_embedding_input(
    title: Option<&str>,
    content: Option<&str>,
    task: EmbeddingTask,
) -> String {
    let (title, content) = (title.unwrap_or_default(), content.unwrap_or_default());
    let window = match task {
        EmbeddingTask::Document => document_input(title, content),
        EmbeddingTask::Similarity => similarity_input(title, content),
    };
    window.map(|window| window.0).unwrap_or_default()
}

/// [`chunks`] as strings.
pub fn build_embedding_chunks(title: Option<&str>, content: Option<&str>) -> Vec<String> {
    chunks(title.unwrap_or_default(), content.unwrap_or_default())
        .into_iter()
        .map(|window| window.0)
        .collect()
}

/// [`query_input`] as a string, empty for a blank query.
pub fn build_query_embedding_input(query: &str) -> String {
    query_input(query)
        .map(|window| window.0)
        .unwrap_or_default()
}

/// The model input for a page or image with the text read from it: the document
/// prefix, the text, then the image placeholder the processor expands to the
/// image's soft tokens. `None` when the text is too short to add signal, in which
/// case the image is embedded alone.
pub fn build_interleaved_input(text: Option<&str>) -> Option<String> {
    let text = units(text.unwrap_or_default());
    let body = js_trim(&text);
    if body.len() < MIN_TEXT_UNITS {
        return None;
    }
    let body = &body[..body.len().min(MAX_INTERLEAVED_TEXT_LENGTH)];
    Some(String::from_utf16_lossy(
        &[
            &units("title: none | text: ")[..],
            body,
            &units(" <|image|>"),
        ]
        .concat(),
    ))
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

#[cfg(test)]
#[path = "embedding_input_tests.rs"]
mod tests;
