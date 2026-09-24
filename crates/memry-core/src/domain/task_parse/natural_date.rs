//! `parseNaturalDate`: a typed date phrase ("tomorrow at 3pm", "dec 25",
//! "next friday", "12/25/24") to a local date and an optional time (spec 004
//! D1), ported from `packages/domain-tasks/src/parsing/natural-date.ts`.
//!
//! The TypeScript is the reference, quirks included, and the `naturalDate`
//! section of the `task-parsing` vectors pins it. There is no regex engine in
//! the core, so each pattern is a hand-written matcher that reproduces the
//! JavaScript semantics the vectors depend on: `\s` is JavaScript whitespace
//! (not Rust's `char::is_whitespace`), `\d` is ASCII, `/i` folds ASCII only,
//! the `$`-anchored time suffix is the **leftmost** start that matches, and
//! `String.replace` with that match removes its **first** occurrence. Dates
//! roll over exactly as `new Date(y, m, d)` does ("feb 31" is March 3).
//!
//! The JavaScript-regex building blocks are `pub(super)` so the sibling
//! completion matchers share one definition of whitespace and the `at`
//! connector.

use std::fmt;

use super::completion::{COMPLETION_MONTHS, COMPLETION_WEEKDAYS};
use crate::domain::calendar::{CivilDate, LocalDateTime};

/// A phrase `parse_natural_date` understood.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDate {
    /// The local calendar date.
    pub date: CivilDate,
    /// `"HH:MM"` on the 24-hour clock, when the phrase ended in a time the
    /// parser accepts. A time-shaped suffix it rejects ("24:00") is still
    /// removed from the phrase, and this is `None`.
    pub time: Option<String>,
    /// en-US display text: `"Wednesday, January 14, 2026"`, plus
    /// `" · 3:00 PM"` when there is a time.
    pub display_text: String,
}

/// Why `parse_natural_date` produced no date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NaturalDateError {
    /// The input was empty or whitespace only.
    Empty,
    /// No pattern matched, or the date fell outside years 1..=9999.
    NotUnderstood,
}

impl NaturalDateError {
    /// Desktop's user-facing error text, verbatim.
    pub fn message(self) -> &'static str {
        match self {
            Self::Empty => "Please enter a date",
            Self::NotUnderstood => "Couldn't understand this date",
        }
    }
}

impl fmt::Display for NaturalDateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for NaturalDateError {}

const DAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

const MONTH_ABBREVIATIONS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// The long spellings the month alternation accepts (`jan(?:uary)?`, ...).
const MONTH_NAMES: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// Past this many units, "in N days/weeks/months" is beyond year 9999 from
/// any representable today, which is JavaScript's failure too. Bounding it
/// first keeps the calendar arithmetic far from `i64` overflow.
const MAX_IN_UNITS: u64 = 10_000_000;

/// Parses a natural-language date phrase relative to the caller's local `now`.
///
/// Supports relative words ("today", "tmrw", "next week", "this weekend"),
/// "in N days/weeks/months", weekdays with an optional "next"/"this"/"last",
/// month and day in either order ("dec 25", "25th december"), numeric dates
/// ("12/25", "12-25-2024") and a bare ordinal ("25th"), each optionally
/// followed by a time ("at 3pm", "3:30 PM", "15:00").
pub fn parse_natural_date(input: &str, now: LocalDateTime) -> Result<ParsedDate, NaturalDateError> {
    let lowered = input.to_lowercase();
    let lower = js_trim(&lowered);
    if lower.is_empty() {
        return Err(NaturalDateError::Empty);
    }

    let (without_time, time) = match time_suffix(lower) {
        Some((whole, time_text)) => (lower.replacen(whole, "", 1), parse_time_string(time_text)),
        None => (lower.to_string(), None),
    };
    let normalized = collapse_whitespace(js_trim(&without_time));

    let today = now.date();
    let date = relative_date(&normalized, today)
        .or_else(|| in_units_date(&normalized, today))
        .or_else(|| weekday_date(&normalized, today))
        .or_else(|| last_weekday_date(&normalized, today))
        .or_else(|| month_day_date(&normalized, today))
        .or_else(|| day_month_date(&normalized, today))
        .or_else(|| numeric_date(&normalized, today))
        .or_else(|| ordinal_date(&normalized, today))
        .filter(|date| (1..=9999).contains(&date.year))
        .ok_or(NaturalDateError::NotUnderstood)?;

    let display_text = display_text(date, time.as_deref());
    Ok(ParsedDate {
        date,
        time,
        display_text,
    })
}

