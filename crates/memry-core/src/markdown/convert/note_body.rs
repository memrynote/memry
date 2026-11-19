//! `yDocToMarkdownWithWritingRanges` and `serializeNoteBody`: the body with its
//! CriticMarkup and, when the doc has alternatives or ghosts, the writing
//! tools markers; plus the `writing` frontmatter beside it.

use std::cell::Cell;

use yrs::ReadTxn;

use super::Env;
use super::canonical::{Utf16Copy, serialize_canonical};
use super::restore::{
    SerializeOptions, SourceRestoreOutcome, doc_to_markdown, with_lf_line_endings,
};
use super::roots::read_critic_marks;
use super::writing::{EncodedWritingRanges, insert_writing_sentinels, writing_frontmatter_for};
use super::writing_roots::{
    WritingAlternative, read_writing_alternatives, read_writing_ghosts, read_writing_overflow,
};
use crate::markdown::shared::critic_markup::units::{index_of_units, slice_units, to_units};
use crate::markdown::shared::critic_markup::{
    CriticMarkupKind, CriticMarkupMark, parse_critic_markup, serialize_critic_markup,
};
use crate::markdown::shared::markdown_source::{LineHunk, diff_lines};
use crate::markdown::shared::writing_tools::{
    WritingFrontmatter, decode_writing_markers, encode_writing_body, without_writing_sentinels,
};

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
    let refused = Cell::new(false);
    let placed = |plain: &str| {
        placed_marks(&critic_marks, plain, options).unwrap_or_else(|| {
            refused.set(true);
            Vec::new()
        })
    };
    let overflow = read_writing_overflow(txn);
    match doc_to_markdown_with_writing_ranges(txn, fragment, &placed) {
        WritingRanged::Failed => return None,
        WritingRanged::Body { .. } if refused.get() => return None,
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
    let placed = placed(&plain.markdown);
    if refused.get() {
        return None;
    }
    Some(NoteBody {
        markdown: serialize_critic_markup(&plain.markdown, &placed),
        writing: writing_frontmatter_for(&[], &overflow),
        outcome: plain.outcome,
        unrepresentable: Vec::new(),
        dropped_elements: 0,
    })
}

/// The document's `marks` placed for `plain`, the body without its markup; `None` refuses the
/// write over the file (S14-24, REVIEW-5196). The window moves its marks with its typing and
/// keeps those offsets (#4425; Electron's writes them into the document), so a mark's range in
/// the document can be stale, and the file the body is written over holds the window's last
/// save. A mark takes the range of the same mark in the file, moved onto `plain` through the
/// text diff since (a merge or another window), unless the document's range holds the mark's
/// text, differs, and touches text the diff changed while the file's text is not `plain` (a
/// peer that writes its offsets is ahead of the file). A comment is the same mark by its id
/// first; a suggestion's id is its parse position, so a suggestion is the same by its kind and
/// texts. A comment placed nowhere is left to the serializer, which moves it to the first copy
/// of its words; any other mark would be dropped with the text it replaced, so the file is kept
/// as it is instead. A write with no file to write over (`read_file_body` answers `Ok(None)`:
/// a kept note's restore, a held day's first file) has nothing to keep and nothing to map
/// against: a mark whose range does not hold its words takes their first copy, and one whose
/// words are gone passes as it is. Without `read_file_body` (the feed's and the identity's
/// comparisons) the marks pass as they are.
fn placed_marks(
    marks: &[CriticMarkupMark],
    plain: &str,
    options: &SerializeOptions,
) -> Option<Vec<CriticMarkupMark>> {
    let Some(read) = options.read_file_body.filter(|_| !marks.is_empty()) else {
        return Some(marks.to_vec());
    };
    let units = to_units(plain);
    let holds = |mark: &CriticMarkupMark, (start, end): (i64, i64)| {
        start >= 0
            && end >= start
            && slice_units(&units, start, end) == to_units(&mark.visible_text).as_slice()
    };
    let body = match read() {
        Ok(None) => {
            return Some(
                marks
                    .iter()
                    .map(|mark| at_its_words(mark, &units))
                    .collect(),
            );
        }
        read => read.ok().flatten().unwrap_or_default(),
    };
    // Decoded as `restore_file_spelling` reads it: the writing markers count toward no offset.
    let decoded = decode_writing_markers(&with_lf_line_endings(&body));
    let file = without_writing_sentinels(&parse_critic_markup(&decoded.text), &decoded.sentinels);
    let (file_text, file_marks) = (file.plain_text, file.marks);
    let moved = OffsetMap::new(&file_text, plain);
    // The serializer and the save may disagree on the body's last line break.
    let same_text = file_text.trim_end_matches('\n') == plain.trim_end_matches('\n');
    let mut filed: Vec<Option<CriticMarkupMark>> = file_marks.into_iter().map(Some).collect();
    let mut placed = Vec::with_capacity(marks.len());
    for mark in marks {
        let in_document = Some((mark.start, mark.end)).filter(|range| holds(mark, *range));
        let in_file = |by_id: bool| {
            filed.iter().enumerate().find_map(|(at, other)| {
                let other = other.as_ref()?;
                let same = other.kind == mark.kind
                    && other.visible_text == mark.visible_text
                    && other.original_text == mark.original_text
                    && (!by_id || other.id == mark.id);
                let range = moved.as_ref()?.range(other.start, other.end)?;
                (same && holds(mark, range)).then_some((at, range))
            })
        };
        let peer_ahead = |range: (i64, i64)| {
            !same_text && moved.as_ref().is_none_or(|map| map.touches_change(range))
        };
        let range = match (in_file(true).or_else(|| in_file(false)), in_document) {
            (Some((_, filed)), Some(document)) if document != filed && peer_ahead(document) => {
                Some(document)
            }
            (Some((at, range)), _) => {
                filed[at] = None;
                Some(range)
            }
            (None, document) => document,
        };
        match range {
            Some((start, end)) => placed.push(CriticMarkupMark {
                start,
                end,
                ..mark.clone()
            }),
            None if mark.kind == CriticMarkupKind::Comment => placed.push(mark.clone()),
            None => return None,
        }
    }
    Some(placed)
}

