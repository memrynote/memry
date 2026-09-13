//! ISO-8601 UTC ↔ epoch milliseconds, for the projection columns only
//! (data-model §A.6).
//!
//! §A.6 splits timestamps in two. **Instants the core orders by** —
//! `created_at`, `modified_at`, `synced_at` — are INTEGER epoch milliseconds,
//! so ordering is an integer comparison with no collation surprises and no
//! parse per row. **Wire-shaped date and wall-clock values** — `due_date`,
//! `due_time`, `start_date`, `remind_at`, `completed_at`, `archived_at`, the
//! journal `date` — stay TEXT exactly as the payload carries them, because
//! converting a date-only value to an instant invents a timezone and breaks
//! "today" across a date boundary. Nothing here is ever applied to those.
//!
//! The last row of §A.6's table is what makes this safe: the wire value is
//! never read back from a projection column, it is read from the verbatim
//! `sync_items.payload`. So a timestamp this module cannot parse costs a
//! sort key, not data — the column goes NULL and the payload is untouched.
//!
//! A hand-rolled pair rather than a date crate: the only two shapes needed are
//! the one `Date.prototype.toISOString` emits and the one it accepts back, and
//! both are twelve lines of civil-calendar arithmetic (Howard Hinnant's
//! `days_from_civil`, which is exact for every year in range).

const MS_PER_DAY: i64 = 86_400_000;

/// Parses an ISO-8601 instant to epoch milliseconds, or `None`.
///
/// Accepts what the protocol actually carries: `YYYY-MM-DD`, optionally
/// followed by `T` (or a space) and `HH:MM[:SS[.fff…]]`, optionally followed by
/// `Z` or a `±HH:MM` / `±HHMM` offset. A missing zone is read as UTC, which is
/// what every writer in the protocol emits.
pub fn to_epoch_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_at_checked(10)?;
    let year: i64 = parse_digits(date.get(0..4)?)?;
    if date.as_bytes().get(4) != Some(&b'-') || date.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let month: i64 = parse_digits(date.get(5..7)?)?;
    let day: i64 = parse_digits(date.get(8..10)?)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut millis = days_from_civil(year, month, day).checked_mul(MS_PER_DAY)?;

    if rest.is_empty() {
        return Some(millis);
    }

    let separator = rest.as_bytes()[0];
    if separator != b'T' && separator != b't' && separator != b' ' {
        return None;
    }
    let mut clock = &rest[1..];

    // Peel the zone off the end before reading the clock, so the clock parser
    // never has to know it is there.
    let mut offset_ms = 0;
    if let Some(stripped) = clock.strip_suffix('Z').or_else(|| clock.strip_suffix('z')) {
        clock = stripped;
    } else if let Some(at) = clock.rfind(['+', '-']) {
        let (head, zone) = clock.split_at(at);
        offset_ms = parse_offset(zone)?;
        clock = head;
    }

    let mut parts = clock.split(':');
    let hour: i64 = parse_digits(parts.next()?)?;
    let minute: i64 = parse_digits(parts.next()?)?;
    let (second, fraction_ms) = match parts.next() {
        None => (0, 0),
        Some(seconds) => match seconds.split_once('.') {
            None => (parse_digits(seconds)?, 0),
            Some((whole, fraction)) => (parse_digits(whole)?, parse_fraction_ms(fraction)?),
        },
    };
    if parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    millis = millis.checked_add((hour * 3_600 + minute * 60 + second) * 1_000 + fraction_ms)?;
    millis.checked_sub(offset_ms)
}