/// "today", "tomorrow", "next week", ...
fn relative_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let weekday = i64::from(today.weekday());
    Some(match text {
        "today" => today,
        "tomorrow" | "tmrw" | "tmr" => today.add_days(1),
        "yesterday" => today.add_days(-1),
        // `nextMonday`: a Monday moves a full week.
        "next week" => today.add_days(match weekday {
            1 => 7,
            0 => 1,
            _ => 8 - weekday,
        }),
        // `lastMonday`: this week's Monday, minus a week.
        "last week" => today.add_days(-(if weekday == 0 { 6 } else { weekday - 1 }) - 7),
        "next month" => today.add_months(1),
        "last month" => today.add_months(-1),
        // `nextSaturday`: a Saturday is its own weekend.
        "this weekend" | "weekend" => today.add_days(match weekday {
            6 => 0,
            0 => 6,
            _ => 6 - weekday,
        }),
        _ => return None,
    })
}

/// `^in\s+(\d+)\s+(day|days|week|weeks|month|months)$`.
///
/// A count so large that JavaScript's `Date` goes out of range reads as
/// `None`: no other pattern matches an "in ..." phrase, so the result is the
/// same "Couldn't understand this date".
fn in_units_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let (count, unit) = text.strip_prefix("in ")?.split_once(' ')?;
    if count.is_empty() || !count.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let count = count.bytes().try_fold(0_u64, |acc, b| {
        acc.checked_mul(10)?.checked_add(u64::from(b - b'0'))
    })?;
    if count > MAX_IN_UNITS {
        return None;
    }
    let count = i64::try_from(count).ok()?;
    match unit {
        "day" | "days" => Some(today.add_days(count)),
        "week" | "weeks" => Some(today.add_days(count * 7)),
        "month" | "months" => Some(today.add_months(count)),
        _ => None,
    }
}

/// `^(next\s+|this\s+)?(sunday|...|saturday)$`.
fn weekday_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let (prefix, name) = match text.split_once(' ') {
        Some((prefix @ ("next" | "this"), name)) => (Some(prefix), name),
        Some(_) => return None,
        None => (None, text),
    };
    let day_index = day_index(name)?;
    let current = today.weekday();
    let mut date = next_day_of_week(day_index, today);
    if prefix == Some("next") && day_index <= current {
        date = date.add_days(7);
    }
    Some(date)
}

/// `^last\s+(sunday|...|saturday)$`: the most recent past occurrence.
fn last_weekday_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let day_index = day_index(text.strip_prefix("last ")?)?;
    let mut days_since = i64::from(today.weekday()) - i64::from(day_index);
    if days_since <= 0 {
        days_since += 7;
    }
    Some(today.add_days(-days_since))
}

/// `^(month)\s+(\d{1,2})(?:st|nd|rd|th)?$`.
fn month_day_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let (month, day) = text.split_once(' ')?;
    this_or_next_year(month_index(month)?, day_number(day, false)?, today)
}

/// `^(\d{1,2})(?:st|nd|rd|th)?\s+(month)$`.
fn day_month_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let (day, month) = text.split_once(' ')?;
    this_or_next_year(month_index(month)?, day_number(day, false)?, today)
}

/// `new Date(thisYear, month, day)`, or next year's when that has passed.
fn this_or_next_year(month0: i64, day: i64, today: CivilDate) -> Option<CivilDate> {
    if !(1..=31).contains(&day) {
        return None;
    }
    let date = js_date(today.year, month0, day);
    Some(if date < today {
        js_date(today.year + 1, month0, day)
    } else {
        date
    })
}

