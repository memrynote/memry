//! `yDocToMarkdownWithWritingRanges` and `serializeNoteBody`: the body with its
//! CriticMarkup and, when the doc has alternatives or ghosts, the writing
//! tools markers; plus the `writing` frontmatter beside it.

use yrs::ReadTxn;

use super::Env;
use super::canonical::{Utf16Copy, serialize_canonical};
use super::restore::{SerializeOptions, SourceRestoreOutcome, doc_to_markdown};
use super::roots::read_critic_marks;
use super::writing::{EncodedWritingRanges, insert_writing_sentinels, writing_frontmatter_for};
use super::writing_roots::{
    WritingAlternative, read_writing_alternatives, read_writing_ghosts, read_writing_overflow,
};
use crate::markdown::shared::critic_markup::units::{slice_units, to_units};
use crate::markdown::shared::critic_markup::{
    CriticMarkupMark, parse_critic_markup, serialize_critic_markup,
};
use crate::markdown::shared::writing_tools::{WritingFrontmatter, encode_writing_body};

/// What the vault file gets for a doc.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteBody {
    pub markdown: String,
    pub writing: WritingFrontmatter,
    pub outcome: SourceRestoreOutcome,
    /// As [`super::restore::SerializedBody::unrepresentable`].
    pub unrepresentable: Vec<String>,
    /// Elements y-prosemirror would delete because the schema cannot build them
    /// (a childless table row, a node in the wrong place): their content is not
    /// in `markdown` either. `Converter` fills it.
    pub dropped_elements: usize,
}

/// `yDocToMarkdownWithWritingRanges`' three answers.
pub enum WritingRanged {
    /// `undefined`: no range resolves, serialize as usual.
    NotApplicable,
    /// `null`: conversion failed.
    Failed,
    Body {
        markdown: String,
        alternatives: Vec<(WritingAlternative, String)>,
    },
}

/// The file body of a doc that holds alternatives or ghosts: house style with
/// the writing tools markers in place and the marks `critic_marks` gives for the text without
/// them applied around them.
pub fn doc_to_markdown_with_writing_ranges<T: ReadTxn>(
    txn: &T,
    fragment: &str,
    critic_marks: &dyn Fn(&str) -> Vec<CriticMarkupMark>,
) -> WritingRanged {
    let alternatives = read_writing_alternatives(txn);
    let ghosts = read_writing_ghosts(txn);
    if alternatives.is_empty() && ghosts.is_empty() {
        return WritingRanged::NotApplicable;
    }
    let mut encoded: Option<EncodedWritingRanges> = None;
    let mut prepare = |snapshot: &Utf16Copy| {
        encoded = Some(insert_writing_sentinels(
            snapshot,
            fragment,
            &alternatives,
            &ghosts,
        ));
    };
    let Some(text) = serialize_canonical(txn, fragment, Some(&mut prepare)) else {
        return WritingRanged::Failed;
    };
    match encoded {
        Some(ranges) if !ranges.sentinels.is_empty() => {
            let plain: String = text
                .chars()
                .filter(|ch| !ranges.sentinels.contains_key(ch))
                .collect();
            WritingRanged::Body {
                markdown: encode_writing_body(&text, &ranges.sentinels, &critic_marks(&plain)),
                alternatives: ranges.alternatives,
            }
        }
        _ => WritingRanged::NotApplicable,
    }
}

/// `serializeNoteBody`: `None` is the fail-closed answer.
pub fn serialize_note_body<T: ReadTxn>(
    env: &Env,
    txn: &T,
    fragment: &str,
    options: &SerializeOptions,
) -> Option<NoteBody> {
    let critic_marks = read_critic_marks(txn);
    let placed = |plain: &str| placed_marks(&critic_marks, plain, options);
    let overflow = read_writing_overflow(txn);
    match doc_to_markdown_with_writing_ranges(txn, fragment, &placed) {
        WritingRanged::Failed => return None,
        WritingRanged::Body {
            markdown,
            alternatives,
        } => {
            return Some(NoteBody {
                markdown,
                writing: writing_frontmatter_for(&alternatives, &overflow),
                outcome: SourceRestoreOutcome::WritingMarks,
                unrepresentable: Vec::new(),
                dropped_elements: 0,
            });
        }
        WritingRanged::NotApplicable => {}
    }
    let plain = doc_to_markdown(env, txn, fragment, options)?;
    Some(NoteBody {
        markdown: serialize_critic_markup(&plain.markdown, &placed(&plain.markdown)),
        writing: writing_frontmatter_for(&[], &overflow),
        outcome: plain.outcome,
        unrepresentable: Vec::new(),
        dropped_elements: 0,
    })
}

