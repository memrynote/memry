//! `parseQuickAdd`: the quick-add grammar, `@date`, `every ...`, `!priority`,
//! `+project`, `#tag`, `[[note]]` (spec 004 D1: English only, `@` prefix
//! required for dates), ported from
//! `packages/domain-tasks/src/parsing/quick-add.ts`, quirks included.
//!
//! Every offset handed out is a UTF-16 code unit index, end exclusive, as the
//! TypeScript and the vectors index strings. Internally offsets are UTF-8 byte
//! indices, converted at the API edge. `now` is the caller's local clock;
//! nothing here reads one.

use std::ops::Range;

use super::natural_date::{is_js_whitespace, js_trim, parse_natural_date};
use super::repeat_phrase::{
    collapse_whitespace, find_repeat_phrase_range, is_ascii_word, utf16_index, word_ends,
};
use crate::domain::calendar::{CivilDate, LocalDateTime};
use crate::domain::recurrence::first_occurrence_for;
use crate::domain::repeat_config::RepeatConfig;
use crate::domain::task_filter::Priority;

/// A project the `+name` marker can resolve to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickAddProject {
    pub id: String,
    pub name: String,
    /// Carried for the caller; desktop resolves archived projects too.
    pub is_archived: bool,
}

/// What a quick-add input captured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedQuickAdd {
    pub title: String,
    pub due_date: Option<CivilDate>,
    /// `"HH:MM"`, only when the date phrase carried a time.
    pub due_time: Option<String>,
    pub priority: Priority,
    pub project_id: Option<String>,
    pub repeat: Option<RepeatConfig>,
    /// Every `#tag` in the input, in order, with the typed casing kept.
    pub tags: Vec<String>,
    /// The non-empty titles inside `[[...]]`, in order.
    pub note_titles: Vec<String>,
}

/// What a stretch of syntax is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpanKind {
    Priority,
    Project,
    Tag,
    NoteLink,
    DatePhrase,
    Repeat,
}

impl SpanKind {
    /// Desktop's `QuickAddSpanKind` name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Priority => "priority",
            Self::Project => "project",
            Self::Tag => "tag",
            Self::NoteLink => "noteLink",
            Self::DatePhrase => "datePhrase",
            Self::Repeat => "repeat",
        }
    }
}

/// A stretch of the input that carries syntax rather than title text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuickAddSpan {
    /// UTF-16 index.
    pub start: usize,
    /// Exclusive UTF-16 index.
    pub end: usize,
    pub kind: SpanKind,
}

/// A finished `[[...]]` run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteLinkMatch {
    /// UTF-16 index of the first `[`.
    pub start: usize,
    /// Exclusive UTF-16 index after the last `]`.
    pub end: usize,
    /// The text between the brackets, trimmed.
    pub title: String,
}

/// An `@...` run that reads as a date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatePhraseMatch {
    /// UTF-16 index of the `@`.
    pub start: usize,
    /// Exclusive UTF-16 end index of the phrase.
    pub end: usize,
    /// The matched text including the `@`.
    pub text: String,
    pub date: CivilDate,
    /// `"HH:MM"` when the phrase carried a time.
    pub time: Option<String>,
}

/// `@` plus at most this many words: the cap on the greedy phrase scan.
const MAX_DATE_PHRASE_WORDS: usize = 4;

/// The cadences the ghost completes to, shortest useful phrase first.
const REPEAT_PHRASES: [&str; 7] = [
    "every day",
    "every weekday",
    "every week",
    "every 2 weeks",
    "every weekend",
    "every month",
    "every year",
];

/// A span in UTF-8 byte offsets.
#[derive(Debug, Clone)]
struct RawSpan {
    range: Range<usize>,
    kind: SpanKind,
}

/// A finished `[[...]]` run in UTF-8 byte offsets.
struct RawNoteLink {
    range: Range<usize>,
    title: String,
}

/// A date phrase in UTF-8 byte offsets.
struct RawDatePhrase {
    range: Range<usize>,
    date: CivilDate,
    time: Option<String>,
}

/// The sigil markers, each `/(?:^|\s)(<run>)/g`.
#[derive(Debug, Clone, Copy)]
enum Marker {
    /// `![a-zA-Z]+`: "Ship it!" and "Wow!!" stay prose.
    Priority,
    /// `\+[\w-]+`: "1+2" and "C++" never read as a project.
    Project,
    /// `#[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*`, the note
    /// editor's tag grammar: "C#" and "issue#12" are prose.
    Tag,
}

