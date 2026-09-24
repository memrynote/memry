//! `parseRepeatPhrase` / `findRepeatPhrase`: natural-language recurrence for
//! quick-add ("every monday", "every 2 weeks", "every weekday") to the same
//! [`RepeatConfig`] the repeat picker produces (spec 004 D1), ported from
//! `packages/domain-tasks/src/parsing/repeat-phrase.ts`.
//!
//! English only: a phrase in any other language does not parse and stays in
//! the title. `now` stamps the config's `createdAt`; nothing here reads a
//! clock. The first due date of a captured series is
//! [`crate::domain::recurrence::first_occurrence_for`].
//!
//! The TypeScript regexes are hand-written matchers with JavaScript semantics:
//! `\b` and `\w` are ASCII (`/i` without `u` folds ASCII only), `\s` is
//! JavaScript whitespace, and every offset handed out is a UTF-16 code unit
//! index. Internally offsets are UTF-8 byte indices, converted at the API edge.

use std::ops::Range;

use super::natural_date::{is_js_whitespace, js_trim};
use crate::domain::calendar::{CivilDate, LocalDateTime, MS_PER_DAY};
use crate::domain::repeat_config::{Frequency, MonthlyType, RepeatConfig};

/// A recurrence phrase found in a larger input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepeatPhraseMatch {
    /// UTF-16 index of the phrase in the scanned input.
    pub start: usize,
    /// Exclusive UTF-16 end index of the phrase.
    pub end: usize,
    /// The matched text, verbatim (what the pill paints over).
    pub text: String,
    pub config: RepeatConfig,
}

/// "every" plus at most this many words: the cap on the greedy phrase scan.
const MAX_PHRASE_WORDS: usize = 6;

const WEEKDAYS: [i64; 5] = [1, 2, 3, 4, 5];
const WEEKEND: [i64; 2] = [0, 6];

/// `WEEKDAY_INDEXES`. An inherited `Object.prototype` key ("constructor",
/// "__proto__") is truthy in the TypeScript lookup and yields an unusable
/// config there; here it is simply not a weekday.
fn weekday_index(word: &str) -> Option<i64> {
    Some(match word {
        "sun" | "sunday" => 0,
        "mon" | "monday" => 1,
        "tue" | "tues" | "tuesday" => 2,
        "wed" | "weds" | "wednesday" => 3,
        "thu" | "thur" | "thurs" | "thursday" => 4,
        "fri" | "friday" => 5,
        "sat" | "saturday" => 6,
        _ => return None,
    })
}

/// Parses a full "every ..." phrase. `anchor` supplies the day of month a
/// bare "every month" repeats on: the task's due date when it has one.
pub fn parse_repeat_phrase(
    phrase: &str,
    anchor: CivilDate,
    now: LocalDateTime,
) -> Option<RepeatConfig> {
    let normalized = collapse_whitespace(&phrase.to_lowercase());
    let normalized = js_trim(&normalized);
    // `/^every\s+(.+)$/`: whitespace is already a single space, and `.` matches
    // everything left since no line terminator survives the collapse.
    let rest = normalized
        .strip_prefix("every ")
        .filter(|rest| !rest.is_empty())?;

    let config = |frequency, interval| RepeatConfig::new(frequency, interval, iso_instant(now));

    if rest == "weekday" || rest == "weekdays" {
        return Some(RepeatConfig {
            days_of_week: Some(WEEKDAYS.to_vec()),
            ..config(Frequency::Weekly, 1)
        });
    }
    if rest == "weekend" || rest == "weekends" {
        return Some(RepeatConfig {
            days_of_week: Some(WEEKEND.to_vec()),
            ..config(Frequency::Weekly, 1)
        });
    }

    // `/^(?:(\d+|other)\s+)?(.+)$/`: the optional count is taken whenever it
    // can be, and the unit form below is the same split.
    let (count, body) = split_count(rest);

    // `/^(?:(\d+|other)\s+)?(day|week|month|year)s?$/`.
    if let Some(unit) = unit_name(body) {
        let interval = parse_interval(count)?;
        return Some(match unit {
            "day" => config(Frequency::Daily, interval),
            "week" => config(Frequency::Weekly, interval),
            "month" => RepeatConfig {
                monthly_type: Some(MonthlyType::DayOfMonth),
                day_of_month: Some(i64::from(anchor.day)),
                ..config(Frequency::Monthly, interval)
            },
            _ => config(Frequency::Yearly, interval),
        });
    }

    let interval = parse_interval(count)?;
    let days_of_week = parse_weekday_list(body)?;
    Some(RepeatConfig {
        days_of_week: Some(days_of_week),
        ..config(Frequency::Weekly, interval)
    })
}

