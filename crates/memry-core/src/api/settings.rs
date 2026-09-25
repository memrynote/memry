//! `Settings`: the synced `settings` item for one opened vault (spec 006
//! ST10–ST12).
//!
//! A thin surface over [`crate::domain::settings`], which already carries the
//! two guarantees this object depends on: a write clones and mutates the raw
//! payload (a group this build does not model survives byte for byte), and a
//! write ticks only the dotted path it wrote. Values cross the FFI as JSON
//! text so `null` and absent stay distinct: `get` answers `None` for an absent
//! path and `Some("null")` for a cleared one.
//!
//! The journal and inbox helpers validate exactly as desktop does before they
//! write (`journal-template-keys.ts`, `REVIEW_REMINDER_TIME_PATTERN`), so this
//! device never publishes a value desktop's schema would reject.
//!
//! **Refresh after a pull** is [`Settings::revision`]: the settings row's
//! `updated_at`, which the inbound merge moves whenever it applies a change.
//! The shell compares it after each sync pass instead of the core pushing a
//! callback across the FFI.

use std::sync::Arc;

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value};

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::settings::{self, SETTINGS_ITEM_TYPE};
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;
use crate::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;

/// Desktop's `reviewReminderTime` default (`INBOX_SETTINGS_DEFAULTS`).
pub const DEFAULT_REVIEW_TIME: &str = "18:00";

/// The synced settings over one vault.
#[derive(uniffi::Object)]
pub struct Settings {
    db: Db,
    device_id: String,
}

/// `journal.defaultTemplate` and the seven `journal.weekdayTemplates` days.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalTemplateSettings {
    pub default_template: Option<String>,
    /// Exactly seven entries, index = JS `getDay()` (0 = Sunday). `None` is
    /// "use the default", whether cleared or never set.
    pub weekday_templates: Vec<Option<String>>,
}

/// `inbox.reviewReminderEnabled` and `inbox.reviewReminderTime`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ReviewReminderSettings {
    pub enabled: bool,
    /// 24h `HH:MM`.
    pub time: String,
}

impl Settings {
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let tasks = Tasks::over(db, store)?;
        Ok(Self {
            db: tasks.db,
            device_id: tasks.device_id,
        })
    }

    #[cfg(test)]
    fn for_test(db: Db, device_id: &str) -> Self {
        Self {
            db,
            device_id: device_id.to_owned(),
        }
    }
}

fn invalid(what: String) -> StorageError {
    StorageError::Invalid { what }
}

fn parse_json(path: &str, json: &str) -> Result<Value, StorageError> {
    serde_json::from_str(json).map_err(|error| invalid(format!("settings `{path}`: {error}")))
}

/// Desktop's `REVIEW_REMINDER_TIME_PATTERN`: `^([01]\d|2[0-3]):([0-5]\d)$`.
pub fn is_review_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let digit = |b: u8| b.is_ascii_digit();
    if !bytes.iter().enumerate().all(|(i, b)| i == 2 || digit(*b)) {
        return false;
    }
    let hour = (bytes[0] - b'0') * 10 + (bytes[1] - b'0');
    let minute = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
    hour <= 23 && minute <= 59
}

