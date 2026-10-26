//! ISO-8601 UTC timestamps (`Date.prototype.toISOString`) without a date crate.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::logging::localtime::{days_from_civil, utc};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso(ms: u64) -> String {
    let stamp = utc(std::time::Duration::from_millis(ms));
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        stamp.year, stamp.month, stamp.day, stamp.hour, stamp.minute, stamp.second, stamp.millis
    )
}

/// `Date.parse` of the format [`iso`] writes; `None` for anything else.
pub fn parse_iso(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() != 24
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[23] != b'Z'
    {
        return None;
    }
    let num = |a: usize, z: usize| text.get(a..z)?.parse::<u32>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s, ms) = (num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(y as i32, mo, d);
    u64::try_from(
        days * 86_400_000
            + i64::from(h) * 3_600_000
            + i64::from(mi) * 60_000
            + i64::from(s) * 1_000
            + i64::from(ms),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips_and_matches_js() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_760_000_000_123), "2025-10-09T08:53:20.123Z");
        assert_eq!(
            parse_iso("2025-10-09T08:53:20.123Z"),
            Some(1_760_000_000_123)
        );
        assert_eq!(parse_iso("nope"), None);
    }
}
