//! The `chrono-node` 2.9.0 subset of [`super::date`]: the grammar module doc of `date.rs` lists
//! what it covers.

use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use regex::{Captures, Regex};

use super::{resolve, rolled_date};

const MONTHS: &str = r"january|february|march|april|may|june|july|august|september|october|november|december|jan\.?|feb\.?|mar\.?|apr\.?|jun\.?|jul\.?|aug\.?|sept\.?|sep\.?|oct\.?|nov\.?|dec\.?";
const ORDINAL: &str = r"[0-9]{1,2}(?:st|nd|rd|th)?";
const YEAR: &str = r"[1-9][0-9]{0,3}\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-2][0-9]{3}|[5-9][0-9]|2[0-5]";
/// chrono's word-boundary prefix `(\W|^)`.
const LEFT: &str = r"(?:^|[^0-9A-Za-z_])";

fn chrono_re(body: &str) -> Regex {
    let pattern = format!("(?i){LEFT}({body})")
        .replace("MONTHS", MONTHS)
        .replace("ORDINAL", ORDINAL)
        .replace("YEAR", YEAR);
    Regex::new(&pattern).expect("static pattern")
}

static ISO_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    chrono_re(
        r"([0-9]{4})[-./]([0-9]{1,2})[-./]([0-9]{1,2})(?:T([0-9]{1,2}):([0-9]{1,2})(?::([0-9]{1,2})(?:\.([0-9]{1,4}))?)?(Z|([+-][0-9]{2}):?([0-9]{2})?)?)?",
    )
});
static SLASH: LazyLock<Regex> =
    LazyLock::new(|| chrono_re(r"([0-3]?[0-9])[/.\-]([0-3]?[0-9])(?:[/.\-]([0-9]{4}|[0-9]{2}))?"));
static MIDDLE: LazyLock<Regex> =
    LazyLock::new(|| chrono_re(r"(MONTHS)(?:-|/|\s*,?\s*)(ORDINAL)(?:(?:-|/|\s*,\s*|\s+)(YEAR))?"));
static LITTLE: LazyLock<Regex> = LazyLock::new(|| {
    chrono_re(
        r"(?:on\s{0,3})?(ORDINAL)(?:-|/|\s{0,3}(?:of)?\s{0,3})(MONTHS)(?:(?:-|/|,?\s{0,3})(YEAR))?",
    )
});
static MONTH_ONLY: LazyLock<Regex> =
    LazyLock::new(|| chrono_re(r"(in\s*)?(MONTHS)(?:\s*(?:,|-|of)?\s*(YEAR))?"));
static CASUAL: LazyLock<Regex> =
    LazyLock::new(|| chrono_re(r"now|today|tonight|tomorrow|tmr|tmrw|yesterday|last\s*night"));
static AGO: LazyLock<Regex> = LazyLock::new(|| {
    chrono_re(
        r"([0-9]+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s{0,3}(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s{0,5}(?:ago|before|earlier)",
    )
});
static TIME: LazyLock<Regex> = LazyLock::new(|| {
    chrono_re(
        r"(?:at\s*)?([0-9]{1,2})(?:(?::|\.)([0-9]{2})(?::([0-9]{2}))?)?\s*(a\.?m\.?|p\.?m\.?)?",
    )
});
/// Text between a date and a time that `ENMergeDateTimeRefiner` joins across.
static JOIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:T|at|after|before|on|of|,|-|\.|:)?\s*$").expect("static pattern")
});
static ZONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*,?\s*\(?(?:(Z|UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|BST|CET|CEST)\b)?\s?(?:([+-])([0-9]{1,2})(?::?([0-9]{2}))?)?\)?")
        .expect("static pattern")
});

/// What one parser found: a wall-clock time (when given) on a date (when given), or an instant.
#[derive(Clone, Debug)]
enum Found {
    Day(NaiveDate),
    Time(u32, u32, u32),
    Instant(NaiveDateTime),
    /// A moment relative to `now` (`now`, `yesterday`, `3 days ago`).
    Relative(DateTime<Utc>),
}

struct Hit {
    start: usize,
    end: usize,
    found: Found,
    offset: Option<i32>,
}

