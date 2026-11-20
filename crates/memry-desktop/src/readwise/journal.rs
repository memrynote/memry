//! `journal.ts`: the journal day section, the books a day's highlights belong to with a count
//! each, linked to the book notes. `readwise-day` and the `v1` token are a vault format. The
//! text is English whatever the app language.

use chrono_tz::Tz;

use super::section::{
    MarkerHash, SECTION_FORMAT_VERSION, SectionRead, SectionSpec, hash_section_body, is_lower_hex,
    read_marked_section, strip_version,
};
use super::text::{cmp_utf16, collapse_whitespace, format_day, to_iso_instant};
use crate::web::extract::utils::js::is_js_whitespace;

pub const DAY_SECTION_START: &str = "<!-- readwise-day:start -->";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayEndMarker {
    /// Hash of the section body as Memry wrote it.
    pub hash: String,
}

impl MarkerHash for DayEndMarker {
    fn hash(&self) -> &str {
        &self.hash
    }
}

/// `/^v(\d+) hash=([0-9a-f]+)$/`, read only for version 1.
fn parse_day_end(fields: &str) -> Option<DayEndMarker> {
    let hash = strip_version(fields)?.strip_prefix("hash=")?;
    is_lower_hex(hash).then(|| DayEndMarker {
        hash: hash.to_string(),
    })
}

pub const DAY_SECTION: SectionSpec<DayEndMarker> = SectionSpec {
    start: DAY_SECTION_START,
    start_prefix: "<!-- readwise-day:start",
    end_prefix: "<!-- readwise-day:end",
    parse_end: parse_day_end,
};

/// `readDaySection`: the day section of a journal entry's body, with the rules of
/// `read_section`.
pub fn read_day_section(body: &str) -> SectionRead<'_, DayEndMarker> {
    read_marked_section(body, &DAY_SECTION)
}

/// `JournalBook`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalBook {
    /// The book note's current title.
    pub title: String,
    /// Highlights to list: the day's live highlights, or the new arrivals for an append.
    pub count: u64,
    /// ISO instant of the book's first highlight of the day, which orders the books.
    pub first: String,
}

/// `highlightDay`: the local date of `highlighted_at`, or of `created_at` when it is missing.
pub fn highlight_day(
    highlighted_at: Option<&str>,
    created_at: Option<&str>,
    time_zone: Tz,
) -> Option<String> {
    let instant = to_iso_instant(highlighted_at).or_else(|| to_iso_instant(created_at));
    format_day(instant.as_deref(), time_zone)
}

/// `highlightInstant`: the sort key the index uses for `JournalBook::first`.
pub fn highlight_instant(highlighted_at: Option<&str>, created_at: Option<&str>) -> Option<String> {
    to_iso_instant(highlighted_at).or_else(|| to_iso_instant(created_at))
}

/// `]` and `|` cannot sit in a wiki-link target, and `<!--` would make the line read as a
/// marker, so the section could never be re-rendered.
fn line(book: &JournalBook) -> String {
    let target = collapse_whitespace(
        &book
            .title
            .replace("<!--", " ")
            .replace(['[', ']', '|'], " "),
    );
    let target = if target.is_empty() {
        "Untitled"
    } else {
        &target
    };
    let plural = if book.count == 1 { "" } else { "s" };
    format!("- [[{target}]]: {} highlight{plural}", book.count)
}

fn ordered(books: &[JournalBook]) -> Vec<&JournalBook> {
    let mut books: Vec<&JournalBook> = books.iter().filter(|b| b.count > 0).collect();
    books.sort_by(|a, b| cmp_utf16(&a.first, &b.first).then_with(|| cmp_utf16(&a.title, &b.title)));
    books
}

fn lines(books: &[JournalBook]) -> Vec<String> {
    ordered(books).into_iter().map(line).collect()
}

