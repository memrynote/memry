//! `packages/importers/src/ticktick/{dates,duration}.ts`: TickTick's instants as
//! `Intl.DateTimeFormat('en-CA', { timeZone })` splits them into a date and a time, `new Date(text)`
//! with the machine's zone for a time without one, and reminder offsets.
//!
//! Time zones come from jiff's bundled tzdb, so a zone's history (local mean time before its first
//! rule) and its rules past 2037 apply as ICU applies them. jiff covers years -9999 to 9999; a JS
//! Date reaches 275760, and an instant past jiff's range takes its offset from the same instant
//! moved by whole 400-year Gregorian cycles, which repeat every rule.

use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::tz::{AmbiguousOffset, Offset, TimeZone};
use memry_core::markdown::frontmatter::js_trim;
use regex::Regex;

use crate::web::extract::utils::date::{civil_from_days, parse_date_in};

const DAY_MS: i64 = 86_400_000;
/// 400 Gregorian years.
const CYCLE_MS: i64 = 146_097 * DAY_MS;
/// Inside jiff's -9999 to 9999 years, with room for any zone offset.
const JIFF_SAFE_MS: i64 = 9_000 * 365 * DAY_MS;

/// `ms` moved by whole 400-year cycles into jiff's range.
fn into_jiff_range(ms: i64) -> Timestamp {
    let cycles = |past: i64| (past + CYCLE_MS - 1) / CYCLE_MS * CYCLE_MS;
    let shifted = if ms > JIFF_SAFE_MS {
        ms - cycles(ms - JIFF_SAFE_MS)
    } else if ms < -JIFF_SAFE_MS {
        ms + cycles(-JIFF_SAFE_MS - ms)
    } else {
        ms
    };
    Timestamp::from_millisecond(shifted).expect("shifted into jiff's range")
}

/// The offset in milliseconds `zone` adds to UTC at a wall time (milliseconds since the epoch
/// read as UTC). In a gap or a fold V8 takes the offset in effect before the transition
/// (`UCAL_TZ_LOCAL_FORMER`).
pub(super) fn wall_offset_ms(zone: &TimeZone, wall_ms: f64) -> f64 {
    let wall = into_jiff_range(wall_ms as i64)
        .to_zoned(TimeZone::UTC)
        .datetime();
    let offset = match zone.to_ambiguous_timestamp(wall).offset() {
        AmbiguousOffset::Unambiguous { offset } => offset,
        AmbiguousOffset::Gap { before, .. } | AmbiguousOffset::Fold { before, .. } => before,
    };
    f64::from(offset.seconds()) * 1000.0
}

/// `new Date(text).getTime()` on a machine in `local`; `None` for `NaN`.
pub(super) fn parse_instant(text: &str, local: &TimeZone) -> Option<f64> {
    parse_date_in(text, |wall| wall_offset_ms(local, wall))
}

/// The offset string forms `Intl` takes as a time zone: `±HH`, `±HHMM` or `±HH:MM`, hours to 23,
/// the sign ASCII or U+2212.
fn offset_zone(name: &str) -> Option<TimeZone> {
    let (sign, rest) = if let Some(rest) = name.strip_prefix('+') {
        (1, rest)
    } else if let Some(rest) = name.strip_prefix(['-', '\u{2212}']) {
        (-1, rest)
    } else {
        return None;
    };
    let rest = rest.as_bytes();
    let (hours, minutes) = match rest {
        [h1, h2] => ([*h1, *h2], *b"00"),
        [h1, h2, m1, m2] | [h1, h2, b':', m1, m2] => ([*h1, *h2], [*m1, *m2]),
        _ => return None,
    };
    let number = |digits: [u8; 2]| {
        digits
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| i32::from(digits[0] - b'0') * 10 + i32::from(digits[1] - b'0'))
    };
    let (hours, minutes) = (number(hours)?, number(minutes)?);
    if hours > 23 || minutes > 59 {
        return None;
    }
    Offset::from_seconds(sign * (hours * 3600 + minutes * 60))
        .ok()
        .map(TimeZone::fixed)
}

/// `timezone.trim() || 'UTC'` as `Intl.DateTimeFormat` resolves it, and UTC where it throws.
/// The tzdb's `Factory` zone is one ICU refuses.
fn intl_zone(name: &str) -> TimeZone {
    let name = match js_trim(name) {
        "" => "UTC",
        name => name,
    };
    if name.eq_ignore_ascii_case("factory") {
        return TimeZone::UTC;
    }
    offset_zone(name)
        .or_else(|| jiff::tz::db().get(name).ok())
        .unwrap_or(TimeZone::UTC)
}

/// `splitDateTime(iso, timezone, allDay)`: the instant's `{ date, time }` in `timezone`, the year
/// as `en-CA` writes it (no padding; the era year before year 1).
pub(super) fn split_date_time(
    iso: &str,
    timezone: &str,
    all_day: bool,
    local: &TimeZone,
) -> (Option<String>, Option<String>) {
    if js_trim(iso).is_empty() {
        return (None, None);
    }
    let Some(ms) = parse_instant(iso, local) else {
        return (None, None);
    };
    let ms = ms as i64;
    let offset = intl_zone(timezone).to_offset(into_jiff_range(ms));
    let wall = ms + i64::from(offset.seconds()) * 1000;
    let (year, month, day) = civil_from_days(wall.div_euclid(DAY_MS));
    let year = if year > 0 { year } else { 1 - year };
    let minutes = wall.rem_euclid(DAY_MS) / 60_000;
    let time = (!all_day).then(|| format!("{:02}:{:02}", minutes / 60, minutes % 60));
    (Some(format!("{year}-{month:02}-{day:02}")), time)
}

static DURATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(-)?P(?:([0-9]+)W)?(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$",
    )
    .expect("static pattern")
});

/// `parseIsoDurationMs`: an ISO 8601 duration in signed milliseconds, in JS number arithmetic.
pub(super) fn duration_ms(token: &str) -> Option<f64> {
    let m = DURATION.captures(js_trim(token))?;
    let n = |i: usize| {
        m.get(i)
            .map_or(0.0, |g| g.as_str().parse::<f64>().unwrap_or(f64::INFINITY))
    };
    let ms = (n(2) * 7.0 * 24.0 * 60.0 * 60.0
        + n(3) * 24.0 * 60.0 * 60.0
        + n(4) * 60.0 * 60.0
        + n(5) * 60.0
        + n(6))
        * 1000.0;
    Some(if m.get(1).is_some() { -ms } else { ms })
}
