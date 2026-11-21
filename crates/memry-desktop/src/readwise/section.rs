//! `section.ts`: the section markers and the state in the end marker. `v1` is a vault format that
//! older and newer builds read, so the token, the marker text and the hash are the contract.

use std::ops::Range;

use super::step;
use super::text::normalize_for_hash;
use crate::web::extract::utils::js::{is_js_whitespace, trim as js_trim};

pub const SECTION_START: &str = "<!-- readwise:start -->";
pub const SECTION_FORMAT_VERSION: u32 = 1;

/// The state a book section's end marker holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndMarker {
    /// Newest `created_at` (Readwise server time) written into the note.
    pub last: String,
    /// Hash of the section body as Memry wrote it.
    pub hash: String,
}

/// An end marker's hash, which decides whether the section is still the bytes Memry wrote.
pub trait MarkerHash {
    fn hash(&self) -> &str;
}

impl MarkerHash for EndMarker {
    fn hash(&self) -> &str {
        &self.hash
    }
}

/// `hashSectionBody`: 32-bit FNV-1a over the UTF-16 code units of the normalized body, as 8
/// lowercase hex digits.
pub fn hash_section_body(body: &str) -> String {
    let hash = normalize_for_hash(body)
        .encode_utf16()
        .fold(0x811c_9dc5_u32, |hash, unit| {
            (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193)
        });
    format!("{hash:08x}")
}

/// `writeEndMarker`.
pub fn write_end_marker(marker: &EndMarker) -> String {
    format!(
        "<!-- readwise:end v{SECTION_FORMAT_VERSION} last={} hash={} -->",
        marker.last, marker.hash
    )
}

/// `sealSection`: the whole section for `body`, sealed with a fresh hash, a blank line inside
/// each marker.
pub fn seal_section(body: &str, last: &str) -> String {
    let end = write_end_marker(&EndMarker {
        last: last.to_string(),
        hash: hash_section_body(body),
    });
    format!("{SECTION_START}\n\n{body}\n\n{end}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionProblem {
    NoStart,
    NoEnd,
    OutOfOrder,
    InlineMarker,
    DuplicateMarkers,
}

impl SectionProblem {
    /// The TypeScript name, as the vectors and logs spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoStart => "no-start",
            Self::NoEnd => "no-end",
            Self::OutOfOrder => "out-of-order",
            Self::InlineMarker => "inline-marker",
            Self::DuplicateMarkers => "duplicate-markers",
        }
    }
}

/// The one end marker of a note whose section has no usable start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndRead<M> {
    /// Byte offsets in the body of the end marker line, leading blanks included.
    pub range: Range<usize>,
    /// `None` when the marker is not a `v1` marker this build can read.
    pub marker: Option<M>,
}

/// `SectionRead`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionRead<'a, M> {
    Found {
        /// Byte offsets of the start marker line and just past the end marker line.
        range: Range<usize>,
        /// Text between the two marker lines.
        text: &'a str,
        /// `None` when the end marker is not a `v1` marker this build can read.
        marker: Option<M>,
        /// The hash matches, so the section is bytes Memry wrote.
        untouched: bool,
    },
    Missing {
        problem: SectionProblem,
        /// The one end marker, when the note holds exactly one and no marker text sits
        /// inline: `no-start` and `out-of-order` reads.
        end: Option<EndRead<M>>,
    },
}

impl<M> SectionRead<'_, M> {
    pub fn untouched(&self) -> bool {
        matches!(
            self,
            Self::Found {
                untouched: true,
                ..
            }
        )
    }
}

/// Which markers delimit a section, and how its end marker's fields parse (`SectionSpec`).
pub struct SectionSpec<M> {
    /// The whole start marker line.
    pub start: &'static str,
    /// Prefix of every start marker, for the inline-marker check.
    pub start_prefix: &'static str,
    /// Prefix of every end marker: the end line is `<prefix> <fields> -->`.
    pub end_prefix: &'static str,
    pub parse_end: fn(&str) -> Option<M>,
}

/// `Number(digits) === SECTION_FORMAT_VERSION` for a `\d+` capture.
fn is_format_version(digits: &str) -> bool {
    digits.trim_start_matches('0') == "1"
}

