//! The text fed to the embedding model for a note, a typed query, or a page or
//! image with its text: a port of Electron's `apps/desktop/src/main/lib/embedding-input.ts`.
//!
//! Every length, cut and slice counts UTF-16 code units, as JavaScript strings do,
//! so a window holds exactly the text Electron embedded and stored vectors keep
//! their meaning. A cut can split a surrogate pair; the halves become U+FFFD when
//! the units turn back into a `String`, which is what the vectors pin
//! (`packages/contracts/test-vectors/embedding-input.json`).

/// Units in one model window, task prefix included.
pub const MAX_EMBEDDING_INPUT_LENGTH: usize = 4000;
/// Windows embedded per note; a longer note is cut there.
pub const MAX_EMBEDDING_CHUNKS: usize = 16;
/// Units of note text a reader hands to [`build_embedding_chunks`]; the rest is never used.
pub const MAX_EMBEDDABLE_CONTENT_LENGTH: usize = MAX_EMBEDDING_INPUT_LENGTH * MAX_EMBEDDING_CHUNKS;
/// Units of a page's or image's own text that join its pixels in one vector.
pub const MAX_INTERLEAVED_TEXT_LENGTH: usize = 2500;
/// Bump when the text of [`build_embedding_input`] or [`build_embedding_chunks`]
/// changes, so stored note vectors are rebuilt (`note_embedding_state.input_version`).
pub const EMBEDDING_INPUT_VERSION: u32 = 6;
/// Bump when the bytes fed to the vision encoder change, so image vectors are rebuilt.
pub const IMAGE_EMBEDDING_INPUT_VERSION: u32 = 2;

const MAX_CHUNK_TITLE_LENGTH: usize = 200;
/// Title plus body shorter than this has too little signal to embed.
const MIN_EMBEDDING_TEXT_LENGTH: usize = 10;
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

type Units = Vec<u16>;

fn units(text: &str) -> Units {
    text.encode_utf16().collect()
}

fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn concat(parts: &[&[u16]]) -> Units {
    parts.concat()
}

/// The code units `String.prototype.trim` strips: ECMAScript WhiteSpace and
/// LineTerminator. U+FEFF is in; U+0085 is not.
fn is_js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn js_trim(text: &[u16]) -> &[u16] {
    let start = text
        .iter()
        .position(|&u| !is_js_space(u))
        .unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|&u| !is_js_space(u))
        .map_or(start, |i| i + 1);
    &text[start..end]
}

/// `text.slice(0, n)` by code units.
fn head(text: &[u16], n: usize) -> &[u16] {
    &text[..n.min(text.len())]
}

/// Trimmed title and body, or `None` when together they are under the minimum.
fn trimmed_parts(title: Option<&str>, content: Option<&str>) -> Option<(Units, Units)> {
    let title = title
        .map(|t| js_trim(&units(t)).to_vec())
        .unwrap_or_default();
    let content = content
        .map(|c| js_trim(&units(c)).to_vec())
        .unwrap_or_default();
    (title.len() + content.len() >= MIN_EMBEDDING_TEXT_LENGTH).then_some((title, content))
}

/// The text fed to the model for one note or inbox item, for `task`. The title
/// leads so it survives the cut; an untitled note reads `title: none` for
/// `Document` and starts at its text for `Similarity`. Empty when the note is too
/// short to embed.
pub fn build_embedding_input(
    title: Option<&str>,
    content: Option<&str>,
    task: EmbeddingTask,
) -> String {
    let Some((title, content)) = trimmed_parts(title, content) else {
        return String::new();
    };
    let content = head(&content, MAX_EMBEDDING_INPUT_LENGTH);
    let input = match task {
        EmbeddingTask::Similarity => {
            let newline = if title.is_empty() {
                &[][..]
            } else {
                &[0x0a][..]
            };
            concat(&[&units(SIMILARITY_PREFIX), &title, newline, content])
        }
        EmbeddingTask::Document => {
            let title = if title.is_empty() {
                units("none")
            } else {
                title
            };
            concat(&[&units("title: "), &title, &units(" | text: "), content])
        }
    };
    lossy(head(&input, MAX_EMBEDDING_INPUT_LENGTH))
}

/// A note split into model windows, each carrying the same title header: the
/// head window first, then the rest. Windows break at a paragraph, line,
/// sentence or word boundary in the second half of the window when one exists.
/// Later windows under the minimum are dropped. Empty when the note is too short.
pub fn build_embedding_chunks(title: Option<&str>, content: Option<&str>) -> Vec<String> {
    let Some((title, content)) = trimmed_parts(title, content) else {
        return Vec::new();
    };
    let title = head(&title, MAX_CHUNK_TITLE_LENGTH);
    let title = if title.is_empty() {
        units("none")
    } else {
        title.to_vec()
    };
    let header = concat(&[&units("title: "), &title, &units(" | text: ")]);
    let budget = MAX_EMBEDDING_INPUT_LENGTH.saturating_sub(header.len());
    let mut pieces: Vec<&[u16]> = Vec::new();
    let mut rest: &[u16] = &content;
    while pieces.len() < MAX_EMBEDDING_CHUNKS {
        if rest.len() <= budget {
            pieces.push(rest);
            break;
        }
        let cut = find_chunk_cut(rest, budget);
        pieces.push(js_trim(&rest[..cut]));
        rest = js_trim(&rest[cut..]);
    }
    pieces
        .into_iter()
        .enumerate()
        .filter(|(index, piece)| *index == 0 || piece.len() >= MIN_EMBEDDING_TEXT_LENGTH)
        .map(|(_, piece)| lossy(&concat(&[&header, piece])))
        .collect()
}

/// Where to end a window of `text` (longer than `budget`): just after the last
/// separator in the window's second half, trying each separator in order, else
/// at the budget.
fn find_chunk_cut(text: &[u16], budget: usize) -> usize {
    let window = head(text, budget);
    for separator in CHUNK_BREAKS {
        let separator = units(separator);
        let last = window
            .windows(separator.len())
            .rposition(|w| w == separator.as_slice());
        // `at >= budget / 2` in JavaScript, where the division is not truncated.
        if let Some(at) = last.filter(|at| 2 * at >= budget) {
            return at + separator.len();
        }
    }
    budget
}

/// The text fed to the model for a typed search query; empty for a blank query.
pub fn build_query_embedding_input(query: &str) -> String {
    let query = units(query);
    let text = js_trim(&query);
    if text.is_empty() {
        return String::new();
    }
    lossy(head(
        &concat(&[&units(QUERY_PREFIX), text]),
        MAX_EMBEDDING_INPUT_LENGTH,
    ))
}

/// The model input for a page or image with the text read from it: the document
/// prefix, the text, then the image placeholder the processor expands to the
/// image's soft tokens. `None` when the text is too short to add signal, in which
/// case the image is embedded alone.
pub fn build_interleaved_input(text: Option<&str>) -> Option<String> {
    let text = units(text.unwrap_or_default());
    let body = js_trim(&text);
    if body.len() < MIN_EMBEDDING_TEXT_LENGTH {
        return None;
    }
    let body = head(body, MAX_INTERLEAVED_TEXT_LENGTH);
    Some(lossy(&concat(&[
        &units("title: none | text: "),
        body,
        &units(" <|image|>"),
    ])))
}

#[cfg(test)]
#[path = "embedding_input_tests.rs"]
mod tests;