/// Finds the first "every ..." run in `input` that reads as a recurrence.
///
/// Longest match wins, so "water plants every 2 weeks at noon" keeps "at
/// noon" in the title. A run that does not parse ("every door") is skipped.
pub fn find_repeat_phrase(
    input: &str,
    anchor: CivilDate,
    now: LocalDateTime,
) -> Option<RepeatPhraseMatch> {
    let (range, config) = find_repeat_phrase_range(input, anchor, now)?;
    Some(RepeatPhraseMatch {
        start: utf16_index(input, range.start),
        end: utf16_index(input, range.end),
        text: input.get(range)?.to_owned(),
        config,
    })
}

/// [`find_repeat_phrase`] with UTF-8 byte offsets, for the quick-add parser.
pub(super) fn find_repeat_phrase_range(
    input: &str,
    anchor: CivilDate,
    now: LocalDateTime,
) -> Option<(Range<usize>, RepeatConfig)> {
    every_matches(input).into_iter().find_map(|start| {
        let rest = input.get(start..)?;
        let ends = word_ends(rest, MAX_PHRASE_WORDS);
        // Two words minimum ("every day"); longest first.
        ends.iter().skip(1).rev().find_map(|&end| {
            let config = parse_repeat_phrase(rest.get(..end)?, anchor, now)?;
            Some((start..start + end, config))
        })
    })
}

/// Byte starts of `/\bevery\b/gi` in `input`.
fn every_matches(input: &str) -> Vec<usize> {
    let bytes = input.as_bytes();
    let is_word = |i: usize| bytes.get(i).is_some_and(|b| is_ascii_word(*b));
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 5 <= bytes.len() {
        let boundary_before = i == 0 || !is_word(i - 1);
        if boundary_before && bytes[i..i + 5].eq_ignore_ascii_case(b"every") && !is_word(i + 5) {
            starts.push(i);
            i += 5;
        } else {
            i += 1;
        }
    }
    starts
}

/// `(\d+|other)\s+` at the start of `rest` when the text after it is
/// non-empty: the count and the remainder; otherwise no count and all of it.
fn split_count(rest: &str) -> (Option<&str>, &str) {
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let count_len = if digits > 0 {
        digits
    } else if rest.starts_with("other") {
        "other".len()
    } else {
        return (None, rest);
    };
    let (count, after) = rest.split_at(count_len);
    match after.strip_prefix(' ').filter(|body| !body.is_empty()) {
        Some(body) => (Some(count), body),
        None => (None, rest),
    }
}

/// `(day|week|month|year)s?` as the whole of `body`: the singular unit.
fn unit_name(body: &str) -> Option<&str> {
    let unit = body.strip_suffix('s').unwrap_or(body);
    ["day", "week", "month", "year"]
        .into_iter()
        .find(|&known| known == unit)
}

/// `parseInterval`: absent is 1, "other" is 2, a number must be 1..=999.
fn parse_interval(raw: Option<&str>) -> Option<i64> {
    let Some(raw) = raw else { return Some(1) };
    if raw == "other" {
        return Some(2);
    }
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // `Number.parseInt`: any value past 999 fails the range check alike.
    let value = raw
        .bytes()
        .fold(0_i64, |acc, b| (acc * 10 + i64::from(b - b'0')).min(1000));
    (1..=999).contains(&value).then_some(value)
}