impl Marker {
    /// Byte length of the marker run at the start of `text`, sigil included.
    fn run_len(self, text: &str) -> Option<usize> {
        let bytes = text.as_bytes();
        let count_from = |from: usize, accept: fn(u8) -> bool| {
            bytes
                .get(from..)
                .map_or(0, |tail| tail.iter().take_while(|&&b| accept(b)).count())
        };
        let len = match self {
            Self::Priority if bytes.first() == Some(&b'!') => {
                1 + count_from(1, |b| b.is_ascii_alphabetic())
            }
            Self::Project if bytes.first() == Some(&b'+') => {
                1 + count_from(1, |b| is_ascii_word(b) || b == b'-')
            }
            Self::Tag if bytes.first() == Some(&b'#') => {
                let mut len = 1;
                loop {
                    if !bytes.get(len).is_some_and(u8::is_ascii_alphanumeric) {
                        break;
                    }
                    len += 1 + count_from(len + 1, |b| is_ascii_word(b) || b == b'-');
                    let nested = bytes.get(len) == Some(&b'/')
                        && bytes.get(len + 1).is_some_and(u8::is_ascii_alphanumeric);
                    if !nested {
                        break;
                    }
                    len += 1;
                }
                len
            }
            _ => return None,
        };
        (len > 1).then_some(len)
    }

    /// Every run in `input`, in `matchAll` order: a match consumes its
    /// leading whitespace, and the scan resumes where the run ends.
    fn runs(self, input: &str) -> Vec<Range<usize>> {
        let mut runs = Vec::new();
        let mut pos = 0;
        while let Some(rest) = input.get(pos..) {
            let Some(first) = rest.chars().next() else {
                break;
            };
            let run_start = if pos == 0 && self.run_len(rest).is_some() {
                Some(pos)
            } else if is_js_whitespace(first) {
                Some(pos + first.len_utf8())
            } else {
                None
            };
            let run = run_start.and_then(|start| {
                let len = self.run_len(input.get(start..)?)?;
                Some(start..start + len)
            });
            match run {
                Some(run) => {
                    pos = run.end;
                    runs.push(run);
                }
                None => pos += first.len_utf8(),
            }
        }
        runs
    }
}

/// Every finished `[[...]]` run (`/\[\[([^[\]\n]+)\]\]/g`). An unclosed `[[`
/// is still being typed.
pub fn find_note_links(input: &str) -> Vec<NoteLinkMatch> {
    raw_note_links(input)
        .into_iter()
        .map(|link| NoteLinkMatch {
            start: utf16_index(input, link.range.start),
            end: utf16_index(input, link.range.end),
            title: link.title,
        })
        .collect()
}

fn raw_note_links(input: &str) -> Vec<RawNoteLink> {
    let bytes = input.as_bytes();
    let mut links = Vec::new();
    let mut pos = 0;
    while pos + 1 < bytes.len() {
        if bytes.get(pos..pos + 2) != Some(b"[[".as_slice()) {
            pos += 1;
            continue;
        }
        let inner_start = pos + 2;
        let inner_len = bytes.get(inner_start..).map_or(0, |tail| {
            tail.iter()
                .take_while(|&&b| !matches!(b, b'[' | b']' | b'\n'))
                .count()
        });
        let inner_end = inner_start + inner_len;
        let closed = inner_len > 0 && bytes.get(inner_end..inner_end + 2) == Some(b"]]".as_slice());
        match input.get(inner_start..inner_end).filter(|_| closed) {
            Some(inner) => {
                links.push(RawNoteLink {
                    range: pos..inner_end + 2,
                    title: js_trim(inner).to_owned(),
                });
                pos = inner_end + 2;
            }
            None => pos += 1,
        }
    }
    links
}

/// A note title may well contain a sigil: `[[Q3 #launch]]` links a note, it
/// does not tag the task. Markers inside a link are ignored.
fn is_inside_link(links: &[RawNoteLink], index: usize) -> bool {
    links.iter().any(|link| link.range.contains(&index))
}

/// Finds the first `@...` run that reads as a date. The `@` starts a word and
/// the phrase spans up to four words, longest match first, so "@next
/// wednesday call bob" keeps "call bob" in the title.
pub fn find_date_phrase(input: &str, now: LocalDateTime) -> Option<DatePhraseMatch> {
    let phrase = raw_date_phrase(input, now)?;
    Some(DatePhraseMatch {
        start: utf16_index(input, phrase.range.start),
        end: utf16_index(input, phrase.range.end),
        text: input.get(phrase.range)?.to_owned(),
        date: phrase.date,
        time: phrase.time,
    })
}

fn raw_date_phrase(input: &str, now: LocalDateTime) -> Option<RawDatePhrase> {
    input.match_indices('@').find_map(|(start, _)| {
        // A mention starts a word: "a@b" is not one.
        let before = input.get(..start)?.chars().next_back();
        if before.is_some_and(|c| !is_js_whitespace(c)) {
            return None;
        }
        let rest = input.get(start + 1..)?;
        if rest.chars().next().is_none_or(is_js_whitespace) {
            return None;
        }
        word_ends(rest, MAX_DATE_PHRASE_WORDS)
            .into_iter()
            .rev()
            .find_map(|end| {
                let parsed = parse_natural_date(rest.get(..end)?, now).ok()?;
                Some(RawDatePhrase {
                    range: start..start + 1 + end,
                    date: parsed.date,
                    time: parsed.time,
                })
            })
    })
}