fn word_after(text: &str, end: usize) -> bool {
    text[end..]
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The match start after the `(\W|^)` prefix, and the end, of capture group 1.
fn span(caps: &Captures) -> (usize, usize) {
    let whole = caps.get(1).expect("group 1");
    (whole.start(), whole.end())
}

fn year_value(text: &str) -> Option<i32> {
    let upper = text.to_ascii_uppercase();
    let digits: String = upper.chars().filter(char::is_ascii_digit).collect();
    let n: i32 = digits.parse().ok()?;
    Some(if upper.contains("BE") {
        n - 543
    } else if upper.contains("BC") {
        -n
    } else if upper.contains("AD") || upper.contains("CE") || n >= 100 {
        n
    } else if n > 50 {
        n + 1900
    } else {
        n + 2000
    })
}

fn ordinal(text: &str) -> Option<u32> {
    text.trim_end_matches(|c: char| c.is_ascii_alphabetic())
        .parse()
        .ok()
}

fn month_number(text: &str) -> Option<u32> {
    let lower = text.to_ascii_lowercase();
    let key = lower.trim_end_matches('.');
    let names = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    names
        .iter()
        .position(|name| key.starts_with(name))
        .map(|i| i as u32 + 1)
}

/// `findYearClosestToRef`: this year's, last year's or next year's date, whichever is nearest.
fn closest_year<Tz: TimeZone>(now: &DateTime<Tz>, month: u32, day: u32) -> Option<NaiveDate> {
    let today = now.naive_local().date();
    [today.year(), today.year() + 1, today.year() - 1]
        .into_iter()
        .filter_map(|year| rolled_date(year, month, day))
        .min_by_key(|date| (*date - today).num_days().abs())
}

fn collect<Tz: TimeZone>(text: &str, now: &DateTime<Tz>) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut push = |start, end, found, offset| {
        hits.push(Hit {
            start,
            end,
            found,
            offset,
        })
    };
    for caps in ISO_TEXT.captures_iter(text) {
        let (start, end) = span(&caps);
        if word_after(text, end) {
            continue;
        }
        let num = |i: usize| caps.get(i).and_then(|m| m.as_str().parse::<u32>().ok());
        let Some(date) = rolled_date(
            num(2).unwrap_or(0) as i32,
            num(3).unwrap_or(0),
            num(4).unwrap_or(0),
        ) else {
            continue;
        };
        match num(5) {
            Some(hour) => {
                let at = date.and_hms_milli_opt(
                    hour,
                    num(6).unwrap_or(0),
                    num(7).unwrap_or(0),
                    num(8).unwrap_or(0),
                );
                let offset = caps.get(9).map(|zone| {
                    if zone.as_str().eq_ignore_ascii_case("z") {
                        return 0;
                    }
                    let hours: i32 = caps[10].parse().unwrap_or(0);
                    let minutes = num(11).unwrap_or(0) as i32;
                    hours * 60 + hours.signum() * minutes
                });
                if let Some(at) = at {
                    push(start, end, Found::Instant(at), offset);
                }
            }
            None => push(start, end, Found::Day(date), None),
        }
    }
    for caps in SLASH.captures_iter(text) {
        let (start, end) = span(&caps);
        if word_after(text, end) {
            continue;
        }
        let (mut month, mut day): (u32, u32) =
            (caps[2].parse().unwrap_or(0), caps[3].parse().unwrap_or(0));
        if month > 12 && (1..=12).contains(&day) && month <= 31 {
            std::mem::swap(&mut month, &mut day);
        }
        let date = match caps.get(4) {
            Some(year) => year_value(year.as_str()).and_then(|y| rolled_date(y, month, day)),
            None => closest_year(now, month, day),
        };
        if let Some(date) = date {
            push(start, end, Found::Day(date), None);
        }
    }
    for (re, month_group, day_group, year_group) in [(&*MIDDLE, 2, 3, 4), (&*LITTLE, 3, 2, 4)] {
        for caps in re.captures_iter(text) {
            let (start, end) = span(&caps);
            if word_after(text, end) {
                continue;
            }
            let (Some(month), Some(day)) =
                (month_number(&caps[month_group]), ordinal(&caps[day_group]))
            else {
                continue;
            };
            if day > 31 {
                continue;
            }
            let date = match caps.get(year_group) {
                Some(year) => year_value(year.as_str()).and_then(|y| rolled_date(y, month, day)),
                None => closest_year(now, month, day),
            };
            if let Some(date) = date {
                push(start, end, Found::Day(date), None);
            }
        }
    }
    for caps in MONTH_ONLY.captures_iter(text) {
        let (start, end) = span(&caps);
        let name = &caps[3];
        let prefix = caps.get(2).map_or(0, |m| m.len());
        let after = &text[end..];
        let followed = after.is_empty()
            || after.starts_with(|c: char| !c.is_whitespace() && !c.is_alphanumeric() && c != '_')
            || after.trim_start().is_empty()
            || after
                .trim_start()
                .starts_with(|c: char| !c.is_ascii_digit())
                && after.starts_with(char::is_whitespace);
        if !followed || (end - start <= 3 && !is_full_month(name)) {
            continue;
        }
        // `ENUnlikelyFormatFilter`: a lone `may` needs `in` before it, or to be the whole text.
        if name.eq_ignore_ascii_case("may")
            && caps.get(4).is_none()
            && !ends_with_word_in(&text[..start + prefix])
            && text.trim() != name
        {
            continue;
        }
        let Some(month) = month_number(name) else {
            continue;
        };
        let date = match caps.get(4) {
            Some(year) => year_value(year.as_str()).and_then(|y| rolled_date(y, month, 1)),
            None => closest_year(now, month, 1),
        };
        if let Some(date) = date {
            push(start + prefix, end, Found::Day(date), None);
        }
    }
    let reference = now.naive_local();
    let instant = now.to_utc();
    for caps in CASUAL.captures_iter(text) {
        let (start, end) = span(&caps);
        if word_after(text, end) {
            continue;
        }
        let word = caps[2].to_ascii_lowercase();
        let found = match word.as_str() {
            "now" | "today" => Found::Relative(instant),
            "tonight" => {
                Found::Instant(reference.date().and_hms_opt(22, 0, 0).unwrap_or(reference))
            }
            "yesterday" => Found::Relative(instant - Duration::days(1)),
            w if w.starts_with("last") => Found::Instant(
                (reference - Duration::days(1))
                    .date()
                    .and_time(NaiveTime::MIN),
            ),
            _ => Found::Relative(instant + Duration::days(1)),
        };
        push(start, end, found, None);
    }
    for caps in AGO.captures_iter(text) {
        let (start, end) = span(&caps);
        if word_after(text, end) {
            continue;
        }
        let words = [
            "a", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
            "eleven", "twelve",
        ];
        let amount = caps[2].to_ascii_lowercase();
        let n = amount.parse::<i64>().ok().or_else(|| {
            if amount == "an" {
                Some(1)
            } else {
                words
                    .iter()
                    .position(|w| *w == amount)
                    .map(|i| i.max(1) as i64)
            }
        });
        let Some(n) = n else { continue };
        let unit = caps[3].to_ascii_lowercase();
        // Past chrono's range chrono-node gives an Invalid Date, so no date.
        let back = match unit.chars().next() {
            Some('s') => Duration::try_seconds(n),
            Some('h') => Duration::try_hours(n),
            Some('d') => Duration::try_days(n),
            Some('w') => Duration::try_weeks(n),
            Some('y') => n.checked_mul(365).and_then(Duration::try_days),
            _ if unit.starts_with("mo") => n.checked_mul(30).and_then(Duration::try_days),
            _ => Duration::try_minutes(n),
        };
        let Some(then) = back.and_then(|back| instant.checked_sub_signed(back)) else {
            continue;
        };
        push(start, end, Found::Relative(then), None);
    }
    for caps in TIME.captures_iter(text) {
        let (start, end) = span(&caps);
        let has_minutes = caps.get(3).is_some();
        let meridiem = caps.get(5).map(|m| m.as_str().to_ascii_lowercase());
        if (!has_minutes && meridiem.is_none()) || word_after(text, end) {
            continue;
        }
        let Some(mut hour) = caps[2].parse::<u32>().ok() else {
            continue;
        };
        let minute = caps
            .get(3)
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .unwrap_or(0);
        let second = caps
            .get(4)
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .unwrap_or(0);
        match meridiem.as_deref().map(|m| m.starts_with('p')) {
            Some(_) if hour == 0 || hour > 12 => continue,
            Some(true) if hour < 12 => hour += 12,
            Some(false) if hour == 12 => hour = 0,
            _ => {}
        }
        if hour > 23 || minute > 59 || second > 59 {
            continue;
        }
        push(start, end, Found::Time(hour, minute, second), None);
    }
    hits
}