/// `planJournalDay`: the sealed section for a day, empty when no book has a highlight.
pub fn plan_journal_day(books: &[JournalBook]) -> String {
    let lines = lines(books);
    if lines.is_empty() {
        return String::new();
    }
    let body = format!("### Readwise\n\n{}", lines.join("\n"));
    format!(
        "{DAY_SECTION_START}\n\n{body}\n\n<!-- readwise-day:end v{SECTION_FORMAT_VERSION} hash={} -->",
        hash_section_body(&body)
    )
}

/// `planJournalAppend`: one line per book with new arrivals, empty when there are none.
pub fn plan_journal_append(books: &[JournalBook]) -> String {
    lines(books).join("\n")
}

/// `JournalWrite`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalWrite {
    /// The entry has no section, or no entry exists: append `markdown` to the entry.
    Append {
        markdown: String,
    },
    /// The entry's new body.
    Update {
        content: String,
    },
    Unchanged,
}

/// `/^\s*(?:[-*+]|\d{1,9}[.)])\s/`.
fn is_list_item(line: &str) -> bool {
    let rest = line.trim_start_matches(is_js_whitespace);
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let after = if rest.starts_with(['-', '*', '+']) {
        &rest[1..]
    } else if (1..=9).contains(&digits) && rest[digits..].starts_with(['.', ')']) {
        &rest[digits + 1..]
    } else {
        return false;
    };
    after.starts_with(is_js_whitespace)
}

/// `insertLines`: `lines` placed before `body[at..]`, after the text before it, as one more
/// list item or a new block.
fn insert_lines(body: &str, at: usize, lines: &str) -> String {
    let before = body[..at].trim_end_matches(is_js_whitespace);
    let last_line = &before[before.rfind('\n').map_or(0, |i| i + 1)..];
    let gap = if before.is_empty() {
        ""
    } else if is_list_item(last_line) {
        "\n"
    } else {
        "\n\n"
    };
    format!("{before}{gap}{lines}\n\n{}", &body[at..])
}

/// `planJournalWrite`: what an entry needs for a day. `body` is the entry's content, or `None`
/// when there is no entry. `day` lists every book with that day's highlights, and `arrivals`
/// the books with new arrivals and how many.
pub fn plan_journal_write(
    body: Option<&str>,
    day: &[JournalBook],
    arrivals: &[JournalBook],
) -> JournalWrite {
    let section = plan_journal_day(day);
    if section.is_empty() {
        return JournalWrite::Unchanged;
    }
    let Some(body) = body else {
        return JournalWrite::Append { markdown: section };
    };

    let read = read_day_section(body);
    if let SectionRead::Found {
        range,
        untouched: true,
        ..
    } = &read
    {
        let content = format!("{}{section}{}", &body[..range.start], &body[range.end..]);
        return if content == body {
            JournalWrite::Unchanged
        } else {
            JournalWrite::Update { content }
        };
    }

    let lines = plan_journal_append(arrivals);
    match read {
        SectionRead::Found { range, marker, .. } => {
            if marker.is_none() || lines.is_empty() {
                return JournalWrite::Unchanged;
            }
            // `body.lastIndexOf('\n', range.end - 1) + 1`: the start of the end marker line.
            let end_line = body[..range.end].rfind('\n').map_or(0, |i| i + 1);
            JournalWrite::Update {
                content: insert_lines(body, end_line, &lines),
            }
        }
        SectionRead::Missing { end: Some(end), .. } => {
            if end.marker.is_none() || lines.is_empty() {
                return JournalWrite::Unchanged;
            }
            JournalWrite::Update {
                content: insert_lines(body, end.range.start, &lines),
            }
        }
        // No marker at all: the user has no section for this day yet (or removed it).
        SectionRead::Missing {
            problem: super::section::SectionProblem::NoStart,
            end: None,
        } => JournalWrite::Append { markdown: section },
        SectionRead::Missing { end: None, .. } if lines.is_empty() => JournalWrite::Unchanged,
        SectionRead::Missing { end: None, .. } => JournalWrite::Update {
            content: format!("{}\n\n{lines}", body.trim_end_matches(is_js_whitespace)),
        },
    }
}
