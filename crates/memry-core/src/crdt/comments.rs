//! Review comments and suggestions, read only (N604).
//!
//! **Read only, and that is normative rather than a scope decision.** §12.5.1
//! forbids a non-editor client writing the `criticMarkupMarks` root, and
//! §12.5.0's root table says what dropping it costs: every suggestion and
//! comment is deleted from the file on desktop's next write-back, and source
//! restoration flips back on, so the body is additionally re-spelled. Nothing
//! in this module writes.
//!
//! **And the shell must not normalise what it reads.** The reference reader
//! (`packages/shared/src/critic-markup/yjs.ts`) drops any element failing
//! shape validation rather than repairing it, so a mark this port "fixed"
//! would be a mark desktop does not have — the two clients would disagree
//! about which comments exist. This port drops exactly what that one drops.

use yrs::{Any, Array, ArrayRef, Map, ReadTxn};

use crate::crdt::errors::CrdtError;
use crate::crdt::registry::Document;

/// The Y.Doc root, spelled as `packages/shared/src/critic-markup/yjs.ts:9`
/// spells it.
pub const COMMENTS_ROOT: &str = "criticMarkupMarks";

/// What a mark is. The four kinds the reference reader accepts, and no others:
/// an unrecognised kind is dropped rather than carried as text, because the
/// reference drops it and a shell that kept it would render a mark desktop
/// does not show.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum CommentKind {
    Addition,
    Deletion,
    Substitution,
    Comment,
}

impl CommentKind {
    fn parse(value: &str) -> Option<CommentKind> {
        match value {
            "addition" => Some(CommentKind::Addition),
            "deletion" => Some(CommentKind::Deletion),
            "substitution" => Some(CommentKind::Substitution),
            "comment" => Some(CommentKind::Comment),
            _ => None,
        }
    }
}

/// One review mark.
///
/// `start` and `end` are **byte offsets into the note's flattened text**, not
/// block ids: a mark spans whatever text it covers, which may cross blocks.
/// Binding one to a block is the shell's job and is why those offsets are
/// carried verbatim rather than resolved here.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ReviewComment {
    pub id: String,
    pub kind: CommentKind,
    /// The text the mark covers as the reader sees it.
    pub visible_text: String,
    pub start: u32,
    pub end: u32,
    /// What the text was, for a substitution.
    pub original_text: Option<String>,
    /// A comment's own body.
    pub body: Option<String>,
    pub metadata: Option<String>,
    /// Milliseconds since the epoch, when the writer recorded one.
    pub created_at: Option<i64>,
}

/// Every review mark on this note, in document order.
///
/// **An empty list means "this note has none", which is different from the
/// root being absent** — but both arrive here as an empty list, because a
/// reader cannot tell them apart and must not pretend to. What it must not do
/// is *write* an empty root to make the distinction go away: that is the drop
/// §12.5.0 warns about.
pub fn extract_comments(document: &Document) -> Result<Vec<ReviewComment>, CrdtError> {
    document.read(|txn| {
        let Some(array) = txn.get_array(COMMENTS_ROOT) else {
            return Vec::new();
        };
        read_marks(&array, txn)
    })
}

fn read_marks<T: ReadTxn>(array: &ArrayRef, txn: &T) -> Vec<ReviewComment> {
    array
        .iter(txn)
        .filter_map(|value| {
            // A mark is a Y.Map in a live document and a plain `Any::Map`
            // when it arrived as JSON-ish data. Both shapes are read, because
            // the reference writer pushes plain objects.
            match value {
                yrs::Out::Any(Any::Map(fields)) => mark_from(&fields),
                yrs::Out::YMap(map) => {
                    let fields = map
                        .iter(txn)
                        .filter_map(|(key, value)| match value {
                            yrs::Out::Any(any) => Some((key.to_owned(), any)),
                            _ => None,
                        })
                        .collect();
                    mark_from(&fields)
                }
                _ => None,
            }
        })
        .collect()
}

/// One mark, or `None` when it fails the reference reader's validation.
///
/// **The validation is copied deliberately rather than loosened.** Every
/// rejection here is one the reference makes: a missing or non-string `id`, an
/// unrecognised `kind`, a missing `visibleText`, a non-finite or negative
/// offset, or an `end` before `start`. Accepting one of these would give this
/// client a comment desktop does not have.
fn mark_from(fields: &std::collections::HashMap<String, Any>) -> Option<ReviewComment> {
    let id = string_of(fields.get("id"))?;
    let kind = CommentKind::parse(&string_of(fields.get("kind"))?)?;
    let visible_text = string_of(fields.get("visibleText"))?;

    let start = number_of(fields.get("start"))?;
    let end = number_of(fields.get("end"))?;
    // `start < 0 || end < start` in the reference, and `!Number.isFinite`
    // above it — `number_of` refuses a non-finite value for the same reason.
    if start < 0.0 || end < start {
        return None;
    }

    Some(ReviewComment {
        id,
        kind,
        visible_text,
        start: start as u32,
        end: end as u32,
        original_text: string_of(fields.get("originalText")),
        body: string_of(fields.get("body")),
        metadata: string_of(fields.get("metadata")),
        // The reference keeps `createdAt` only when it is a finite number.
        created_at: number_of(fields.get("createdAt")).map(|value| value as i64),
    })
}

fn string_of(value: Option<&Any>) -> Option<String> {
    match value {
        Some(Any::String(text)) => Some(text.to_string()),
        _ => None,
    }
}

fn number_of(value: Option<&Any>) -> Option<f64> {
    match value {
        Some(Any::Number(number)) if number.is_finite() => Some(*number),
        Some(Any::BigInt(number)) => Some(*number as f64),
        _ => None,
    }
}
