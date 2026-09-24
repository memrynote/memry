//! Inline ghost-text completion for the date phrase typed after `@` (spec 004
//! D1), ported from `packages/domain-tasks/src/parsing/completion.ts`.
//!
//! English tables only: the renderer's `CompletionLocale` belongs to the note
//! editor, not the task surfaces, so this is the TypeScript's default
//! (English) path. The `completion.date` section of the `task-parsing`
//! vectors pins all three functions. The patterns are hand-written matchers
//! with JavaScript regex semantics: `^(.*?\S)` takes the **shortest** date
//! prefix the rest of the pattern accepts, `^(.*\S)` the **longest**, and `.`
//! stops at a line terminator. The hour/date checks run once on the regex's
//! own capture, never on a different split.

use super::natural_date::{
    hour_digits, is_js_line_terminator, is_js_whitespace, js_trim, js_trim_end, js_trim_start,
    minutes_part, parse_natural_date, strip_at_connector, strip_required_whitespace,
};
use crate::domain::calendar::LocalDateTime;

/// Weekday names in completion (and display) casing, indexed by `getDay()`.
pub const COMPLETION_WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Month names in completion (and display) casing, January first.
pub const COMPLETION_MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Single-token relative words, in priority order ("t" is Today, not
/// Tomorrow, Tuesday or Thursday).
const RELATIVE: [&str; 3] = ["Today", "Tomorrow", "Yesterday"];

/// The time-of-day completion for the inline ghost, or `None`.
///
/// Keeps the typed text verbatim and appends only the padding: `"12"` and
/// `"12:"` become `"12:00"`; `"today 12"`, `"today at 12:"` become
/// `"today 12:00"`, `"today at 12:00"`. A number after something that is not
/// a date ("meeting 12") is left alone.
pub fn predict_time(query: &str, now: LocalDateTime) -> Option<String> {
    let q = js_trim_end(query);
    let padded = |colon: bool| {
        if colon {
            format!("{q}00")
        } else {
            format!("{q}:00")
        }
    };

    // Bare time at the caret: `^(\d{1,2})(:?)$`.
    if let Some((hours, colon)) = hour_then_optional_colon(q) {
        return (hours <= 23).then(|| padded(colon));
    }

    // `^(.*?\S)\s+(?:at\s+)?(\d{1,2})(:?)$`.
    let (date, (hours, colon)) = split_date_prefix(q, Prefix::Shortest, |rest| {
        after_date_gap(rest, hour_then_optional_colon)
    })?;
    (hours <= 23 && parse_natural_date(date, now).is_ok()).then(|| padded(colon))
}

/// Whether the query is mid-way through typing a time after a date, with
/// nothing confident to ghost yet: a fresh `at` connector ("today at"), a
/// single minute digit ("today 12:3", "23:3"), or a meridiem being typed
/// ("today 2p", "next monday 2:30p").
pub fn is_time_in_progress(query: &str, now: LocalDateTime) -> bool {
    // `^(.*\S)\s+at\s*$`, on the untrimmed query.
    if let Some((date, ())) = split_date_prefix(query, Prefix::Longest, at_connector_only) {
        return parse_natural_date(date, now).is_ok();
    }

    let q = js_trim_end(query);
    let dated_hour = |pattern: fn(&str) -> Option<u32>| {
        split_date_prefix(q, Prefix::Shortest, |rest| after_date_gap(rest, pattern))
            .map(|(date, hours)| hours <= 23 && parse_natural_date(date, now).is_ok())
    };

    // `^(.*?\S)\s+(?:at\s+)?(\d{1,2}):(\d)$`.
    if let Some(in_progress) = dated_hour(hour_and_one_minute_digit) {
        return in_progress;
    }
    // `^(.*?\S)\s+(?:at\s+)?(\d{1,2})(?::\d{2})?\s*([ap]m?)$`, case-insensitive.
    if let Some(in_progress) = dated_hour(hour_and_partial_meridiem) {
        return in_progress;
    }
    // Bare `^(\d{1,2}):(\d)$`.
    hour_and_one_minute_digit(q).is_some_and(|hours| hours <= 23)
}

/// The best full completion for the text typed after `@`, in canonical
/// casing, or `None` when it is not date-ish.
///
/// The result is a case-insensitive extension of `query`: callers show the
/// part past `query`'s length as the ghost and replace the query with the
/// whole string on accept. An empty query completes to `"Today"`.
pub fn predict_date_completion(query: &str, now: LocalDateTime) -> Option<String> {
    let trimmed = js_trim(query);
    if trimmed.is_empty() {
        return Some(RELATIVE[0].to_string());
    }

    if let Some(time) = predict_time(query, now) {
        return Some(time);
    }

    let lowered = trimmed.to_lowercase();
    let mut tokens = lowered.split(is_js_whitespace).filter(|t| !t.is_empty());
    let first = tokens.next().unwrap_or_default();
    let second = tokens.next().unwrap_or_default();

    // "next"/"last" (+ weekday): a partial second token picks the weekday,
    // otherwise today's.
    for connector in ["next", "last"] {
        if connector.starts_with(first) {
            let weekday = match_weekday(second)
                .or_else(|| {
                    usize::try_from(now.date().weekday())
                        .ok()
                        .and_then(|i| COMPLETION_WEEKDAYS.get(i).copied())
                })
                .unwrap_or_default();
            let candidate = format!("{connector} {weekday}");
            if starts_with_ci(&candidate, query) {
                return Some(candidate);
            }
        }
    }

    RELATIVE
        .iter()
        .chain(&COMPLETION_WEEKDAYS)
        .chain(&COMPLETION_MONTHS)
        .find(|candidate| starts_with_ci(candidate, query))
        .map(|candidate| (*candidate).to_string())
}

/// The first weekday whose lowercase name starts with `prefix`; `None` for an
/// empty prefix.
fn match_weekday(prefix: &str) -> Option<&'static str> {
    if prefix.is_empty() {
        return None;
    }
    COMPLETION_WEEKDAYS
        .iter()
        .find(|weekday| weekday.to_lowercase().starts_with(prefix))
        .copied()
}

