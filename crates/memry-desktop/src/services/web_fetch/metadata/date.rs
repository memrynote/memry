//! The `date` mapper of `@metascraper/helpers` 5.49.21: ISO strings through `new Date`, a lone
//! year, epoch numbers in seconds to nanoseconds, and free text through `chrono.parseDate`.
//!
//! `chrono-node` 2.9.0 is a large grammar; [`chrono_parse`] ports the parts that dates on web
//! pages use: ISO and year-month-day dates, slash dates (month first), month-name dates in both
//! orders and a month with an optional year (with chrono's `may` filter), the casual words
//! (`now`, `today`, `tonight`, `yesterday`, `tomorrow`, `last night`), `<n> <unit> ago`, and a
//! clock time with an optional timezone merged into the date before it. Other phrases (weekday
//! names, `next week`, `in 3 days`, ranges' end dates, ordinal words) give no date. Like chrono
//! and `new Date`, a date without a timezone is read in the local timezone of `now`, and a date
//! without a time is at 12:00.

mod chrono_subset;

use std::sync::LazyLock;

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone, Utc,
};
use regex::Regex;

use super::text::condense;
use crate::web::extract::utils::json::JsValue;
use chrono_subset::chrono_parse;

/// `TimeClip`'s range: a `Date` further from the epoch is invalid.
const MAX_MS: f64 = 8.64e15;

/// `date(value)` for a string or a number; other values give `None`.
pub fn date<Tz: TimeZone>(value: &JsValue, now: &DateTime<Tz>) -> Option<String> {
    match value {
        JsValue::String(s) => date_text(s, now),
        JsValue::Number(n) => date_number(*n),
        _ => None,
    }
}

pub fn date_text<Tz: TimeZone>(value: &str, now: &DateTime<Tz>) -> Option<String> {
    let value = condense(value);
    if let Some(iso) = iso_string(&value, now) {
        return Some(iso);
    }
    if value.len() == 4 && value.bytes().all(|b| b.is_ascii_digit()) {
        let year: i32 = value.parse().ok()?;
        return Some(iso(Utc.with_ymd_and_hms(year, 1, 1, 0, 0, 0).single()?));
    }
    value
        .split('\n')
        .filter(|item| !item.is_empty())
        .find_map(|item| chrono_parse(item, now))
        .map(iso)
}

fn date_number(value: f64) -> Option<String> {
    let year_like = (1000.0..10000.0).contains(&value) && value.fract() == 0.0;
    if year_like {
        // `/^\d{4}$/.test(2024)` holds for the number too: `new Date("2024")`.
        return Some(iso(Utc
            .with_ymd_and_hms(value as i32, 1, 1, 0, 0, 0)
            .single()?));
    }
    let ms = if value.abs() >= 1e16 {
        (value / 1e6).floor()
    } else if value.abs() >= 1e14 {
        (value / 1e3).floor()
    } else if value.is_nan() || value < 1e11 {
        value * 1000.0
    } else {
        value
    };
    if !ms.is_finite() || ms.abs() > MAX_MS {
        return None;
    }
    Some(iso(DateTime::<Utc>::from_timestamp_millis(
        ms.trunc() as i64
    )?))
}

/// `Date#toISOString`: six-digit signed years outside 0..=9999.
fn iso(instant: DateTime<Utc>) -> String {
    let year = instant.year();
    let rest = instant.format("-%m-%dT%H:%M:%S%.3fZ");
    if (0..=9999).contains(&year) {
        format!("{year:04}{rest}")
    } else if year < 0 {
        format!("-{:06}{rest}", -year)
    } else {
        format!("+{year:06}{rest}")
    }
}

/// isostring 0.0.1, then `new Date(value)`: a date alone is UTC, a date-time without an offset is
/// local.
static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.([0-9]{1,6}))?(Z|([+-])([0-9]{2}):([0-9]{2}))?)?$")
        .expect("static pattern")
});

