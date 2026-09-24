//! Local calendar arithmetic with JavaScript `Date` semantics (spec 004 D3-D5).
//!
//! The task parser, the recurrence rules and the view predicates are pinned by
//! vectors generated from desktop TypeScript, which does its date math on the
//! process's **local calendar** through `Date` getters and setters. This module
//! is that calendar with no time zone at all: a [`CivilDate`] is the triple a
//! local `Date` reports, and a [`LocalDateTime`] adds the wall-clock time. The
//! caller supplies "now" as a local wall-clock value; nothing here reads a
//! clock or knows an offset.
//!
//! The setters roll over exactly as `Date` does, because the vectors pin the
//! rollover: `new Date(2026, 1, 31)` is March 3, `setMonth` on January 31 lands
//! in March, and `setFullYear` on February 29 lands on March 1.

use std::cmp::Ordering;
use std::fmt;

/// Milliseconds in one calendar day (no DST: a civil day is always 24 hours).
pub const MS_PER_DAY: i64 = 86_400_000;

/// A local calendar date: what `getFullYear`/`getMonth() + 1`/`getDate` return.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CivilDate {
    pub year: i64,
    /// 1..=12.
    pub month: u32,
    /// 1..=31, always valid for `month`.
    pub day: u32,
}

impl CivilDate {
    /// A date that is already valid. `None` for an impossible triple.
    pub fn new(year: i64, month: u32, day: u32) -> Option<Self> {
        let valid = (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month);
        valid.then_some(Self { year, month, day })
    }

    /// `new Date(year, month0, day)`: a zero-based month and a day that may
    /// overflow or underflow in either direction, rolled into a real date.
    pub fn from_js_parts(year: i64, month0: i64, day: i64) -> Self {
        let total_months = year * 12 + month0;
        let year = total_months.div_euclid(12);
        let month = u32::try_from(total_months.rem_euclid(12) + 1).unwrap_or(1);
        let first = Self {
            year,
            month,
            day: 1,
        };
        first.add_days(day - 1)
    }

    /// Days since 1970-01-01 (proleptic Gregorian).
    pub fn days_since_epoch(self) -> i64 {
        // Howard Hinnant's `days_from_civil`.
        let month = i64::from(self.month);
        let day = i64::from(self.day);
        let year = if month <= 2 { self.year - 1 } else { self.year };
        let era = year.div_euclid(400);
        let yoe = year - era * 400;
        let mp = (month + 9) % 12;
        let doy = (153 * mp + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    /// The inverse of [`Self::days_since_epoch`].
    pub fn from_days_since_epoch(days: i64) -> Self {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        Self {
            year,
            month: u32::try_from(month).unwrap_or(1),
            day: u32::try_from(day).unwrap_or(1),
        }
    }

    /// `getDay()`: 0 = Sunday .. 6 = Saturday.
    pub fn weekday(self) -> u32 {
        // 1970-01-01 was a Thursday (4).
        u32::try_from((self.days_since_epoch() + 4).rem_euclid(7)).unwrap_or(0)
    }

    /// `setDate(getDate() + days)`.
    pub fn add_days(self, days: i64) -> Self {
        Self::from_days_since_epoch(self.days_since_epoch() + days)
    }

    /// `setMonth(getMonth() + months)`: the day is kept and overflows forward.
    pub fn add_months(self, months: i64) -> Self {
        Self::from_js_parts(
            self.year,
            i64::from(self.month) - 1 + months,
            i64::from(self.day),
        )
    }

    /// `setFullYear(getFullYear() + years)`: February 29 rolls to March 1.
    pub fn add_years(self, years: i64) -> Self {
        Self::from_js_parts(
            self.year + years,
            i64::from(self.month) - 1,
            i64::from(self.day),
        )
    }

    /// The last day of this date's month.
    pub fn end_of_month(self) -> Self {
        Self {
            day: days_in_month(self.year, self.month),
            ..self
        }
    }

    /// `startOfWeek(date, weekStartsOn)`.
    pub fn start_of_week(self, week_starts_on: u32) -> Self {
        // A week start arrives from the shell unchecked; 0..=6 is its range.
        let week_starts_on = week_starts_on % 7;
        let day = self.weekday();
        let diff = if day < week_starts_on { 7 } else { 0 } + day - week_starts_on;
        self.add_days(-i64::from(diff))
    }

    /// `endOfWeek(date, weekStartsOn)`: the week's last day, as a date.
    pub fn end_of_week(self, week_starts_on: u32) -> Self {
        self.start_of_week(week_starts_on).add_days(6)
    }

    /// The instant this date starts at, as local milliseconds.
    pub fn start_ms(self) -> i64 {
        self.days_since_epoch() * MS_PER_DAY
    }

    /// `endOfDay`: 23:59:59.999, as local milliseconds.
    pub fn end_ms(self) -> i64 {
        self.start_ms() + MS_PER_DAY - 1
    }

    /// `formatDateKey`: `YYYY-MM-DD`, the year zero-padded to four digits.
    pub fn key(self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    /// Reads a `YYYY-MM-DD` key strictly. `None` for anything else.
    pub fn parse_key(key: &str) -> Option<Self> {
        let bytes = key.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let year = digits(&key[0..4])?;
        let month = digits(&key[5..7])?;
        let day = digits(&key[8..10])?;
        Self::new(i64::from(year), month, day)
    }
}

impl PartialOrd for CivilDate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for CivilDate {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.year, self.month, self.day).cmp(&(other.year, other.month, other.day))
    }
}

impl fmt::Display for CivilDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.key())
    }
}