/// `parsePriorityKeyword`: `urgent`/`u`, `high`/`h`, `medium`/`med`/`m`,
/// `low`/`l`, `none`/`n`, any case, surrounding whitespace ignored.
///
/// An inherited `Object.prototype` key ("constructor") is truthy in the
/// TypeScript map lookup; here it is simply not a priority.
pub fn parse_priority_keyword(keyword: &str) -> Option<Priority> {
    let lower = keyword.to_lowercase();
    Some(match js_trim(&lower) {
        "urgent" | "u" => Priority::Urgent,
        "high" | "h" => Priority::High,
        "medium" | "med" | "m" => Priority::Medium,
        "low" | "l" => Priority::Low,
        "none" | "n" => Priority::None,
        _ => return None,
    })
}

/// `findProjectByName`, case-insensitive: an exact id, an exact name, a name
/// prefix, then a kebab-case name ("project-alpha" is "Project Alpha").
/// Archived projects resolve like any other, as on desktop.
pub fn find_project_by_name(name: &str, projects: &[QuickAddProject]) -> Option<String> {
    let lowered = name.to_lowercase();
    let lower = js_trim(&lowered);
    let kebab_name = lower.replace('-', " ");
    let lower_name = |project: &QuickAddProject| project.name.to_lowercase();
    projects
        .iter()
        .find(|p| p.id.to_lowercase() == lower)
        .or_else(|| projects.iter().find(|p| lower_name(p) == lower))
        .or_else(|| projects.iter().find(|p| lower_name(p).starts_with(lower)))
        .or_else(|| projects.iter().find(|p| lower_name(p) == kebab_name))
        .map(|project| project.id.clone())
}

/// Sorted by start (stably), non-overlapping: an earlier span wins.
fn drop_overlaps(mut spans: Vec<RawSpan>) -> Vec<RawSpan> {
    spans.sort_by_key(|span| span.range.start);
    let mut kept: Vec<RawSpan> = Vec::new();
    for span in spans {
        if kept
            .last()
            .is_some_and(|last| span.range.start < last.range.end)
        {
            continue;
        }
        kept.push(span);
    }
    kept
}

/// The input without `spans`, whitespace runs collapsed and trimmed.
fn strip_spans(input: &str, spans: &[RawSpan]) -> String {
    let mut title = String::with_capacity(input.len());
    let mut cursor = 0;
    for span in spans {
        title.push_str(input.get(cursor..span.range.start).unwrap_or_default());
        cursor = span.range.end;
    }
    title.push_str(input.get(cursor..).unwrap_or_default());
    js_trim(&collapse_whitespace(&title)).to_owned()
}

fn link_spans(links: &[RawNoteLink]) -> Vec<RawSpan> {
    links
        .iter()
        .map(|link| RawSpan {
            range: link.range.clone(),
            kind: SpanKind::NoteLink,
        })
        .collect()
}

