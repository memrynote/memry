//! `text.ts`: whitespace, escaping, tag names and dates, with JS string semantics. Each regex of
//! the TypeScript is a hand-written scan here, linear in its input; the comment above each one
//! names the pattern it reproduces.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{Offset, TimeZone, Utc};
use chrono_tz::Tz;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use super::types::{ReadwiseHighlight, ReadwiseTag};
use crate::web::extract::utils::date::{civil_from_days, iso_string, parse_date};
use crate::web::extract::utils::js::{is_js_whitespace, trim as js_trim};

/// Zero-width space: breaks Memry syntax without changing how the text reads.
const ZWSP: char = '\u{200b}';

/// `HEADING_TAGS`: `.h1` to `.h3` turn a highlight into a heading of 3 to 5 `#`.
pub(crate) fn heading_tag_level(name: &str) -> Option<usize> {
    match js_trim(name).to_lowercase().as_str() {
        ".h1" => Some(3),
        ".h2" => Some(4),
        ".h3" => Some(5),
        _ => None,
    }
}

/// `headingLevel`: the count of `#` of a heading highlight.
pub fn heading_level(highlight: &ReadwiseHighlight) -> Option<usize> {
    highlight
        .tags
        .iter()
        .flatten()
        .find_map(|tag| heading_tag_level(&tag.name))
}

/// `collapseWhitespace`: `text.replace(/\s+/g, ' ').trim()`.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    js_trim(&out).to_string()
}

/// `.replace(/\r\n?/g, '\n')` then each line's `.replace(/[ \t]+$/, '')`.
fn lf_lines_without_trailing_blanks(text: &str) -> String {
    let lf = text.replace("\r\n", "\n").replace('\r', "\n");
    lf.split('\n')
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `normalizeForHash` (`section.ts`): line endings and trailing blanks the editor round trip
/// may change, then `.replace(/^\n+|\n+$/g, '')`.
pub(crate) fn normalize_for_hash(text: &str) -> String {
    lf_lines_without_trailing_blanks(text)
        .trim_matches('\n')
        .to_string()
}

/// `normalizeParagraphs`: LF line endings, no trailing blanks, at most one blank line, trimmed.
pub fn normalize_paragraphs(text: &str) -> String {
    let lines = lf_lines_without_trailing_blanks(text);
    // `.replace(/\n{3,}/g, '\n\n')`
    let mut out = String::with_capacity(lines.len());
    let mut run = 0;
    for c in lines.chars() {
        if c == '\n' {
            run += 1;
            if run <= 2 {
                out.push('\n');
            }
        } else {
            run = 0;
            out.push(c);
        }
    }
    js_trim(&out).to_string()
}

/// `escapeLine`: break what Memry would read as its own syntax with a zero-width space. The
/// passes run in the TypeScript's order, each over the output of the one before.
pub fn escape_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    // `/(^|\s)#(?=[A-Za-z])/g` -> `$1#\u200b`
    let mut a = Vec::with_capacity(chars.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        a.push(c);
        if c == '#'
            && chars.get(i + 1).is_some_and(char::is_ascii_alphabetic)
            && (i == 0 || is_js_whitespace(chars[i - 1]))
        {
            a.push(ZWSP);
        }
    }
    // `/\[\[/g` -> `[\u200b[`, left to right without overlap. That leaves `[[` in an odd run
    // (`[[[x]]`), and `[\[`, which the markdown parser reads as `[[`. When one of them has a
    // `]` after it, which could close a wiki link, every `[` before a `[` or `\[` takes the
    // space instead (module docs, Departures).
    let opens = |s: &[char], i: usize| {
        s[i] == '['
            && (s.get(i + 1) == Some(&'[')
                || (s.get(i + 1) == Some(&'\\') && s.get(i + 2) == Some(&'[')))
    };
    let mut b = Vec::with_capacity(a.len() + 8);
    let mut i = 0;
    while i < a.len() {
        if a[i] == '[' && a.get(i + 1) == Some(&'[') {
            b.extend(['[', ZWSP, '[']);
            i += 2;
        } else {
            b.push(a[i]);
            i += 1;
        }
    }
    let close = b.iter().rposition(|c| *c == ']');
    if (0..b.len()).any(|i| close.is_some_and(|close| close > i) && opens(&b, i)) {
        b.clear();
        for (i, &c) in a.iter().enumerate() {
            b.push(c);
            if opens(&a, i) {
                b.push(ZWSP);
            }
        }
    }
    // `/\[(?=[ xX]\])/g` -> `[\u200b`
    let mut c2 = Vec::with_capacity(b.len() + 8);
    for (i, &c) in b.iter().enumerate() {
        c2.push(c);
        if c == '[' && matches!(b.get(i + 1), Some(' ' | 'x' | 'X')) && b.get(i + 2) == Some(&']') {
            c2.push(ZWSP);
        }
    }
    // `/!\[/g` -> `!\u200b[`
    let mut d = Vec::with_capacity(c2.len() + 8);
    for (i, &c) in c2.iter().enumerate() {
        d.push(c);
        if c == '!' && c2.get(i + 1) == Some(&'[') {
            d.push(ZWSP);
        }
    }
    // `/<(?=[A-Za-z/!?])/g` -> `<\u200b`
    let mut e = Vec::with_capacity(d.len() + 8);
    for (i, &c) in d.iter().enumerate() {
        e.push(c);
        if c == '<'
            && d.get(i + 1)
                .is_some_and(|n| n.is_ascii_alphabetic() || matches!(n, '/' | '!' | '?'))
        {
            e.push(ZWSP);
        }
    }
    escape_block_start(&mut e);
    e.into_iter().collect()
}