/// `parseWeekdayList`: the listed weekdays, deduplicated and ascending, or
/// `None` when the list is empty or holds anything but a weekday.
fn parse_weekday_list(rest: &str) -> Option<Vec<i64>> {
    let without_and = replace_and_words(rest);
    let mut days = Vec::new();
    for word in without_and
        .split(|c: char| is_js_whitespace(c) || c == ',')
        .filter(|word| !word.is_empty())
    {
        let index = weekday_index(word)?;
        if !days.contains(&index) {
            days.push(index);
        }
    }
    days.sort_unstable();
    (!days.is_empty()).then_some(days)
}

/// `.replace(/\band\b/g, ' ')` with ASCII word boundaries.
fn replace_and_words(text: &str) -> String {
    let bytes = text.as_bytes();
    let is_word = |i: usize| bytes.get(i).is_some_and(|b| is_ascii_word(*b));
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if &bytes[i..i + 3] == b"and" && (i == 0 || !is_word(i - 1)) && !is_word(i + 3) {
            out.push_str(text.get(copied..i).unwrap_or_default());
            out.push(' ');
            i += 3;
            copied = i;
        } else {
            i += 1;
        }
    }
    out.push_str(text.get(copied..).unwrap_or_default());
    out
}

/// JavaScript's non-Unicode `\w`: `[A-Za-z0-9_]`.
pub(super) fn is_ascii_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Byte ends of the first `max` `/\S+/g` runs in `text`.
pub(super) fn word_ends(text: &str, max: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut in_word = false;
    for (i, c) in text.char_indices() {
        let whitespace = is_js_whitespace(c);
        if in_word && whitespace {
            ends.push(i);
            if ends.len() == max {
                return ends;
            }
        }
        in_word = !whitespace;
    }
    if in_word {
        ends.push(text.len());
    }
    ends
}

/// The UTF-16 index of UTF-8 byte offset `byte` in `text`.
pub(super) fn utf16_index(text: &str, byte: usize) -> usize {
    text.get(..byte)
        .map_or(0, |prefix| prefix.encode_utf16().count())
}

/// `.replace(/\s+/g, ' ')`.
pub(super) fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        let whitespace = is_js_whitespace(c);
        if !whitespace {
            out.push(c);
        } else if !in_run {
            out.push(' ');
        }
        in_run = whitespace;
    }
    out
}

/// `new Date(now)` as JSON writes it (`toISOString`), with the local wall
/// clock read as UTC: the vectors are generated with `TZ=UTC`.
fn iso_instant(now: LocalDateTime) -> String {
    let date = now.date();
    let millis = now.ms().rem_euclid(MS_PER_DAY);
    let (hour, minute) = (millis / 3_600_000, millis / 60_000 % 60);
    let (second, milli) = (millis / 1000 % 60, millis % 1000);
    let year = if (0..=9999).contains(&date.year) {
        format!("{:04}", date.year)
    } else {
        let sign = if date.year < 0 { '-' } else { '+' };
        format!("{sign}{:06}", date.year.unsigned_abs())
    };
    format!(
        "{year}-{:02}-{:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z",
        date.month, date.day
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_word_scans_are_reproduced() {
        assert_eq!(every_matches("Every day, everyone every-day"), vec![0, 20]);
        assert_eq!(word_ends("  a bb\tc ", 2), vec![3, 6]);
        assert_eq!(replace_and_words("mon,and,tue sand"), "mon, ,tue sand");
        assert_eq!(utf16_index("🎉 a", "🎉 ".len()), 3);
    }

    #[test]
    fn created_at_is_the_iso_instant() {
        let now = LocalDateTime::parse("2026-01-14T12:00:00.5").map(iso_instant);
        assert_eq!(now.as_deref(), Some("2026-01-14T12:00:00.500Z"));
    }
}