fn iso_string<Tz: TimeZone>(value: &str, now: &DateTime<Tz>) -> Option<String> {
    let caps = ISO.captures(value)?;
    let num = |i: usize| caps.get(i).map(|m| m.as_str().parse::<u32>().unwrap_or(0));
    let date = rolled_date(num(1)? as i32, num(2)?, num(3)?)?;
    let Some(hour) = num(4) else {
        return Some(iso(Utc.from_utc_datetime(&date.and_time(NaiveTime::MIN))));
    };
    let (minute, second) = (num(5)?, num(6).unwrap_or(0));
    let ms = caps.get(7).map_or(0, |m| {
        let digits = format!("{:0<3}", &m.as_str()[..m.as_str().len().min(3)]);
        digits.parse::<u32>().unwrap_or(0)
    });
    if minute > 59 || second > 59 || hour > 24 || (hour == 24 && (minute, second, ms) != (0, 0, 0))
    {
        return None;
    }
    let local = date.and_time(NaiveTime::MIN)
        + Duration::hours(i64::from(hour))
        + Duration::minutes(i64::from(minute))
        + Duration::seconds(i64::from(second))
        + Duration::milliseconds(i64::from(ms));
    let offset = match caps.get(8).map(|m| m.as_str()) {
        Some("Z") => Some(0),
        Some(_) => {
            let sign = if &caps[9] == "-" { -1 } else { 1 };
            Some(sign * (num(10)? as i32 * 60 + num(11)? as i32))
        }
        None => None,
    };
    resolve(local, offset, now).map(iso)
}

/// `new Date(y, m - 1, d)` accepts a day up to 31 in any month and rolls it over.
fn rolled_date(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_signed(Duration::days(i64::from(day) - 1))
}

/// A wall-clock time in a fixed offset (minutes east) or, without one, in `now`'s timezone.
fn resolve<Tz: TimeZone>(
    local: NaiveDateTime,
    offset_minutes: Option<i32>,
    now: &DateTime<Tz>,
) -> Option<DateTime<Utc>> {
    if let Some(minutes) = offset_minutes {
        let offset = FixedOffset::east_opt(minutes * 60)?;
        return offset
            .from_local_datetime(&local)
            .single()
            .map(|d| d.to_utc());
    }
    let tz = now.timezone();
    match tz.from_local_datetime(&local) {
        LocalResult::Single(d) => Some(d.to_utc()),
        LocalResult::Ambiguous(earlier, _) => Some(earlier.to_utc()),
        // A time in a spring-forward gap moves forward by the gap, as `Date` does.
        LocalResult::None => tz
            .from_local_datetime(&local.checked_add_signed(Duration::hours(1))?)
            .earliest()
            .map(|d| d.to_utc()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Option<String> {
        let now = Utc.with_ymd_and_hms(2025, 6, 15, 9, 0, 0).unwrap();
        date_text(text, &now)
    }

    // Expected values: `date(text)` of the helpers with TZ=UTC.
    #[test]
    fn dates_in_text() {
        assert_eq!(
            at("2024-03-04").as_deref(),
            Some("2024-03-04T00:00:00.000Z")
        );
        assert_eq!(
            at("2024-03-04T10:30").as_deref(),
            Some("2024-03-04T10:30:00.000Z")
        );
        assert_eq!(
            at("March 3, 2024").as_deref(),
            Some("2024-03-03T12:00:00.000Z")
        );
        assert_eq!(
            at("By Jane Doe on 3 March 2024").as_deref(),
            Some("2024-03-03T12:00:00.000Z")
        );
        assert_eq!(
            at("Jan 5, 2023 at 4:15 PM").as_deref(),
            Some("2023-01-05T16:15:00.000Z")
        );
        assert_eq!(at("2021").as_deref(), Some("2021-01-01T00:00:00.000Z"));
        assert_eq!(at("By Jane Doe"), None);
        assert_eq!(at("May Smith"), None);
    }

    /// chrono gives an Invalid Date past `Date`'s range, so the helpers give no date.
    #[test]
    fn ago_past_the_date_range_gives_no_date() {
        for text in [
            "300000 years ago",
            "9999999999999 days ago",
            "99999999999999999 seconds ago",
            "999999999999999 hours ago",
            "99999999999999 weeks ago",
            "99999999999999999 months ago",
            "9999999999999999999 minutes ago",
        ] {
            assert_eq!(at(text), None, "{text}");
        }
        assert_eq!(
            at("3 years ago").as_deref(),
            Some("2022-06-16T09:00:00.000Z")
        );
    }

    #[test]
    fn epoch_numbers() {
        assert_eq!(
            date_number(1_700_000_000.0).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(
            date_number(1_700_000_000_000.0).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
    }
}