/// The document's `marks` placed for `plain`, the body without its markup. The window moves its
/// marks with its typing and keeps those offsets (#4425; Electron's writes them into the
/// document), so a mark's range in the document can be stale. The file the body is written over
/// holds the window's last save: a mark whose range in the document does not hold its text takes
/// the range of the same mark in the file, when that one does (S14-24). Otherwise the serializer
/// moves a comment to the first copy of its words and drops any other mark. A suggestion's id
/// is its parse position, so a suggestion is the same mark by its kind and texts.
fn placed_marks(
    marks: &[CriticMarkupMark],
    plain: &str,
    options: &SerializeOptions,
) -> Vec<CriticMarkupMark> {
    let units = to_units(plain);
    let holds = |mark: &CriticMarkupMark, start: i64, end: i64| {
        start >= 0
            && end >= start
            && slice_units(&units, start, end) == to_units(&mark.visible_text).as_slice()
    };
    if marks.iter().all(|mark| holds(mark, mark.start, mark.end)) {
        return marks.to_vec();
    }
    let Some(Ok(Some(file))) = options.read_file_body.map(|read| read()) else {
        return marks.to_vec();
    };
    let mut filed: Vec<Option<CriticMarkupMark>> = parse_critic_markup(&file)
        .marks
        .into_iter()
        .map(Some)
        .collect();
    let same = |mark: &CriticMarkupMark, other: &CriticMarkupMark| {
        other.kind == mark.kind
            && other.visible_text == mark.visible_text
            && other.original_text == mark.original_text
            && holds(mark, other.start, other.end)
    };
    marks
        .iter()
        .map(|mark| {
            if holds(mark, mark.start, mark.end) {
                return mark.clone();
            }
            let found = filed
                .iter()
                .position(|other| {
                    other
                        .as_ref()
                        .is_some_and(|o| o.id == mark.id && same(mark, o))
                })
                .or_else(|| {
                    filed
                        .iter()
                        .position(|other| other.as_ref().is_some_and(|o| same(mark, o)))
                });
            match found.and_then(|at| filed[at].take()) {
                Some(other) => CriticMarkupMark {
                    start: other.start,
                    end: other.end,
                    ..mark.clone()
                },
                None => mark.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(start: i64) -> CriticMarkupMark {
        serde_json::from_value(serde_json::json!({
            "id": "c1", "kind": "comment", "visibleText": "beta", "body": "b",
            "start": start, "end": start + 4,
        }))
        .unwrap()
    }

    fn placed(marks: &[CriticMarkupMark], plain: &str, file: &str) -> Vec<i64> {
        let read = || Ok(Some(file.to_owned()));
        let options = SerializeOptions {
            read_file_body: Some(&read),
            ..SerializeOptions::default()
        };
        placed_marks(marks, plain, &options)
            .iter()
            .map(|mark| mark.start)
            .collect()
    }

    /// A range that holds its text stays: a peer that writes its offsets into the document
    /// (Electron) moved it past a file that is behind.
    #[test]
    fn a_document_range_that_holds_its_text_wins_over_the_file() {
        let file = serialize_critic_markup("beta beta", &[comment(0)]);
        assert_eq!(placed(&[comment(5)], "beta beta", &file), [5]);
    }

    /// A stale range takes the file's; with no such mark in the file it stays as it was.
    #[test]
    fn a_stale_range_takes_the_files_range_of_the_same_mark() {
        let file = serialize_critic_markup("x beta beta", &[comment(7)]);
        assert_eq!(placed(&[comment(4)], "x beta beta", &file), [7]);
        assert_eq!(placed(&[comment(4)], "x beta beta", "x beta beta"), [4]);
    }
}