fn starts_with_ci(candidate: &str, query: &str) -> bool {
    candidate
        .to_lowercase()
        .starts_with(query.to_lowercase().as_str())
}

/// Which prefix `^(.*?\S)` / `^(.*\S)` captures when several would do.
#[derive(Clone, Copy)]
enum Prefix {
    Shortest,
    Longest,
}

/// `^(.*?\S)` or `^(.*\S)` followed by `tail`: the captured date text and
/// what `tail` read from the rest. The capture cannot cross a line terminator
/// (`.`) and ends in a non-whitespace character (`\S`).
fn split_date_prefix<'a, T>(
    text: &'a str,
    prefix: Prefix,
    tail: impl Fn(&'a str) -> Option<T>,
) -> Option<(&'a str, T)> {
    let line_end = text.find(is_js_line_terminator).unwrap_or(text.len());
    let ends = text[..line_end]
        .char_indices()
        .filter(|&(_, c)| !is_js_whitespace(c))
        .map(|(start, c)| start + c.len_utf8());
    let attempt = |end: usize| tail(&text[end..]).map(|found| (&text[..end], found));
    match prefix {
        Prefix::Shortest => { ends }.find_map(attempt),
        Prefix::Longest => ends.rev().find_map(attempt),
    }
}

/// `\s+(?:at\s+)?` then `time` to the end: the connector is tried first, as
/// the greedy optional group is.
fn after_date_gap<'a, T>(rest: &'a str, time: impl Fn(&'a str) -> Option<T>) -> Option<T> {
    let rest = strip_required_whitespace(rest)?;
    strip_at_connector(rest)
        .and_then(&time)
        .or_else(|| time(rest))
}

/// `\s+at\s*$`, case-insensitive.
fn at_connector_only(rest: &str) -> Option<()> {
    let rest = strip_required_whitespace(rest)?;
    let after_at = rest
        .get(..2)
        .filter(|at| at.eq_ignore_ascii_case("at"))
        .and_then(|_| rest.get(2..))?;
    js_trim_start(after_at).is_empty().then_some(())
}

/// `(\d{1,2})(:?)$`: the hour and whether the colon was typed.
fn hour_then_optional_colon(text: &str) -> Option<(u32, bool)> {
    let (hours, rest) = hour_digits(text)?;
    match rest {
        "" => Some((hours, false)),
        ":" => Some((hours, true)),
        _ => None,
    }
}

/// `(\d{1,2}):(\d)$`: the hour.
fn hour_and_one_minute_digit(text: &str) -> Option<u32> {
    let (hours, rest) = hour_digits(text)?;
    let minute = rest.strip_prefix(':')?;
    (minute.len() == 1 && minute.bytes().all(|b| b.is_ascii_digit())).then_some(hours)
}

/// `(\d{1,2})(?::\d{2})?\s*([ap]m?)$`, case-insensitive: the hour.
fn hour_and_partial_meridiem(text: &str) -> Option<u32> {
    let (hours, rest) = hour_digits(text)?;
    let rest = minutes_part(rest).map_or(rest, |(_, after)| after);
    let meridiem = js_trim_start(rest).to_ascii_lowercase();
    matches!(meridiem.as_str(), "a" | "p" | "am" | "pm").then_some(hours)
}