/// `chrono.parseDate(text)`: the first result after overlapping results keep the longest.
pub fn chrono_parse<Tz: TimeZone>(text: &str, now: &DateTime<Tz>) -> Option<DateTime<Utc>> {
    let mut hits = collect(text, now);
    hits.sort_by_key(|hit| (hit.start, std::cmp::Reverse(hit.end)));
    let mut kept: Vec<Hit> = Vec::new();
    for hit in hits {
        match kept.last() {
            Some(last) if hit.start < last.end => {
                if hit.end - hit.start > last.end - last.start {
                    kept.pop();
                    kept.push(hit);
                }
            }
            _ => kept.push(hit),
        }
    }
    let first = kept.first()?;
    let next_joined = |kind: fn(&Found) -> bool| {
        kept.get(1)
            .filter(|next| kind(&next.found) && JOIN.is_match(&text[first.end..next.start]))
    };
    let (local, offset, end) = match &first.found {
        Found::Relative(at) => return Some(*at),
        Found::Instant(at) => (*at, first.offset, Some(first.end)),
        Found::Day(date) => match next_joined(|f| matches!(f, Found::Time(..))) {
            Some(Hit {
                found: Found::Time(h, m, s),
                end,
                ..
            }) => (date.and_hms_opt(*h, *m, *s)?, None, Some(*end)),
            // A date without a time takes no timezone.
            _ => (date.and_hms_opt(12, 0, 0)?, None, None),
        },
        Found::Time(h, m, s) => match next_joined(|f| matches!(f, Found::Day(_))) {
            Some(Hit {
                found: Found::Day(date),
                end,
                ..
            }) => (date.and_hms_opt(*h, *m, *s)?, None, Some(*end)),
            _ => (
                now.naive_local().date().and_hms_opt(*h, *m, *s)?,
                None,
                Some(first.end),
            ),
        },
    };
    let zone = end.and_then(|end| zone_after(&text[end..]));
    resolve(local, offset.or(zone), now)
}

