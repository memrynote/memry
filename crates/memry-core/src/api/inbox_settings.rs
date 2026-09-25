//! `Inbox` settings (spec 006 IB23): the daily review reminder, synced
//! through desktop's `inbox` settings group (§5 F11).

use serde_json::json;

use crate::api::errors::StorageError;
use crate::api::inbox::Inbox;

/// The daily review reminder (spec 006 IB23, §5 F11): the synced
/// `inbox.reviewReminderEnabled` / `inbox.reviewReminderTime`, at desktop's
/// defaults (off, `18:00`) when no device has set them.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxReviewSettings {
    pub enabled: bool,
    /// 24h `HH:MM`, local wall clock.
    pub time: String,
}

/// `REVIEW_REMINDER_TIME_PATTERN`: `^([01]\d|2[0-3]):([0-5]\d)$`.
fn valid_review_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && time[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && time[3..].parse::<u8>().is_ok_and(|m| m < 60)
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit())
}

#[uniffi::export]
impl Inbox {
    pub fn review_settings(&self) -> Result<InboxReviewSettings, StorageError> {
        self.db.call_blocking(|conn| {
            let enabled = crate::domain::settings::read(conn, "inbox.reviewReminderEnabled")?
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let time = crate::domain::settings::read(conn, "inbox.reviewReminderTime")?
                .and_then(|v| v.as_str().map(str::to_owned))
                .filter(|t| valid_review_time(t))
                .unwrap_or_else(|| "18:00".to_owned());
            Ok(InboxReviewSettings { enabled, time })
        })
    }

    /// Writes both keys (each carries its own field clock, §6.9).
    pub fn set_review_settings(&self, settings: InboxReviewSettings) -> Result<(), StorageError> {
        if !valid_review_time(&settings.time) {
            return Err(StorageError::Invalid {
                what: "a review time is HH:MM on a 24-hour clock".to_owned(),
            });
        }
        self.write(move |conn, device, now| {
            crate::domain::settings::set(
                conn,
                "inbox.reviewReminderEnabled",
                json!(settings.enabled),
                device,
                now,
            )?;
            crate::domain::settings::set(
                conn,
                "inbox.reviewReminderTime",
                json!(settings.time),
                device,
                now,
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::valid_review_time;

    #[test]
    fn review_times_follow_desktops_pattern() {
        assert!(valid_review_time("18:00"));
        assert!(valid_review_time("09:05"));
        assert!(!valid_review_time("24:00"));
        assert!(!valid_review_time("9:00"));
        assert!(!valid_review_time("12:60"));
    }
}