/// Formats epoch milliseconds the way `Date.prototype.toISOString` does:
/// always UTC, always exactly three fractional digits.
///
/// `None` outside years 0000 to 9999, where `toISOString` switches to its
/// expanded `±YYYYYY` form. Nothing in the protocol carries such a value, and
/// inventing the short form for one would write a string no reader accepts.
pub fn to_iso8601(millis: i64) -> Option<String> {
    let days = millis.div_euclid(MS_PER_DAY);
    let mut rest = millis.rem_euclid(MS_PER_DAY);

    let (year, month, day) = civil_from_days(days);
    if !(0..=9_999).contains(&year) {
        return None;
    }

    let ms = rest % 1_000;
    rest /= 1_000;
    let second = rest % 60;
    rest /= 60;
    let minute = rest % 60;
    let hour = rest / 60;

    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z"
    ))
}

fn parse_digits(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `.5` is 500 ms and `.123456` is 123 ms: pad or truncate to milliseconds.
fn parse_fraction_ms(fraction: &str) -> Option<i64> {
    if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let mut millis = 0;
    for position in 0..3 {
        let digit = fraction
            .as_bytes()
            .get(position)
            .map_or(0, |b| i64::from(b - b'0'));
        millis = millis * 10 + digit;
    }
    Some(millis)
}

fn parse_offset(zone: &str) -> Option<i64> {
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let body = &zone[1..];
    let (hours, minutes) = match body.split_once(':') {
        Some((hours, minutes)) => (hours, minutes),
        None if body.len() == 4 => body.split_at(2),
        None if body.len() == 2 => (body, "0"),
        None => return None,
    };
    let hours: i64 = parse_digits(hours)?;
    let minutes: i64 = parse_digits(minutes)?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(sign * (hours * 3_600 + minutes * 60) * 1_000)
}

/// Days since 1970-01-01 for a proleptic-Gregorian civil date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The exact inverse of [`days_from_civil`].
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_format_is_the_one_to_iso_string_emits() {
        assert_eq!(
            to_iso8601(1_760_000_000_000).as_deref(),
            Some("2025-10-09T08:53:20.000Z")
        );
        assert_eq!(to_iso8601(0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(to_iso8601(1).as_deref(), Some("1970-01-01T00:00:00.001Z"));
        // Before the epoch: floor division, not truncation toward zero.
        assert_eq!(to_iso8601(-1).as_deref(), Some("1969-12-31T23:59:59.999Z"));
    }

    #[test]
    fn parsing_is_the_inverse_of_formatting() {
        for millis in [0_i64, 1, -1, 1_760_000_000_000, -2_208_988_800_000] {
            let text = to_iso8601(millis).expect("in range");
            assert_eq!(to_epoch_ms(&text), Some(millis), "{text}");
        }
    }

    #[test]
    fn a_leap_day_survives_the_round_trip() {
        let millis = to_epoch_ms("2024-02-29T12:00:00.000Z").expect("a real date");
        assert_eq!(
            to_iso8601(millis).as_deref(),
            Some("2024-02-29T12:00:00.000Z")
        );
    }

    #[test]
    fn the_shapes_the_protocol_carries_all_parse() {
        assert_eq!(to_epoch_ms("1970-01-01"), Some(0));
        assert_eq!(to_epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(to_epoch_ms("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(to_epoch_ms("1970-01-01T00:00"), Some(0));
        assert_eq!(to_epoch_ms("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(to_epoch_ms("1969-12-31T23:00:00-01:00"), Some(0));
        assert_eq!(to_epoch_ms("1970-01-01T01:00:00+0100"), Some(0));
    }

    #[test]
    fn nonsense_is_none_rather_than_a_wrong_instant() {
        assert_eq!(to_epoch_ms(""), None);
        assert_eq!(to_epoch_ms("not a date"), None);
        assert_eq!(to_epoch_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(to_epoch_ms("2026-04-16X00:00:00Z"), None);
        assert_eq!(to_epoch_ms("2026-04-16T25:00:00Z"), None);
        // Outside the four-digit-year window `toISOString` covers.
        assert_eq!(to_iso8601(i64::MAX), None);
        assert_eq!(to_iso8601(i64::MIN), None);
    }
}
