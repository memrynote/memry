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
    CriticMarkupKind, CriticMarkupMark, parse_critic_markup, resolve_mark_range,
    serialize_critic_markup,
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
/// write over the file (S14-24, REVIEW-5196, VERIFY-5196B, VERIFY-5196C). The window moves its
/// marks with its typing and keeps those offsets (#4425; Electron's writes them into the
/// document), so a mark's range in the document can be stale, and the file the body is written
/// over holds the window's last save. Every mark is placed here: the serializer's own search for
/// a comment's words ignores the ranges placed marks hold, and drops the later of two marks that
/// overlap. A mark takes a range that holds its words and overlaps no range taken before it;
/// suggestions take theirs before comments. Each pass runs over the marks not placed yet:
/// 1. the range of the same mark in the file, moved onto `plain` through the text diff since (a
///    merge or another window), when it is the document's range, so that the array order never
///    lets a stale mark take the file range of a mark that still holds it;
/// 2. that moved range, then the document's range; the document's comes first when it touches
///    text the diff changed (a peer that writes its offsets is ahead of the file);
/// 3. the copies of its words, in order: a comment's (the serializer moves a comment to a copy),
///    and any mark's when there is no file to write over (`read_file_body` answers `Ok(None)`: a
///    kept note's restore, a held day's first file).
///
/// A comment is the file's same mark by its id only; a suggestion's id is its parse position, so
/// a suggestion is the same by its kind and texts. A placed mark keeps its own offsets when the
/// serializer resolves them to its range. A comment with no range is dropped, as Electron's
/// serializer drops it, when it starts inside a placed mark, when its words are gone, or when
/// there is no file. Otherwise the file is kept as it is. A suggestion with no range would be
/// dropped with the text it replaced, so the file is kept as it is; with no file to keep, the
/// suggestion passes as it is. Without `read_file_body` (the feed's and the identity's
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
    let copies = |mark: &CriticMarkupMark| {
        let visible = to_units(&mark.visible_text);
        let width = visible.len();
        units
            .windows(width.max(1))
            .enumerate()
            .filter(move |(_, window)| width > 0 && *window == visible.as_slice())
            .map(move |(at, _)| (at as i64, (at + width) as i64))
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
    let free = |taken: &[(i64, i64)], (start, end): (i64, i64)| {
        taken
            .iter()
            .all(|&(s, e)| (s, e) != (start, end) && (end <= s || e <= start))
    };
    // The first free range of the same mark in the file, moved onto `plain`; only `exact` when
    // given.
    let in_file = |mark: &CriticMarkupMark,
                   filed: &[Option<CriticMarkupMark>],
                   taken: &[(i64, i64)],
                   exact: Option<(i64, i64)>| {
        filed.iter().enumerate().find_map(|(at, other)| {
            let other = other.as_ref()?;
            let same = if mark.kind == CriticMarkupKind::Comment {
                other.id == mark.id
            } else {
                other.kind == mark.kind
                    && other.visible_text == mark.visible_text
                    && other.original_text == mark.original_text
            };
            let range = moved.as_ref()?.range(other.start, other.end)?;
            (same
                && exact.is_none_or(|exact| exact == range)
                && holds(mark, range)
                && free(taken, range))
            .then_some((at, range))
        })
    };
    let mut order: Vec<usize> = (0..marks.len()).collect();
    order.sort_by_key(|&at| marks[at].kind == CriticMarkupKind::Comment);
    let mut taken: Vec<(i64, i64)> = Vec::new();
    let mut ranges: Vec<Option<(i64, i64)>> = vec![None; marks.len()];
    for &at in &order {
        let mark = &marks[at];
        if let Some((entry, range)) = in_file(mark, &filed, &taken, Some((mark.start, mark.end))) {
            filed[entry] = None;
            taken.push(range);
            ranges[at] = Some(range);
        }
    }
    for &at in &order {
        let mark = &marks[at];
        if ranges[at].is_some() {
            continue;
        }
        let in_file =
            in_file(mark, &filed, &taken, None).map(|(entry, range)| (Some(entry), range));
        let in_document = Some((mark.start, mark.end))
            .filter(|range| holds(mark, *range) && free(&taken, *range))
            .map(|range| (None, range));
        let peer_ahead = in_document
            .is_some_and(|(_, range)| moved.as_ref().is_some_and(|map| map.touches_change(range)));
        let chosen = if peer_ahead {
            in_document.or(in_file)
        } else {
            in_file.or(in_document)
        };
        if let Some((entry, range)) = chosen {
            if let Some(entry) = entry {
                filed[entry] = None;
            }
            taken.push(range);
            ranges[at] = Some(range);
        }
    }
    for &at in &order {
        let mark = &marks[at];
        if ranges[at].is_some() || (file.is_some() && mark.kind != CriticMarkupKind::Comment) {
            continue;
        }
        ranges[at] = copies(mark).find(|&copy| free(&taken, copy));
        taken.extend(ranges[at]);
    }
    let mut placed = Vec::with_capacity(marks.len());
    for (mark, range) in marks.iter().zip(&ranges) {
        let inside_placed = || {
            ranges
                .iter()
                .flatten()
                .any(|&(start, end)| start <= mark.start && mark.start < end)
        };
        match range {
            &Some((start, end)) => {
                let resolved = resolve_mark_range(&units, mark).map(|it| (it.start, it.end));
                placed.push(if resolved == Some((start, end)) {
                    mark.clone()
                } else {
                    CriticMarkupMark {
                        start,
                        end,
                        ..mark.clone()
                    }
                });
            }
            None if mark.kind == CriticMarkupKind::Comment => {
                if file.is_some() && !inside_placed() && copies(mark).next().is_some() {
                    return None;
                }
            }
            None if file.is_none() => placed.push(mark.clone()),
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
mod tests;