/// A local wall-clock instant: a date plus the time of day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LocalDateTime {
    /// Milliseconds since 1970-01-01T00:00:00 **local** (no offset exists).
    ms: i64,
}

impl LocalDateTime {
    pub fn from_ms(ms: i64) -> Self {
        Self { ms }
    }

    pub fn at_start_of(date: CivilDate) -> Self {
        Self {
            ms: date.start_ms(),
        }
    }

    pub fn new(date: CivilDate, hour: u32, minute: u32, second: u32, millis: u32) -> Self {
        let time = ((i64::from(hour) * 60 + i64::from(minute)) * 60 + i64::from(second)) * 1000
            + i64::from(millis);
        Self {
            ms: date.start_ms() + time,
        }
    }

    pub fn ms(self) -> i64 {
        self.ms
    }

    /// `startOfDay`.
    pub fn date(self) -> CivilDate {
        CivilDate::from_days_since_epoch(self.ms.div_euclid(MS_PER_DAY))
    }

    /// Milliseconds since local midnight.
    pub fn time_of_day_ms(self) -> i64 {
        self.ms.rem_euclid(MS_PER_DAY)
    }

    /// Reads `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `YYYY-MM-DDTHH:MM:SS` or
    /// `YYYY-MM-DDTHH:MM:SS.sss`, optionally with a trailing `Z` (which, with
    /// no offset in this model, reads as the same wall clock).
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.strip_suffix('Z').unwrap_or(text);
        let date = CivilDate::parse_key(text.get(0..10)?)?;
        let rest = &text[10..];
        if rest.is_empty() {
            return Some(Self::at_start_of(date));
        }
        let rest = rest.strip_prefix('T')?;
        let (clock, millis) = match rest.split_once('.') {
            Some((clock, fraction)) => {
                let millis = fraction.get(0..3.min(fraction.len()))?;
                let scale = match millis.len() {
                    1 => 100,
                    2 => 10,
                    _ => 1,
                };
                (clock, digits(millis)? * scale)
            }
            None => (rest, 0),
        };
        let mut parts = clock.split(':');
        let hour = digits(parts.next()?)?;
        let minute = digits(parts.next()?)?;
        let second = match parts.next() {
            Some(second) => digits(second)?,
            None => 0,
        };
        if parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        Some(Self::new(date, hour, minute, second, millis))
    }

    /// `YYYY-MM-DDTHH:MM:SS`.
    pub fn format(self) -> String {
        let secs = self.time_of_day_ms() / 1000;
        format!(
            "{}T{:02}:{:02}:{:02}",
            self.date().key(),
            secs / 3600,
            (secs / 60) % 60,
            secs % 60
        )
    }
}

/// Whether `year` is a Gregorian leap year.
pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Days in `month` (1..=12) of `year`.
pub fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// An ASCII-digits-only field. `None` for an empty or non-digit field.
fn digits(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(key: &str) -> CivilDate {
        CivilDate::parse_key(key).expect("valid key")
    }

    #[test]
    fn javascript_rollover_is_reproduced() {
        assert_eq!(CivilDate::from_js_parts(2026, 1, 31), d("2026-03-03"));
        assert_eq!(CivilDate::from_js_parts(2026, 12, 1), d("2027-01-01"));
        assert_eq!(CivilDate::from_js_parts(2026, 0, 0), d("2025-12-31"));
        assert_eq!(d("2026-01-31").add_months(1), d("2026-03-03"));
        assert_eq!(d("2024-02-29").add_years(1), d("2025-03-01"));
        assert_eq!(d("2026-01-14").add_months(-2), d("2025-11-14"));
    }

    #[test]
    fn epoch_days_round_trip_and_weekdays_are_right() {
        for key in [
            "1970-01-01",
            "2000-02-29",
            "2026-01-14",
            "1600-03-01",
            "9999-12-31",
        ] {
            let date = d(key);
            assert_eq!(
                CivilDate::from_days_since_epoch(date.days_since_epoch()),
                date
            );
        }
        assert_eq!(d("2026-01-14").weekday(), 3);
        assert_eq!(d("2026-01-18").weekday(), 0);
        assert_eq!(d("1970-01-01").weekday(), 4);
    }

    #[test]
    fn week_bounds_follow_the_week_start() {
        let sunday = d("2026-01-18");
        assert_eq!(sunday.end_of_week(0), d("2026-01-24"));
        assert_eq!(sunday.end_of_week(1), d("2026-01-18"));
        assert_eq!(sunday.start_of_week(1), d("2026-01-12"));
    }

    #[test]
    fn instants_parse_and_format() {
        let at = LocalDateTime::parse("2026-01-14T12:00:00").expect("parses");
        assert_eq!(at.date(), d("2026-01-14"));
        assert_eq!(at.format(), "2026-01-14T12:00:00");
        let z = LocalDateTime::parse("2026-01-14T09:00:00.000Z").expect("parses");
        assert_eq!(z.time_of_day_ms(), 9 * 3_600_000);
        assert!(LocalDateTime::parse("2026-01-14T24:00:00").is_none());
        assert!(CivilDate::parse_key("2026-02-30").is_none());
    }
}