/// `^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$`.
fn numeric_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let (month, rest) = digit_run(text, 1, 2)?;
    let rest = rest.strip_prefix(['/', '-'])?;
    let (day, rest) = digit_run(rest, 1, 2)?;
    let explicit_year = if rest.is_empty() {
        None
    } else {
        let (year, rest) = digit_run(rest.strip_prefix(['/', '-'])?, 2, 4)?;
        if !rest.is_empty() {
            return None;
        }
        Some(year)
    };

    let month0 = month - 1;
    let mut year = explicit_year.unwrap_or(today.year);
    if year < 100 {
        year += if year < 50 { 2000 } else { 1900 };
    }
    if !(0..=11).contains(&month0) || !(1..=31).contains(&day) {
        return None;
    }
    let date = js_date(year, month0, day);
    Some(if explicit_year.is_none() && date < today {
        js_date(today.year + 1, month0, day)
    } else {
        date
    })
}

/// `^(\d{1,2})(?:st|nd|rd|th)$`: this month's day, or next month's when it
/// has passed.
fn ordinal_date(text: &str, today: CivilDate) -> Option<CivilDate> {
    let day = day_number(text, true)?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let month0 = i64::from(today.month) - 1;
    let date = js_date(today.year, month0, day);
    Some(if date < today {
        js_date(today.year, month0 + 1, day)
    } else {
        date
    })
}

/// `getNextDayOfWeek`: today or earlier in the week moves to next week.
fn next_day_of_week(day_index: u32, today: CivilDate) -> CivilDate {
    let mut days_until = i64::from(day_index) - i64::from(today.weekday());
    if days_until <= 0 {
        days_until += 7;
    }
    today.add_days(days_until)
}

/// `new Date(year, month0, day)`, including its rule that a year in 0..=99
/// means 1900 + year.
fn js_date(year: i64, month0: i64, day: i64) -> CivilDate {
    let year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    CivilDate::from_js_parts(year, month0, day)
}

fn day_index(name: &str) -> Option<u32> {
    let index = DAY_NAMES.iter().position(|day| *day == name)?;
    u32::try_from(index).ok()
}

/// A zero-based month for exactly an abbreviation or a full month name.
fn month_index(token: &str) -> Option<i64> {
    let index = (0..12).find(|&i| MONTH_ABBREVIATIONS[i] == token || MONTH_NAMES[i] == token)?;
    i64::try_from(index).ok()
}

/// `(\d{1,2})(?:st|nd|rd|th)` with the suffix optional or required, and
/// nothing after it.
fn day_number(text: &str, suffix_required: bool) -> Option<i64> {
    let (day, rest) = digit_run(text, 1, 2)?;
    let valid = match rest {
        "" => !suffix_required,
        "st" | "nd" | "rd" | "th" => true,
        _ => false,
    };
    valid.then_some(day)
}

/// The `$`-anchored time suffix
/// `(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})$` at its
/// leftmost matching start: `(whole match, time group)`.
fn time_suffix(text: &str) -> Option<(&str, &str)> {
    text.char_indices().find_map(|(start, _)| {
        let rest = &text[start..];
        if let Some(time) = strip_at_connector(rest).filter(|time| is_time_text(time)) {
            return Some((rest, time));
        }
        is_time_text(rest).then_some((rest, rest))
    })
}

/// `\d{1,2}(?::\d{2})?\s*(?:am|pm)$` or `\d{1,2}:\d{2}$`, case-insensitive.
fn is_time_text(text: &str) -> bool {
    let Some((_, rest)) = digit_run(text, 1, 2) else {
        return false;
    };
    let (has_minutes, after_minutes) = match minutes_part(rest) {
        Some((_, after)) => (true, after),
        None => (false, rest),
    };
    let meridiem = js_trim_start(after_minutes);
    meridiem.eq_ignore_ascii_case("am")
        || meridiem.eq_ignore_ascii_case("pm")
        || (has_minutes && after_minutes.is_empty())
}

