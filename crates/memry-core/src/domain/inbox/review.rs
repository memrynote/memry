//! The daily review reminder (parity row inv04#46): Electron's
//! `decideReviewNotification`, `parseTargetMinutes` and `runReviewTick`
//! (`apps/desktop/src/main/inbox/review-scheduler.ts:38-133`).
//!
//! The shell owns the clock and the notification. The core owns the decision
//! and its once-per-local-day guard, `inbox.reviewLastNotifiedDate`: a
//! device-local key, stored as Electron's `setSetting` stores it (the bare
//! `YYYY-MM-DD` text) in `local_settings`.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// `INBOX_REVIEW_LAST_NOTIFIED_KEY`.
pub const LAST_NOTIFIED_KEY: &str = "inbox.reviewLastNotifiedDate";
/// Desktop's default review time.
pub const DEFAULT_TIME: &str = "18:00";

/// `parseTargetMinutes`: `HH:MM` on a 24-hour clock
/// (`REVIEW_REMINDER_TIME_PATTERN`, `^([01]\d|2[0-3]):([0-5]\d)$`) as minutes
/// of the day.
pub fn parse_target_minutes(target: &str) -> Option<u32> {
    let bytes = target.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let digits = [bytes[0], bytes[1], bytes[3], bytes[4]];
    if !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let [h1, h2, m1, m2] = digits.map(|b| u32::from(b - b'0'));
    let (hours, minutes) = (h1 * 10 + h2, m1 * 10 + m2);
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

/// The review settings (`inbox.reviewReminderEnabled`,
/// `inbox.reviewReminderTime`), at desktop's defaults (off, `18:00`) when no
/// device set them or the stored time is malformed.
pub fn settings(conn: &Connection) -> Result<(bool, String), StorageError> {
    let enabled = crate::domain::settings::read(conn, "inbox.reviewReminderEnabled")?
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let time = crate::domain::settings::read(conn, "inbox.reviewReminderTime")?
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|t| parse_target_minutes(t).is_some())
        .unwrap_or_else(|| DEFAULT_TIME.to_owned());
    Ok((enabled, time))
}

/// `ReviewDecisionInput`, with the local wall clock split by the shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision<'a> {
    pub enabled: bool,
    pub target: &'a str,
    /// The local date, `YYYY-MM-DD`.
    pub today: &'a str,
    /// Minutes since local midnight.
    pub now_minutes: u32,
    pub last_notified: Option<&'a str>,
    pub inbox_count: i64,
}

/// `decideReviewNotification`: fire once per local day, at or after the
/// target time, when the reminder is on and something is reviewable.
pub fn decide(input: &Decision<'_>) -> bool {
    if !input.enabled || input.inbox_count <= 0 {
        return false;
    }
    let Some(target) = parse_target_minutes(input.target) else {
        return false;
    };
    input.last_notified != Some(input.today) && input.now_minutes >= target
}

fn last_notified(conn: &Connection) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT value FROM local_settings WHERE key = ?1",
        params![LAST_NOTIFIED_KEY],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

/// `runReviewTick` without the notification: `Some(count)` when the nudge is
/// due now. The guard is written **before** the answer, so a failed write
/// answers the error instead of a nudge that would fire again on every tick.
/// A disabled reminder reads nothing else.
pub fn due(
    conn: &Connection,
    today: &str,
    now_minutes: u32,
    now_ms: i64,
) -> Result<Option<i64>, StorageError> {
    let (enabled, target) = settings(conn)?;
    if !enabled {
        return Ok(None);
    }
    let inbox_count = super::reviewable_count(conn)?;
    let last = last_notified(conn)?;
    let fire = decide(&Decision {
        enabled,
        target: &target,
        today,
        now_minutes,
        last_notified: last.as_deref(),
        inbox_count,
    });
    if !fire {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO local_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![LAST_NOTIFIED_KEY, today, now_ms],
    )
    .map_err(failed)?;
    Ok(Some(inbox_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(now_minutes: u32, last: Option<&'a str>) -> Decision<'a> {
        Decision {
            enabled: true,
            target: "18:00",
            today: "2026-11-18",
            now_minutes,
            last_notified: last,
            inbox_count: 3,
        }
    }

    /// `review-scheduler.decide.test.ts`: the time gate, the day guard, the
    /// switch and the count.
    #[test]
    fn the_nudge_fires_once_a_day_after_the_target() {
        assert!(!decide(&input(17 * 60 + 59, None)));
        assert!(decide(&input(18 * 60, None)));
        assert!(decide(&input(23 * 60 + 59, Some("2026-11-17"))));
        assert!(!decide(&input(18 * 60, Some("2026-11-18"))));
        assert!(!decide(&Decision {
            enabled: false,
            ..input(18 * 60, None)
        }));
        assert!(!decide(&Decision {
            inbox_count: 0,
            ..input(18 * 60, None)
        }));
        assert!(!decide(&Decision {
            target: "25:00",
            ..input(18 * 60, None)
        }));
    }

    #[test]
    fn target_times_follow_desktops_pattern() {
        assert_eq!(parse_target_minutes("18:00"), Some(1080));
        assert_eq!(parse_target_minutes("09:05"), Some(545));
        assert_eq!(parse_target_minutes("00:00"), Some(0));
        assert_eq!(parse_target_minutes("23:59"), Some(1439));
        for bad in [
            "24:00", "9:00", "12:60", "1a:00", "12-00", "12:000", "+1:00",
        ] {
            assert_eq!(parse_target_minutes(bad), None, "{bad}");
        }
    }
}