fn is_full_month(name: &str) -> bool {
    let full = [
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
    full.contains(&name.to_ascii_lowercase().as_str())
}

/// `/\b(in)$/i` on the trimmed text before a result.
fn ends_with_word_in(before: &str) -> bool {
    let trimmed = before.trim_end().to_ascii_lowercase();
    trimmed.ends_with("in")
        && !trimmed[..trimmed.len() - 2]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The timezone abbreviation or offset after a time (`ExtractTimezoneAbbrRefiner`,
/// `ExtractTimezoneOffsetRefiner`), in minutes east.
fn zone_after(rest: &str) -> Option<i32> {
    let caps = ZONE.captures(rest)?;
    let base = caps.get(1).map(|abbr| match abbr.as_str() {
        "EST" | "CDT" => -300,
        "EDT" => -240,
        "CST" | "MDT" => -360,
        "MST" | "PDT" => -420,
        "PST" => -480,
        "BST" | "CET" => 60,
        "CEST" => 120,
        _ => 0,
    });
    let shift = caps.get(2).map(|sign| {
        let hours: i32 = caps[3].parse().unwrap_or(0);
        let minutes: i32 = caps.get(4).map_or(0, |m| m.as_str().parse().unwrap_or(0));
        let magnitude = hours * 60 + minutes;
        if sign.as_str() == "-" {
            -magnitude
        } else {
            magnitude
        }
    });
    match (base, shift) {
        (None, None) => None,
        (base, shift) => Some(base.unwrap_or(0) + shift.unwrap_or(0)),
    }
}