/// The last pass of `escapeLine`, anchored at the start of the text:
/// `/^(\s*)(#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|\d{1,9}[.)](?=\s|$)|`(?=``)|~(?=~~)|=(?==+$)|-(?=-+$))/`
/// -> `$1$2\u200b`. No alternative starts with whitespace, so `\s*` never gives any back.
fn escape_block_start(s: &mut Vec<char>) {
    let start = s.iter().take_while(|c| is_js_whitespace(**c)).count();
    let at = |i: usize| s.get(i).copied();
    let ends_or_space = |i: usize| at(i).is_none_or(is_js_whitespace);
    let run_of = |i: usize, f: fn(&char) -> bool| s[i..].iter().take_while(|c| f(c)).count();
    let Some(first) = at(start) else { return };
    let len = match first {
        '#' => {
            let run = run_of(start, |c| *c == '#');
            (run <= 6 && ends_or_space(start + run)).then_some(run)
        }
        '>' => Some(1),
        '-' | '+' | '*' if ends_or_space(start + 1) => Some(1),
        '0'..='9' => {
            let run = run_of(start, char::is_ascii_digit);
            (run <= 9
                && matches!(at(start + run), Some('.' | ')'))
                && ends_or_space(start + run + 1))
            .then_some(run + 1)
        }
        '`' if at(start + 1) == Some('`') && at(start + 2) == Some('`') => Some(1),
        '~' if at(start + 1) == Some('~') && at(start + 2) == Some('~') => Some(1),
        '=' | '-' if s.len() > start + 1 && s[start + 1..].iter().all(|c| *c == first) => Some(1),
        _ => None,
    };
    if let Some(len) = len {
        s.insert(start + len, ZWSP);
    }
}

/// `escapeParagraphs`.
pub fn escape_paragraphs(text: &str) -> String {
    normalize_paragraphs(text)
        .split('\n')
        .map(escape_line)
        .collect::<Vec<_>>()
        .join("\n")
}

static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{M}").expect("static pattern"));

