//! Journal template settings (spec 005-journal JP025, D9).
//!
//! Two synced settings ride the `journal` group of the settings item
//! (`packages/contracts/src/settings-sync.ts`, `SyncedSettingsSchema.journal`):
//! `defaultTemplate` and `weekdayTemplates`, a map keyed by JS `getDay()`
//! (`"0"` = Sunday … `"6"` = Saturday). Every day carries its own field clock
//! (`journal.weekdayTemplates.<day>`), so two devices editing two different
//! days both keep their edit.
//!
//! Writes go through [`settings::set`] / [`settings::clear`]: each ticks only
//! the leaf path it writes, commits with its outbox row, and carries every
//! other key through verbatim — `showStatsFooter`, `showSchedule`,
//! `showTasks`, `showAIConnections`, weekday keys outside `"0".."6"`, and any
//! group this build does not model. A clear writes an explicit `null`
//! (§13.4) so it beats a peer's older value. A write equal to the stored
//! value writes nothing.
//!
//! Reads follow desktop's readers: a weekday key outside `"0".."6"` is
//! ignored, and a value that is not a string reads as unset.

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::settings;

/// Days in a week; weekdays are `0..WEEKDAYS` with `0` = Sunday.
pub const WEEKDAYS: u8 = 7;

const DEFAULT_TEMPLATE_PATH: &str = "journal.defaultTemplate";
const WEEKDAY_TEMPLATES_PATH: &str = "journal.weekdayTemplates";

/// The journal template settings this device sees.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalTemplateSettingsView {
    /// The template for a day with no weekday template; `None` when unset or
    /// cleared.
    pub default_template: Option<String>,
    /// Indexed by JS `getDay()` (`0` = Sunday); `None` when unset or cleared.
    pub weekday_templates: [Option<String>; 7],
}

/// Reads `journal.defaultTemplate` and `journal.weekdayTemplates."0".."6"`.
///
/// A settings payload that will not parse is an error, as in
/// [`settings::all`], rather than a silent set of defaults.
pub fn journal_settings(conn: &Connection) -> Result<JournalTemplateSettingsView, StorageError> {
    let all = settings::all(conn)?;
    let journal = all.get("journal").and_then(Value::as_object);
    let string_at = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);

    let default_template = string_at(journal.and_then(|group| group.get("defaultTemplate")));
    let weekdays = journal
        .and_then(|group| group.get("weekdayTemplates"))
        .and_then(Value::as_object);
    let weekday_templates =
        std::array::from_fn(|day| string_at(weekdays.and_then(|map| map.get(&day.to_string()))));

    Ok(JournalTemplateSettingsView {
        default_template,
        weekday_templates,
    })
}

/// Sets `journal.defaultTemplate`; `None` writes an explicit `null`. Synced.
pub fn set_default_template(
    conn: &Connection,
    template_id: Option<String>,
    device_id: &str,
    now_ms: i64,
) -> Result<JournalTemplateSettingsView, StorageError> {
    write(conn, DEFAULT_TEMPLATE_PATH, template_id, device_id, now_ms)
}

/// Sets `journal.weekdayTemplates.<weekday>`; `None` writes an explicit
/// `null`. Refuses a weekday outside `0..=6`. Synced.
pub fn set_weekday_template(
    conn: &Connection,
    weekday: u8,
    template_id: Option<String>,
    device_id: &str,
    now_ms: i64,
) -> Result<JournalTemplateSettingsView, StorageError> {
    if weekday >= WEEKDAYS {
        return Err(StorageError::Invalid {
            what: format!("weekday {weekday} is outside 0..=6"),
        });
    }
    let path = format!("{WEEKDAY_TEMPLATES_PATH}.{weekday}");
    write(conn, &path, template_id, device_id, now_ms)
}

fn write(
    conn: &Connection,
    path: &str,
    template_id: Option<String>,
    device_id: &str,
    now_ms: i64,
) -> Result<JournalTemplateSettingsView, StorageError> {
    match template_id {
        Some(id) => settings::set(conn, path, Value::from(id), device_id, now_ms)?,
        None => settings::clear(conn, path, device_id, now_ms)?,
    };
    journal_settings(conn)
}