/// Parses quick-add input: `@tomorrow`, `every monday`, `!high`, `+work`,
/// `#tag`, `[[Note]]`. What is not syntax is the title.
pub fn parse_quick_add(
    input: &str,
    projects: &[QuickAddProject],
    now: LocalDateTime,
) -> ParsedQuickAdd {
    // Note links first: they own their whole run, sigils inside included.
    let links = raw_note_links(input);
    let mut spans = link_spans(&links);
    let mut due_date = None;
    let mut due_time = None;
    let mut priority = Priority::None;
    let mut project_id = None;

    if let Some(phrase) =
        raw_date_phrase(input, now).filter(|p| !is_inside_link(&links, p.range.start))
    {
        due_date = Some(phrase.date);
        due_time = phrase.time;
        spans.push(RawSpan {
            range: phrase.range,
            kind: SpanKind::DatePhrase,
        });
    }

    // Anchored to the due date, so a bare "every month" repeats on the day the
    // task is actually due.
    let anchor = due_date.unwrap_or_else(|| now.date());
    let repeat = find_repeat_phrase_range(input, anchor, now)
        .filter(|(range, _)| !is_inside_link(&links, range.start))
        .map(|(range, config)| {
            spans.push(RawSpan {
                range,
                kind: SpanKind::Repeat,
            });
            config
        });

    // The first run that names a priority wins; "!nope" is prose.
    for run in Marker::Priority.runs(input) {
        if is_inside_link(&links, run.start) {
            continue;
        }
        if let Some(parsed) = input
            .get(run.start + 1..run.end)
            .and_then(parse_priority_keyword)
        {
            priority = parsed;
            spans.push(RawSpan {
                range: run,
                kind: SpanKind::Priority,
            });
            break;
        }
    }

    // An unresolved "+foo" stays in the title.
    for run in Marker::Project.runs(input) {
        if is_inside_link(&links, run.start) {
            continue;
        }
        let name = input.get(run.start + 1..run.end).unwrap_or_default();
        if let Some(found) = find_project_by_name(name, projects) {
            project_id = Some(found);
            spans.push(RawSpan {
                range: run,
                kind: SpanKind::Project,
            });
            break;
        }
    }

    // Unlike the other markers, every tag counts.
    let mut tags = Vec::new();
    for run in Marker::Tag.runs(input) {
        if is_inside_link(&links, run.start) {
            continue;
        }
        tags.push(
            input
                .get(run.start + 1..run.end)
                .unwrap_or_default()
                .to_owned(),
        );
        spans.push(RawSpan {
            range: run,
            kind: SpanKind::Tag,
        });
    }

    // A repeat only rolls forward from a due date.
    if let (Some(config), None) = (&repeat, due_date) {
        due_date = Some(first_occurrence_for(config, now));
    }

    ParsedQuickAdd {
        title: strip_spans(input, &drop_overlaps(spans)),
        due_date,
        due_time,
        priority,
        project_id,
        repeat,
        tags,
        note_titles: links
            .into_iter()
            .map(|link| link.title)
            .filter(|title| !title.is_empty())
            .collect(),
    }
}

/// The stretches of `input` that carry syntax, for the token overlay, sorted
/// and non-overlapping. The sigil forms count as soon as they are typed,
/// parseable or not: an unfinished "!hi" or an unknown "+foo" is syntax.
pub fn find_quick_add_spans(input: &str, now: LocalDateTime) -> Vec<QuickAddSpan> {
    let links = raw_note_links(input);
    let mut spans = link_spans(&links);

    if let Some(phrase) =
        raw_date_phrase(input, now).filter(|p| !is_inside_link(&links, p.range.start))
    {
        spans.push(RawSpan {
            range: phrase.range,
            kind: SpanKind::DatePhrase,
        });
    }
    if let Some((range, _)) = find_repeat_phrase_range(input, now.date(), now)
        .filter(|(range, _)| !is_inside_link(&links, range.start))
    {
        spans.push(RawSpan {
            range,
            kind: SpanKind::Repeat,
        });
    }

    let sigils = [
        (Marker::Priority, SpanKind::Priority),
        (Marker::Project, SpanKind::Project),
        (Marker::Tag, SpanKind::Tag),
    ];
    for (marker, kind) in sigils {
        for range in marker.runs(input) {
            if !is_inside_link(&links, range.start) {
                spans.push(RawSpan { range, kind });
            }
        }
    }

    drop_overlaps(spans)
        .into_iter()
        .map(|span| QuickAddSpan {
            start: utf16_index(input, span.range.start),
            end: utf16_index(input, span.range.end),
            kind: span.kind,
        })
        .collect()
}

/// Whether `input` holds any quick-add syntax, parseable marker or not.
pub fn has_special_syntax(input: &str, now: LocalDateTime) -> bool {
    [Marker::Priority, Marker::Project, Marker::Tag]
        .into_iter()
        .any(|marker| !marker.runs(input).is_empty())
        || !raw_note_links(input).is_empty()
        || raw_date_phrase(input, now).is_some()
        || find_repeat_phrase_range(input, now.date(), now).is_some()
}

/// The canonical cadence a half-typed "every ..." completes to, or `None`.
/// Case-insensitive: the cadence starts with the lowercased `query`.
pub fn predict_repeat_completion(query: &str) -> Option<String> {
    let lower = query.to_lowercase();
    REPEAT_PHRASES
        .into_iter()
        .find(|phrase| phrase.starts_with(&lower))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_runs_follow_match_all() {
        assert_eq!(
            Marker::Priority.runs("task !nope !low"),
            vec![5..10, 11..15]
        );
        assert_eq!(Marker::Priority.runs("!a!b !c"), vec![0..2, 5..7]);
        assert_eq!(Marker::Tag.runs(" #a/b/ #c/-"), vec![1..5, 7..9]);
        assert!(Marker::Project.runs("1+2 is C++").is_empty());
    }

    #[test]
    fn note_links_need_both_brackets() {
        let links = raw_note_links("[[[a]] [[ ]] [[b");
        let ranges: Vec<_> = links.iter().map(|link| link.range.clone()).collect();
        assert_eq!(ranges, vec![1..6, 7..12]);
        assert_eq!(links[1].title, "");
    }
}
