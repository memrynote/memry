//! `Inbox` settings (spec 006 IB23): the daily review reminder, synced
//! through desktop's `inbox` settings group (§5 F11), and its tick.

use serde_json::json;

use crate::api::errors::StorageError;
use crate::api::inbox::Inbox;
use crate::domain::inbox::review;

/// The daily review reminder (spec 006 IB23, §5 F11): the synced
/// `inbox.reviewReminderEnabled` / `inbox.reviewReminderTime`, at desktop's
/// defaults (off, `18:00`) when no device has set them.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxReviewSettings {
    pub enabled: bool,
    /// 24h `HH:MM`, local wall clock.
    pub time: String,
}

/// `YYYY-MM-DD` with digits where they belong.
fn local_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

#[uniffi::export]
impl Inbox {
    pub fn review_settings(&self) -> Result<InboxReviewSettings, StorageError> {
        self.db.read_blocking(|conn| {
            let (enabled, time) = review::settings(conn)?;
            Ok(InboxReviewSettings { enabled, time })
        })
    }

    /// Writes both keys (each carries its own field clock, §6.9).
    pub fn set_review_settings(&self, settings: InboxReviewSettings) -> Result<(), StorageError> {
        if review::parse_target_minutes(&settings.time).is_none() {
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

    /// One review tick (`runReviewTick`) at the shell's local wall clock:
    /// `today` as `YYYY-MM-DD`, `now_minutes` since local midnight. Answers
    /// the reviewable count when the nudge is due, after recording today as
    /// notified, so the next tick today answers `None`.
    pub fn review_due(&self, today: String, now_minutes: u32) -> Result<Option<i64>, StorageError> {
        if !local_date(&today) || now_minutes >= 24 * 60 {
            return Err(StorageError::Invalid {
                what: "a review tick needs a local YYYY-MM-DD date and minutes of the day"
                    .to_owned(),
            });
        }
        self.write(move |conn, _device, now| review::due(conn, &today, now_minutes, now))
    }
}