fn journal_from(all: &Map<String, Value>) -> JournalTemplateSettings {
    let journal = all.get("journal").and_then(Value::as_object);
    let default_template = journal
        .and_then(|j| j.get("defaultTemplate"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let days = journal
        .and_then(|j| j.get("weekdayTemplates"))
        .and_then(Value::as_object);
    let weekday_templates = (0..7)
        .map(|day| {
            days.and_then(|d| d.get(&day.to_string()))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    JournalTemplateSettings {
        default_template,
        weekday_templates,
    }
}

fn review_from(all: &Map<String, Value>) -> ReviewReminderSettings {
    let inbox = all.get("inbox").and_then(Value::as_object);
    ReviewReminderSettings {
        enabled: inbox
            .and_then(|i| i.get("reviewReminderEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        time: inbox
            .and_then(|i| i.get("reviewReminderTime"))
            .and_then(Value::as_str)
            .filter(|t| is_review_time(t))
            .unwrap_or(DEFAULT_REVIEW_TIME)
            .to_owned(),
    }
}

#[uniffi::export]
impl Settings {
    /// Every synced setting as one JSON object, including groups this build
    /// does not model.
    pub fn snapshot(&self) -> Result<String, StorageError> {
        self.db
            .call_blocking(|conn| Ok(Value::Object(settings::all(conn)?).to_string()))
    }

    /// One dotted path as JSON text; `None` when absent, `"null"` when cleared.
    pub fn get(&self, path: String) -> Result<Option<String>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(settings::read(conn, &path)?.map(|value| value.to_string()))
        })
    }

    /// Writes one leaf. `json` is any JSON value, `null` included.
    pub fn set(&self, path: String, json: String) -> Result<(), StorageError> {
        let value = parse_json(&path, &json)?;
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            settings::set(conn, &path, value, &device, now_ms())?;
            Ok(())
        })
    }

    /// Clears one leaf to an explicit `null` (§13.4).
    pub fn clear(&self, path: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            settings::clear(conn, &path, &device, now_ms())?;
            Ok(())
        })
    }

    /// The settings row's `updated_at`, or 0 when there is none. Moves on every
    /// local write and every applied inbound merge.
    pub fn revision(&self) -> Result<i64, StorageError> {
        self.db.call_blocking(|conn| {
            conn.query_row(
                "SELECT updated_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                params![SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.unwrap_or(0))
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
    }

    // ---- journal (ST11) ------------------------------------------------------

    pub fn journal_templates(&self) -> Result<JournalTemplateSettings, StorageError> {
        self.db
            .call_blocking(|conn| Ok(journal_from(&settings::all(conn)?)))
    }

    /// `None` clears to `null`, as desktop's `writeJournalSettings` does.
    pub fn set_default_template(
        &self,
        template_id: Option<String>,
    ) -> Result<JournalTemplateSettings, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let path = "journal.defaultTemplate";
            match template_id {
                Some(id) => settings::set(conn, path, Value::from(id), &device, now_ms())?,
                None => settings::clear(conn, path, &device, now_ms())?,
            };
            Ok(journal_from(&settings::all(conn)?))
        })
    }

    /// One day, its own clock (`journal.weekdayTemplates.<day>`). `day` must be
    /// 0–6 (`isWeekdayKey`); `None` writes the `null` desktop keeps for a
    /// cleared day.
    pub fn set_weekday_template(
        &self,
        day: u8,
        template_id: Option<String>,
    ) -> Result<JournalTemplateSettings, StorageError> {
        if day > 6 {
            return Err(invalid(format!("weekday `{day}` is not 0-6")));
        }
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let path = format!("journal.weekdayTemplates.{day}");
            let value = template_id.map(Value::from).unwrap_or(Value::Null);
            settings::set(conn, &path, value, &device, now_ms())?;
            Ok(journal_from(&settings::all(conn)?))
        })
    }

    // ---- inbox (ST12) --------------------------------------------------------

    pub fn review_reminder(&self) -> Result<ReviewReminderSettings, StorageError> {
        self.db
            .call_blocking(|conn| Ok(review_from(&settings::all(conn)?)))
    }

    /// Writes both fields (each only if it changed). Refuses a time that is
    /// not 24h `HH:MM`.
    pub fn set_review_reminder(
        &self,
        enabled: bool,
        time: String,
    ) -> Result<ReviewReminderSettings, StorageError> {
        if !is_review_time(&time) {
            return Err(invalid(format!("reviewReminderTime `{time}` is not HH:MM")));
        }
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let now = now_ms();
            settings::set(
                conn,
                "inbox.reviewReminderEnabled",
                Value::from(enabled),
                &device,
                now,
            )?;
            settings::set(
                conn,
                "inbox.reviewReminderTime",
                Value::from(time),
                &device,
                now,
            )?;
            Ok(review_from(&settings::all(conn)?))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::repositories::{InboundRecord, sync_items};
    use crate::storage::{open_data, test_support::temp_dir};
    use serde_json::json;

    const DESKTOP: &str = concat!(
        r#"{"settings":{"general":{"theme":"dark","minimizeToTray":true,"fontSizePx":15},"#,
        r#""sidebar":{"sectionOrder":["a","b"]},"experimental":{"x":1}},"#,
        r#""fieldClocks":{"general.theme":{"desk":1},"general.minimizeToTray":{"desk":1},"#,
        r#""sidebar.sectionOrder":{"desk":1},"experimental.x":{"desk":1}}}"#
    );

    fn open(label: &str, seed: Option<&str>) -> (Settings, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open");
        if let Some(seed) = seed {
            db.call_blocking(|conn| {
                sync_items::apply_remote(
                    conn,
                    &InboundRecord {
                        item_type: SETTINGS_ITEM_TYPE.to_owned(),
                        item_id: SETTINGS_ITEM_ID.to_owned(),
                        payload_json: seed.to_owned(),
                        server_cursor: Some(1),
                        signer_device_id: Some("desk".to_owned()),
                        updated_at: 1,
                        deleted_at: None,
                    },
                    1,
                )?;
                Ok(())
            })
            .expect("seed");
        }
        (Settings::for_test(db, "phone"), dir)
    }

    fn payload(s: &Settings) -> Value {
        s.db.call_blocking(|conn| {
            Ok(serde_json::from_str::<Value>(
                &sync_items::push_payload(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?
                    .expect("payload"),
            )
            .expect("json"))
        })
        .expect("payload")
    }

    #[test]
    fn a_theme_write_leaves_desktop_only_and_unknown_groups_byte_identical() {
        let (s, _d) = open("st10-preserve", Some(DESKTOP));
        s.set("general.theme".into(), r#""white""#.into())
            .expect("set");
        let p = payload(&s);
        assert_eq!(p["settings"]["general"]["theme"], json!("white"));
        assert_eq!(p["settings"]["general"]["minimizeToTray"], json!(true));
        assert_eq!(p["settings"]["general"]["fontSizePx"], json!(15));
        assert_eq!(p["settings"]["sidebar"], json!({"sectionOrder":["a","b"]}));
        assert_eq!(p["settings"]["experimental"], json!({"x":1}));
        assert_eq!(
            p["fieldClocks"]["general.minimizeToTray"],
            json!({"desk":1})
        );
        assert_eq!(
            p["fieldClocks"]["general.theme"],
            json!({"desk":1,"phone":1})
        );
    }

    #[test]
    fn null_and_absent_stay_distinct() {
        let (s, _d) = open("st10-null", Some(DESKTOP));
        assert_eq!(s.get("journal.defaultTemplate".into()).expect("get"), None);
        s.clear("journal.defaultTemplate".into()).expect("clear");
        assert_eq!(
            s.get("journal.defaultTemplate".into()).expect("get"),
            Some("null".into())
        );
        assert!(s.set("general.theme".into(), "not json".into()).is_err());
    }

    #[test]
    fn each_weekday_gets_its_own_clock_and_bad_days_are_refused() {
        let (s, _d) = open("st11-days", None);
        s.set_weekday_template(3, Some("tpl-wed".into()))
            .expect("wed");
        let got = s.set_weekday_template(1, None).expect("mon");
        assert_eq!(got.weekday_templates[3].as_deref(), Some("tpl-wed"));
        assert_eq!(got.weekday_templates[1], None);
        let p = payload(&s);
        assert_eq!(
            p["settings"]["journal"]["weekdayTemplates"]["1"],
            Value::Null
        );
        assert!(p["fieldClocks"].get("journal.weekdayTemplates.3").is_some());
        assert!(p["fieldClocks"].get("journal.weekdayTemplates").is_none());
        assert!(s.set_weekday_template(7, None).is_err());
    }

    #[test]
    fn concurrent_edits_to_different_days_both_survive_a_merge() {
        let (s, _d) = open("st11-merge", None);
        s.set_weekday_template(2, Some("mine".into())).expect("tue");
        let remote = concat!(
            r#"{"settings":{"journal":{"weekdayTemplates":{"5":"theirs"}}},"#,
            r#""fieldClocks":{"journal.weekdayTemplates.5":{"desk":1}}}"#
        );
        s.db.call_blocking(|conn| {
            crate::sync::settings_merge::apply_remote_merged(
                conn,
                &InboundRecord {
                    item_type: SETTINGS_ITEM_TYPE.to_owned(),
                    item_id: SETTINGS_ITEM_ID.to_owned(),
                    payload_json: remote.to_owned(),
                    server_cursor: Some(2),
                    signer_device_id: Some("desk".to_owned()),
                    updated_at: 2,
                    deleted_at: None,
                },
                2,
            )?;
            Ok(())
        })
        .expect("merge");
        let got = s.journal_templates().expect("read");
        assert_eq!(got.weekday_templates[2].as_deref(), Some("mine"));
        assert_eq!(got.weekday_templates[5].as_deref(), Some("theirs"));
    }

    #[test]
    fn review_time_is_validated_like_desktop() {
        assert!(is_review_time("06:30"));
        assert!(is_review_time("23:59"));
        for bad in ["6:30", "24:00", "12:60", "6pm", "12:3a", ""] {
            assert!(!is_review_time(bad), "{bad}");
        }
        let (s, _d) = open("st12", None);
        assert_eq!(
            s.review_reminder().expect("read"),
            ReviewReminderSettings {
                enabled: false,
                time: "18:00".into()
            }
        );
        assert!(s.set_review_reminder(true, "6pm".into()).is_err());
        let got = s.set_review_reminder(true, "07:15".into()).expect("set");
        assert_eq!(got.time, "07:15");
        assert!(got.enabled);
        assert!(s.revision().expect("rev") > 0);
    }
}