/// `mark` where its range holds its words, else at their first copy in `units`, else as it is.
fn at_its_words(mark: &CriticMarkupMark, units: &[u16]) -> CriticMarkupMark {
    let visible = to_units(&mark.visible_text);
    let holds = mark.start >= 0
        && mark.end >= mark.start
        && slice_units(units, mark.start, mark.end) == visible.as_slice();
    match index_of_units(units, &visible).filter(|_| !holds && !visible.is_empty()) {
        Some(start) => CriticMarkupMark {
            start: start as i64,
            end: (start + visible.len()) as i64,
            ..mark.clone()
        },
        None => mark.clone(),
    }
}

fn characters(text: &str) -> Vec<&str> {
    text.char_indices()
        .map(|(at, ch)| &text[at..at + ch.len_utf8()])
        .collect()
}

/// Offsets in the file's text moved onto the document's through their character diff. `None`
/// when the diff is past [`MAX_EDIT_DISTANCE`](crate::markdown::shared::markdown_source::MAX_EDIT_DISTANCE).
struct OffsetMap {
    /// The UTF-16 offset each character of the file starts at, then the text's length.
    file: Vec<i64>,
    doc: Vec<i64>,
    hunks: Vec<LineHunk>,
}

impl OffsetMap {
    fn new(file: &str, doc: &str) -> Option<Self> {
        let starts = |text: &str| -> Vec<i64> {
            let mut at = 0i64;
            let mut starts: Vec<i64> = text
                .chars()
                .map(|ch| {
                    let start = at;
                    at += ch.len_utf16() as i64;
                    start
                })
                .collect();
            starts.push(at);
            starts
        };
        Some(Self {
            hunks: diff_lines(&characters(file), &characters(doc), str::to_owned)?,
            file: starts(file),
            doc: starts(doc),
        })
    }

    /// The document's range for the file's `start..end`; `None` when either end lies in text
    /// the diff changed. Text inserted right at an end stays outside the range.
    fn range(&self, start: i64, end: i64) -> Option<(i64, i64)> {
        Some((self.offset(start, true)?, self.offset(end, false)?))
    }

    /// Whether the document's `start..end` holds or splits text the diff changed; true when an
    /// end splits a character.
    fn touches_change(&self, (start, end): (i64, i64)) -> bool {
        let (Ok(start), Ok(end)) = (self.doc.binary_search(&start), self.doc.binary_search(&end))
        else {
            return true;
        };
        self.hunks.iter().any(|hunk| {
            let side_end = hunk.side_start + hunk.side_length;
            if hunk.side_length == 0 {
                start < hunk.side_start && hunk.side_start < end
            } else {
                start < side_end && hunk.side_start < end
            }
        })
    }

    fn offset(&self, offset: i64, is_start: bool) -> Option<i64> {
        let at = self.file.binary_search(&offset).ok()?;
        let mut shift = 0isize;
        for hunk in &self.hunks {
            let end = hunk.base_start + hunk.base_length;
            let inserted_here = hunk.base_length == 0 && hunk.base_start == at;
            if end > at && hunk.base_start < at {
                return None;
            }
            if end > at || (inserted_here && !is_start) {
                break;
            }
            shift += hunk.side_length as isize - hunk.base_length as isize;
        }
        self.doc.get(at.checked_add_signed(shift)?).copied()
    }
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

    /// A suggestion of `visible` over "Old", at `start`.
    fn suggestion(visible: &str, start: i64) -> CriticMarkupMark {
        serde_json::from_value(serde_json::json!({
            "id": "s1", "kind": "substitution", "visibleText": visible, "originalText": "Old",
            "start": start, "end": start + visible.len() as i64,
        }))
        .unwrap()
    }

    /// The marks' starts, `None` when the write-back is refused.
    fn placed(marks: &[CriticMarkupMark], plain: &str, file: &str) -> Option<Vec<i64>> {
        let read = || Ok(Some(file.to_owned()));
        let options = SerializeOptions {
            read_file_body: Some(&read),
            ..SerializeOptions::default()
        };
        placed_marks(marks, plain, &options)
            .map(|marks| marks.iter().map(|mark| mark.start).collect())
    }

