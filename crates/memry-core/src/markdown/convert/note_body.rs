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
use crate::markdown::shared::critic_markup::units::{slice_units, to_units};
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
/// write over the file (S14-24, REVIEW-5196, VERIFY-5196B). The window moves its marks with its
/// typing and keeps those offsets (#4425; Electron's writes them into the document), so a mark's
/// range in the document can be stale, and the file the body is written over holds the window's
/// last save. One rule places every mark: in array order, a mark takes its first candidate range
/// that holds its words and overlaps no range an earlier mark took (the serializer drops an
/// overlapping mark). The candidates are the range of the same mark in the file, moved onto
/// `plain` through the text diff since (a merge or another window), then the document's range;
/// the document's comes first when it touches text the diff changed (a peer that writes its
/// offsets is ahead of the file). A comment is the file's same mark by its id only; a
/// suggestion's id is its parse position, so a suggestion is the same by its kind and texts.
/// With no file to write over (`read_file_body` answers `Ok(None)`: a kept note's restore, a
/// held day's first file), after every mark has had those, the copies of a mark's words follow,
/// in order. A comment with no candidate is left to the serializer, which moves it to the first
/// copy of its words; any other mark would be dropped with the text it replaced, so the file is
/// kept as it is instead, or, with no file to keep, the mark passes as it is. Without
/// `read_file_body` (the feed's and the identity's comparisons) the marks pass as they are.
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
    let file = match read() {
        Ok(None) => None,
        read => Some(read.ok().flatten().unwrap_or_default()),
    };
    let (moved, mut filed) = match &file {
        Some(body) => {
            // Decoded as `restore_file_spelling` reads it: the writing markers count toward no
            // offset.
            let decoded = decode_writing_markers(&with_lf_line_endings(body));
            let file =
                without_writing_sentinels(&parse_critic_markup(&decoded.text), &decoded.sentinels);
            let moved = OffsetMap::new(&file.plain_text, plain);
            (moved, file.marks.into_iter().map(Some).collect())
        }
        None => (None, Vec::new()),
    };
    let mut taken: Vec<(i64, i64)> = Vec::new();
    let free = |taken: &[(i64, i64)], (start, end): (i64, i64)| {
        taken
            .iter()
            .all(|&(s, e)| (s, e) != (start, end) && (end <= s || e <= start))
    };
    let mut ranges: Vec<Option<(i64, i64)>> = Vec::with_capacity(marks.len());
    for mark in marks {
        let in_file = filed.iter().enumerate().find_map(|(at, other)| {
            let other = other.as_ref()?;
            let same = if mark.kind == CriticMarkupKind::Comment {
                other.id == mark.id
            } else {
                other.kind == mark.kind
                    && other.visible_text == mark.visible_text
                    && other.original_text == mark.original_text
            };
            let range = moved.as_ref()?.range(other.start, other.end)?;
            (same && holds(mark, range) && free(&taken, range)).then_some((Some(at), range))
        });
        let in_document = Some((mark.start, mark.end))
            .filter(|range| holds(mark, *range) && free(&taken, *range))
            .map(|range| (None, range));
        let peer_ahead = in_document
            .is_some_and(|(_, range)| moved.as_ref().is_some_and(|map| map.touches_change(range)));
        let range = if peer_ahead {
            in_document.or(in_file)
        } else {
            in_file.or(in_document)
        };
        if let Some((Some(at), _)) = range {
            filed[at] = None;
        }
        taken.extend(range.map(|(_, range)| range));
        ranges.push(range.map(|(_, range)| range));
    }
    if file.is_none() {
        for (mark, range) in marks.iter().zip(&mut ranges) {
            let visible = to_units(&mark.visible_text);
            if range.is_some() || visible.is_empty() {
                continue;
            }
            *range = units
                .windows(visible.len())
                .enumerate()
                .filter(|(_, window)| *window == visible.as_slice())
                .map(|(at, _)| (at as i64, (at + visible.len()) as i64))
                .find(|&copy| free(&taken, copy));
            taken.extend(*range);
        }
    }
    let mut placed = Vec::with_capacity(marks.len());
    for (mark, range) in marks.iter().zip(ranges) {
        match range {
            Some((start, end)) => placed.push(CriticMarkupMark {
                start,
                end,
                ..mark.clone()
            }),
            None if mark.kind == CriticMarkupKind::Comment || file.is_none() => {
                placed.push(mark.clone())
            }
            None => return None,
        }
    }
    Some(placed)
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

    /// A comment `id` on the `beta` at `start`.
    fn comment_with(id: &str, start: i64) -> CriticMarkupMark {
        CriticMarkupMark {
            id: id.to_owned(),
            ..comment(start)
        }
    }

    /// A suggestion of `visible` over `original`, at `start`.
    fn suggestion_over(visible: &str, original: &str, start: i64) -> CriticMarkupMark {
        CriticMarkupMark {
            original_text: Some(original.to_owned()),
            ..suggestion(visible, start)
        }
    }

    /// The body serialized with the marks placed for it, `None` when the write-back is refused.
    fn written(marks: &[CriticMarkupMark], plain: &str, file: Option<&str>) -> Option<String> {
        let read = || Ok(file.map(str::to_owned));
        let options = SerializeOptions {
            read_file_body: Some(&read),
            ..SerializeOptions::default()
        };
        placed_marks(marks, plain, &options).map(|marks| serialize_critic_markup(plain, &marks))
    }

    /// Two stale suggestions on the same words take distinct copies, so neither is dropped with
    /// the text it replaced (VERIFY-5196B).
    #[test]
    fn stale_suggestions_on_the_same_words_take_distinct_copies() {
        let marks = [
            suggestion_over("Alpha", "One", 0),
            suggestion_over("Alpha", "Two", 0),
        ];
        let originals = |marks: &[CriticMarkupMark]| -> Vec<(i64, Option<String>)> {
            let body = written(marks, "x Alpha Alpha", None).unwrap();
            parse_critic_markup(&body)
                .marks
                .into_iter()
                .map(|mark| (mark.start, mark.original_text))
                .collect()
        };
        let at = |start, original: &str| (start, Some(original.to_owned()));
        assert_eq!(originals(&marks), [at(2, "One"), at(8, "Two")]);
        // A range that holds its words is taken before any stale mark searches for a copy.
        let holding = [marks[0].clone(), suggestion_over("Alpha", "Two", 2)];
        assert_eq!(originals(&holding), [at(2, "Two"), at(8, "One")]);
    }

    /// A peer ahead of the file added a comment on another copy of a filed comment's words, text
    /// unchanged: a comment is the file's by its id only, so each keeps its range in either
    /// array order (VERIFY-5196B).
    #[test]
    fn a_comment_takes_the_files_range_only_by_its_id() {
        let file = serialize_critic_markup("beta beta", &[comment(5)]);
        let (c1, c2) = (comment(5), comment_with("c2", 0));
        assert_eq!(
            placed(&[c2.clone(), c1.clone()], "beta beta", &file),
            Some(vec![0, 5])
        );
        assert_eq!(placed(&[c1, c2], "beta beta", &file), Some(vec![5, 0]));
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