/// `toInlineTag`: a tag name in the inline `#tag` grammar, or `None` when nothing is left.
pub fn to_inline_tag(name: &str) -> Option<String> {
    let decomposed: String = name.nfd().collect();
    let folded = MARKS.replace_all(&decomposed, "");
    let folded = js_trim(&folded).trim_start_matches('#');
    let segments: Vec<String> = folded
        .split('/')
        .enumerate()
        .map(|(index, segment)| {
            // `.replace(/[^A-Za-z0-9_-]+/g, '-')`
            let mut out = String::with_capacity(segment.len());
            let mut in_run = false;
            for c in segment.chars() {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    out.push(c);
                    in_run = false;
                } else if !in_run {
                    out.push('-');
                    in_run = true;
                }
            }
            // `/^[^A-Za-z]+/` for the first segment, `/^[^A-Za-z0-9]+/` for the rest.
            let lead = if index == 0 {
                out.trim_start_matches(|c: char| !c.is_ascii_alphabetic())
            } else {
                out.trim_start_matches(|c: char| !c.is_ascii_alphanumeric())
            };
            lead.trim_end_matches('-').to_string()
        })
        .filter(|segment| !segment.is_empty())
        .collect();
    let first = segments.first()?;
    first
        .starts_with(|c: char| c.is_ascii_alphabetic())
        .then(|| segments.join("/"))
}

/// `dedupeNames`: distinct names, case-insensitively, in first-seen order.
pub fn dedupe_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    names
        .into_iter()
        .filter(|name| seen.insert(name.to_lowercase()))
        .collect()
}

/// `bookTagNames`: the Readwise names, trimmed and de-duplicated.
pub fn book_tag_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    dedupe_names(
        names
            .into_iter()
            .map(|name| js_trim(name).to_string())
            .filter(|name| !name.is_empty()),
    )
}

/// `inlineTags`: highlight tags as inline `#tag` text, heading markers left out.
pub fn inline_tags(tags: Option<&[ReadwiseTag]>) -> Vec<String> {
    dedupe_names(
        tags.unwrap_or_default()
            .iter()
            .filter(|tag| heading_tag_level(&tag.name).is_none())
            .filter_map(|tag| to_inline_tag(&tag.name)),
    )
}

/// `Date.parse` of a field that may be missing: `!iso` is `NaN`.
pub(crate) fn parse_ms(value: Option<&str>) -> Option<f64> {
    value.filter(|v| !v.is_empty()).and_then(parse_date)
}

/// `chrono` reaches about 262,000 years from year 0, the JS Date about 275,760; an instant
/// past that is moved by whole 400-year Gregorian cycles, over which the calendar and the
/// zone's final rules repeat, to read its offset.
const CYCLE_MS: i64 = 146_097 * 86_400_000;
const CHRONO_SAFE_MS: i64 = 8_000_000_000_000_000;

fn utc_offset_ms(time_zone: Tz, ms: i64) -> i64 {
    let mut probe = ms;
    while probe > CHRONO_SAFE_MS {
        probe -= CYCLE_MS;
    }
    while probe < -CHRONO_SAFE_MS {
        probe += CYCLE_MS;
    }
    Utc.timestamp_millis_opt(probe).single().map_or(0, |utc| {
        i64::from(
            time_zone
                .offset_from_utc_datetime(&utc.naive_utc())
                .fix()
                .local_minus_utc(),
        ) * 1000
    })
}

/// `formatDay`: `YYYY-MM-DD` of `iso` in `time_zone`, as `Intl.DateTimeFormat('en-US')` with a
/// numeric year writes it (no padding, a year at or before 0 as the era year `1 - y`).
pub fn format_day(iso: Option<&str>, time_zone: Tz) -> Option<String> {
    let ms = parse_ms(iso)?.trunc() as i64;
    let local = ms + utc_offset_ms(time_zone, ms);
    let (year, month, day) = civil_from_days(local.div_euclid(86_400_000));
    let year = if year <= 0 { 1 - year } else { year };
    Some(format!("{year}-{month:02}-{day:02}"))
}

/// `toIsoInstant`: an ISO instant with milliseconds, or `None` for a missing or invalid date.
pub fn to_iso_instant(value: Option<&str>) -> Option<String> {
    iso_string(Some(parse_ms(value)?)).ok()
}

/// `String(n)` for a JS number.
pub(crate) fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if (1e-6..1e21).contains(&n.abs()) {
        return format!("{n}");
    }
    let exp = format!("{n:e}");
    match exp.split_once('e') {
        Some((mantissa, power)) if !power.starts_with('-') => format!("{mantissa}e+{power}"),
        _ => exp,
    }
}

/// `a < b` on JS strings: UTF-16 code unit order, which differs from Rust's code point order
/// above U+FFFF.
pub(crate) fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