    /// The marks' starts for a write-back with no file to map against (FIX-5196B).
    fn placed_without_file(marks: &[CriticMarkupMark], plain: &str) -> Option<Vec<i64>> {
        let read = || Ok(None);
        let options = SerializeOptions {
            read_file_body: Some(&read),
            ..SerializeOptions::default()
        };
        placed_marks(marks, plain, &options)
            .map(|marks| marks.iter().map(|mark| mark.start).collect())
    }

    /// A kept note's restore and a held day's first file have no file to write over: a
    /// suggestion whose range does not hold its words takes their first copy, and one whose
    /// words are gone passes as it is, rather than the write being refused for good.
    #[test]
    fn without_a_file_a_stale_suggestion_takes_the_first_copy_of_its_words() {
        assert_eq!(
            placed_without_file(&[suggestion("Alpha", 0)], "beta Alpha"),
            Some(vec![5])
        );
        assert_eq!(
            placed_without_file(&[suggestion("Alpha", 0)], "beta"),
            Some(vec![0])
        );
    }

    /// A merge changed text away from the mark: a stale document range on another copy of its
    /// words, over text the file already had, gives way to the file's range moved by the diff.
    #[test]
    fn after_a_merge_a_stale_range_on_another_copy_takes_the_files_range() {
        let file = serialize_critic_markup("beta beta beta x", &[suggestion("beta", 10)]);
        assert_eq!(
            placed(&[suggestion("beta", 5)], "beta beta beta y", &file),
            Some(vec![10])
        );
    }

    /// The decoded file's text is the document's, so its range wins over a stale one on another
    /// copy; read with its markers, the file's text differs inside that copy and the stale range
    /// would stand (VERIFY-5196).
    #[test]
    fn a_file_whose_markers_decode_to_the_documents_text_places_the_mark() {
        let rest = serialize_critic_markup(" beta", &[comment(1)]);
        let file = format!("be<!--ghost-->ta<!--/ghost-->{rest}");
        assert_eq!(placed(&[comment(0)], "beta beta", &file), Some(vec![5]));
    }

    /// A range that holds its text stays when the file is behind the document: a peer that
    /// writes its offsets into the document (Electron) typed "beta " before the comment, and
    /// the file's range, moved onto the document's text, lands on the first copy.
    #[test]
    fn a_document_range_that_holds_its_text_wins_over_the_file() {
        let file = serialize_critic_markup("beta", &[comment(0)]);
        assert_eq!(placed(&[comment(5)], "beta beta", &file), Some(vec![5]));
    }

    /// When the file's text is the document's, the file's range wins even over a document
    /// range that holds the same words on another copy (REVIEW-5196 finding 3).
    #[test]
    fn the_files_range_wins_when_its_text_is_the_documents() {
        let file = serialize_critic_markup("beta beta beta\n", &[suggestion("beta", 10)]);
        assert_eq!(
            placed(&[suggestion("beta", 5)], "beta beta beta", &file),
            Some(vec![10])
        );
    }

    /// The file's writing markers count toward no offset (finding 1).
    #[test]
    fn the_files_writing_markers_do_not_shift_its_ranges() {
        let marked = serialize_critic_markup(" beta beta", &[comment(6)]);
        let file = format!("<!--alt:k1-->x<!--/alt:k1--><!--ghost-->{marked}<!--/ghost-->");
        assert_eq!(placed(&[comment(0)], "x beta beta", &file), Some(vec![7]));
    }

    /// A merge typed before the mark since the save: the file's range moves with the text
    /// (finding 2).
    #[test]
    fn a_files_range_follows_text_merged_in_before_it() {
        let file =
            serialize_critic_markup("beta. Alpha and beta.\nlast", &[suggestion("Alpha", 6)]);
        let merged = "first\nHi beta. Alpha and beta.\nlast line";
        assert_eq!(
            placed(&[suggestion("Alpha", 6)], merged, &file),
            Some(vec![15])
        );
    }

    /// A merge deleted the suggestion's text: the write-back is refused rather than dropping the
    /// suggestion and the text it replaced (finding 2).
    #[test]
    fn a_suggestion_whose_text_is_gone_refuses_the_write_back() {
        let file = serialize_critic_markup("beta. Alpha and beta.", &[suggestion("Alpha", 6)]);
        assert_eq!(
            placed(&[suggestion("Alpha", 6)], "beta. and beta.", &file),
            None
        );
    }

    /// A stale range takes the file's; with no such mark in the file it stays as it was.
    #[test]
    fn a_stale_range_takes_the_files_range_of_the_same_mark() {
        let file = serialize_critic_markup("x beta beta", &[comment(7)]);
        assert_eq!(placed(&[comment(4)], "x beta beta", &file), Some(vec![7]));
        assert_eq!(
            placed(&[comment(4)], "x beta beta", "x beta beta"),
            Some(vec![4])
        );
    }
}