/// `^v(\d+) ` at the start of an end marker's fields: the rest after the version token.
pub(crate) fn strip_version(fields: &str) -> Option<&str> {
    let rest = fields.strip_prefix('v')?;
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 || !is_format_version(&rest[..digits]) {
        return None;
    }
    rest[digits..].strip_prefix(' ')
}

/// `[0-9a-f]+$`.
pub(crate) fn is_lower_hex(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `/^v(\d+) last=(\S+) hash=([0-9a-f]+)$/`, read only for version 1.
fn parse_end_marker(fields: &str) -> Option<EndMarker> {
    let rest = strip_version(fields)?.strip_prefix("last=")?;
    let last_len = rest.find(is_js_whitespace).unwrap_or(rest.len());
    let (last, rest) = rest.split_at(last_len);
    let hash = rest.strip_prefix(" hash=")?;
    (!last.is_empty() && is_lower_hex(hash)).then(|| EndMarker {
        last: last.to_string(),
        hash: hash.to_string(),
    })
}

pub const BOOK_SECTION: SectionSpec<EndMarker> = SectionSpec {
    start: SECTION_START,
    start_prefix: "<!-- readwise:start",
    end_prefix: "<!-- readwise:end",
    parse_end: parse_end_marker,
};

/// `/^<prefix> (.*) -->$/` on a trimmed line: the captured fields. `.` stops at the JS line
/// terminators, so a line holding one is not an end marker.
fn end_line_fields<'a>(line: &'a str, end_prefix: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(end_prefix)?.strip_prefix(' ')?;
    let fields = rest.strip_suffix(" -->")?;
    (!fields.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(fields)
}

/// `readSection`: the book section of a note body.
pub fn read_section(body: &str) -> SectionRead<'_, EndMarker> {
    read_marked_section(body, &BOOK_SECTION)
}

/// `readMarkedSection`. Both markers must be alone on their line, once each, start before end.
/// Anything else is a problem and the section is never untouched, so the writer appends
/// instead of rewriting.
pub fn read_marked_section<'a, M: MarkerHash>(
    body: &'a str,
    spec: &SectionSpec<M>,
) -> SectionRead<'a, M> {
    let mut starts = 0_usize;
    let mut first_start = 0..0;
    let mut ends = 0_usize;
    let mut first_end: Option<(Range<usize>, &str)> = None;
    let mut inline = false;

    let mut offset = 0;
    for raw_line in body.split('\n') {
        step();
        let line_end = offset + raw_line.len();
        let line = js_trim(raw_line);
        if line == spec.start {
            starts += 1;
            if starts == 1 {
                first_start = offset..line_end;
            }
        } else if let Some(fields) = end_line_fields(line, spec.end_prefix) {
            ends += 1;
            if ends == 1 {
                first_end = Some((offset..line_end, fields));
            }
        } else if line.contains(spec.start_prefix) || line.contains(spec.end_prefix) {
            inline = true;
        }
        offset = line_end + 1;
    }

    let missing = |problem, end| SectionRead::Missing { problem, end };
    if inline {
        return missing(SectionProblem::InlineMarker, None);
    }
    if starts > 1 || ends > 1 {
        return missing(SectionProblem::DuplicateMarkers, None);
    }
    let Some((end, fields)) = first_end else {
        let problem = if starts == 0 {
            SectionProblem::NoStart
        } else {
            SectionProblem::NoEnd
        };
        return missing(problem, None);
    };
    let marker = (spec.parse_end)(fields);
    if starts == 0 {
        return missing(
            SectionProblem::NoStart,
            Some(EndRead { range: end, marker }),
        );
    }
    if end.start < first_start.end {
        return missing(
            SectionProblem::OutOfOrder,
            Some(EndRead { range: end, marker }),
        );
    }

    // `body.slice(start.to + 1, end.from - 1)`: empty when the markers sit on adjacent lines.
    let from = first_start.end + 1;
    let to = end.start - 1;
    let text = if to > from { &body[from..to] } else { "" };
    let untouched = marker
        .as_ref()
        .is_some_and(|m| m.hash() == hash_section_body(text));
    SectionRead::Found {
        range: first_start.start..end.end,
        text,
        marker,
        untouched,
    }
}