/// `parseTimeString`: `"HH:MM"` on the 24-hour clock, or `None` for a
/// time-shaped text out of range ("24:00", "3:60pm", "0pm").
fn parse_time_string(text: &str) -> Option<String> {
    let cleaned: String = text
        .to_lowercase()
        .chars()
        .filter(|&c| !is_js_whitespace(c))
        .collect();
    let (hours, rest) = digit_run(&cleaned, 1, 2)?;
    let (minutes, after_minutes) = minutes_part(rest).unwrap_or((0, rest));
    let clock = |h: i64, m: i64| format!("{h:02}:{m:02}");

    let period = after_minutes;
    if period == "am" || period == "pm" {
        if minutes > 59 {
            return None;
        }
        // A 24-hour hour with a redundant meridiem ("14pm") keeps the hour.
        if (13..=23).contains(&hours) {
            return Some(clock(hours, minutes));
        }
        if !(1..=12).contains(&hours) {
            return None;
        }
        let hours = match (period, hours) {
            ("pm", 12) | ("am", 1..=11) => hours,
            ("pm", _) => hours + 12,
            _ => 0,
        };
        return Some(clock(hours, minutes));
    }

    let is_24_hour = rest.starts_with(':') && after_minutes.is_empty();
    (is_24_hour && hours <= 23 && minutes <= 59).then(|| clock(hours, minutes))
}

/// `:\d{2}` at the start of `text`: the minutes and the text after them.
pub(super) fn minutes_part(text: &str) -> Option<(i64, &str)> {
    digit_run(text.strip_prefix(':')?, 2, 2)
}

/// `toLocaleDateString('en-US', {weekday, month: 'long', day, year})`, plus
/// the 12-hour time when there is one.
fn display_text(date: CivilDate, time: Option<&str>) -> String {
    let weekday = usize::try_from(date.weekday())
        .ok()
        .and_then(|i| COMPLETION_WEEKDAYS.get(i))
        .copied()
        .unwrap_or_default();
    let month = usize::try_from(date.month)
        .ok()
        .and_then(|m| COMPLETION_MONTHS.get(m.wrapping_sub(1)))
        .copied()
        .unwrap_or_default();
    let date_text = format!("{weekday}, {month} {}, {}", date.day, date.year);

    let Some((hours, minutes)) = time.and_then(|time| time.split_once(':')) else {
        return date_text;
    };
    let hours: u32 = hours.parse().unwrap_or(0);
    let minutes: u32 = minutes.parse().unwrap_or(0);
    let period = if hours >= 12 { "PM" } else { "AM" };
    let display_hours = if hours.is_multiple_of(12) {
        12
    } else {
        hours % 12
    };
    format!("{date_text} · {display_hours}:{minutes:02} {period}")
}

/// A leading run of ASCII digits whose whole length is in `min..=max`, parsed,
/// and the text after it. A longer run is `None`: every `\d{m,n}` here is
/// followed by something that is not a digit.
fn digit_run(text: &str, min: usize, max: usize) -> Option<(i64, &str)> {
    let len = text.bytes().take_while(u8::is_ascii_digit).count();
    if !(min..=max).contains(&len) {
        return None;
    }
    let value = text[..len].parse().ok()?;
    Some((value, &text[len..]))
}

/// `(?:at\s+)` at the start of `text`, ASCII case-insensitive: the text after
/// the connector and all of its whitespace.
pub(super) fn strip_at_connector(text: &str) -> Option<&str> {
    let rest = text
        .get(..2)
        .filter(|at| at.eq_ignore_ascii_case("at"))
        .and_then(|_| text.get(2..))?;
    strip_required_whitespace(rest)
}

/// `\s+` at the start of `text`: the text after the whole run.
pub(super) fn strip_required_whitespace(text: &str) -> Option<&str> {
    let rest = js_trim_start(text);
    (rest.len() < text.len()).then_some(rest)
}

/// A leading 1-2 ASCII digit hour (`\d{1,2}` followed by a non-digit or the
/// end) and the text after it.
pub(super) fn hour_digits(text: &str) -> Option<(u32, &str)> {
    let (hours, rest) = digit_run(text, 1, 2)?;
    Some((u32::try_from(hours).ok()?, rest))
}

/// JavaScript's `\s` and `String.prototype.trim` set: WhiteSpace plus
/// LineTerminator.
pub(super) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JavaScript's LineTerminator: what `.` does not match.
pub(super) fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trim`.
pub(super) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimEnd`.
pub(super) fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// `String.prototype.trimStart`.
pub(super) fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `.replace(/\s+/g, ' ')`.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}
