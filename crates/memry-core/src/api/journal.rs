//! `Journal`: one calendar day per entry, read and written by date (spec
//! 005-journal JP027).
//!
//! Every method takes the shell's **local calendar date** as `YYYY-MM-DD`
//! (D3): the core never derives a day from an instant. A day is created or
//! revived by its first write, never by a read (D2), and an existing record id
//! always beats `j<date>` (D5). The body is a CRDT document read through
//! [`crate::api::notes::Notes::blocks`] with the day's record id, and written
//! through [`Journal::edit_day`].
//!
//! Every method blocks (spec-defect 90); the shell runs them on its serial
//! core queue.

use std::sync::Arc;

use serde_json::Value;

use crate::api::errors::{AuthError, PropertyWriteError, StorageError};
use crate::api::journal_records::{
    JournalDayRecord, JournalEditResult, JournalHeatmapEntry, JournalMonthRecord, JournalReminder,
    JournalSettingsRecord, JournalStreakRecord, JournalTemplateStrings, JournalYearRecord,
};
use crate::crdt::body_edit::BlockEdit;
use crate::crdt::errors::CrdtError;
use crate::crypto::keys;
use crate::domain::calendar::LocalDateTime;
use crate::domain::journal;
use crate::domain::journal_ops::{body, metadata, reads, seed, settings};
use crate::domain::journal_rules::{self, JournalTemplateFormatted};
use crate::domain::note_meta::{self, WikiTargetMatch};
use crate::domain::note_tasks;
use crate::domain::reminders::{self, ReminderUpdate};
use crate::domain::tasks;
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;

pub use crate::domain::journal_ops::seed::SeedOutcome;

/// The journal surface over one opened vault.
#[derive(uniffi::Object)]
pub struct Journal {
    db: Db,
    device_id: String,
}

impl Journal {
    /// Built by [`crate::api::vault::Vault::journal`]. A write ticks this
    /// device's clock, so the identity is derived here, as `NotesWriter` does.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret
            .get(32..64)
            .ok_or(AuthError::MalformedToken {
                what: "device signing key is not 64 bytes".to_string(),
            })?
            .to_vec();
        Ok(Self {
            db,
            device_id: keys::local_device_id_hex(&public)?,
        })
    }
}

#[uniffi::export]
impl Journal {
    // MARK: - Reads (never write)

    /// The live entry for `date`, or `nil` when the day has none.
    pub fn day(&self, date: String) -> Result<Option<JournalDayRecord>, CrdtError> {
        self.db
            .call_blocking(move |conn| Ok(reads::day(conn, &date)))
            .map_err(CrdtError::from)?
            .map(|day| day.map(Into::into))
    }

    /// The record id the day's entry has, or `nil` when it has no live one.
    pub fn entry_id(&self, date: String) -> Result<Option<String>, StorageError> {
        self.db
            .call_blocking(move |conn| journal::live_entry(conn, &date))
    }

    /// Every day of a month (1-12), newest first, flagged against `today`.
    pub fn month(
        &self,
        year: i64,
        month: u32,
        today: String,
    ) -> Result<JournalMonthRecord, CrdtError> {
        self.db
            .call_blocking(move |conn| Ok(reads::month(conn, year, month, &today)))
            .map_err(CrdtError::from)?
            .map(Into::into)
    }

    /// Twelve month cards, totals and the streak.
    pub fn year(&self, year: i64, today: String) -> Result<JournalYearRecord, CrdtError> {
        self.db
            .call_blocking(move |conn| Ok(reads::year(conn, year, &today)))
            .map_err(CrdtError::from)?
            .map(Into::into)
    }

    /// Every live day of `year`, oldest first, with its activity level.
    pub fn heatmap(&self, year: i64) -> Result<Vec<JournalHeatmapEntry>, CrdtError> {
        self.db
            .call_blocking(move |conn| Ok(reads::heatmap(conn, year)))
            .map_err(CrdtError::from)?
            .map(|days| days.into_iter().map(Into::into).collect())
    }

    /// Current and longest streak counted from the shell's local today (D3).
    pub fn streak(&self, today: String) -> Result<JournalStreakRecord, StorageError> {
        self.db
            .call_blocking(move |conn| reads::streak(conn, &today))
            .map(Into::into)
    }

    /// Dates in `from..=to` that have a live entry, oldest first.
    pub fn days_with_entries(&self, from: String, to: String) -> Result<Vec<String>, StorageError> {
        self.db
            .call_blocking(move |conn| reads::days_with_entries(conn, &from, &to))
    }

    /// What a `[[wiki link]]` points at: a note by title or alias first, then
    /// a journal day by its date (desktop titles a day with its date), then the
    /// `j<date>` form. `nil` is a broken link.
    pub fn resolve_wiki_target(
        &self,
        target: String,
    ) -> Result<Option<WikiTargetMatch>, StorageError> {
        self.db
            .call_blocking(move |conn| note_meta::resolve_wiki_target_kind(conn, &target))
    }

    // MARK: - Body

    /// Applies one block edit to the day's body. Creates or revives the day
    /// when it has no live entry, in the same transaction (D2). An edit that
    /// fails or authors nothing creates nothing.
    ///
    /// A task line's checkbox flipped in the day completes or reopens the
    /// task, as a note's does (FR-058).
    pub fn edit_day(&self, date: String, edit: BlockEdit) -> Result<JournalEditResult, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                let flip = journal::live_entry(conn, &date)
                    .ok()
                    .flatten()
                    .and_then(|id| note_tasks::detect_checkbox_flip(conn, &id, &edit).ok())
                    .flatten();
                let now = now_ms();
                let outcome = body::edit_day(conn, &date, &edit, &device_id, now);
                if let (Ok(done), Some(flip)) = (&outcome, flip)
                    && done.changed
                    && let Ok(before) = crate::api::tasks_write::source_notes(conn)
                {
                    let write = if flip.checked {
                        tasks::complete(
                            conn,
                            &flip.task_id,
                            LocalDateTime::from_ms(now),
                            &device_id,
                            now,
                        )
                        .map(|completion| completion.write)
                    } else {
                        tasks::uncomplete(conn, &flip.task_id, &device_id, now)
                    };
                    if let Ok(write) = write {
                        crate::api::tasks_write::after(conn, &write, &before, &device_id, now);
                    }
                }
                Ok(outcome.map(Into::into))
            })
            .map_err(CrdtError::from)?
    }

    // MARK: - Tags and properties (D5: `content: null` on update)

    /// Replaces the day's tags, creating the day when absent and the list is
    /// not empty.
    pub fn set_tags(&self, date: String, tags: Vec<String>) -> Result<Vec<String>, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| metadata::set_tags(conn, &date, &tags, &device_id, now_ms()))
    }

    /// Sets one property from JSON text. `date` is reserved and refused.
    pub fn set_property(
        &self,
        date: String,
        name: String,
        value_json: String,
    ) -> Result<(), PropertyWriteError> {
        let device_id = self.device_id.clone();
        let value: Value =
            serde_json::from_str(&value_json).map_err(|error| StorageError::Invalid {
                what: format!("that property value is not JSON: {error}"),
            })?;
        self.db
            .call_blocking(move |conn| {
                Ok(metadata::set_property(
                    conn,
                    &date,
                    &name,
                    value,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(PropertyWriteError::from)?
            .map(|_| ())
            .map_err(PropertyWriteError::from)
    }

    /// Clears one property, leaving the key present and `null` (§13.4).
    pub fn clear_property(&self, date: String, name: String) -> Result<(), PropertyWriteError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                Ok(metadata::clear_property(
                    conn,
                    &date,
                    &name,
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(PropertyWriteError::from)?
            .map(|_| ())
            .map_err(PropertyWriteError::from)
    }

    /// Drops one property from the day.
    pub fn remove_property(&self, date: String, name: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            metadata::remove_property(conn, &date, &name, &device_id, now_ms()).map(|_| ())
        })
    }

    /// Renames one property, keeping its value.
    pub fn rename_property(
        &self,
        date: String,
        from: String,
        to: String,
    ) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            metadata::rename_property(conn, &date, &from, &to, &device_id, now_ms()).map(|_| ())
        })
    }

    // MARK: - Templates (D2, D4, D10)

    /// The template id `date` resolves to: its weekday's, else the default,
    /// else `nil`.
    pub fn template_for(&self, date: String) -> Result<Option<String>, StorageError> {
        self.db
            .call_blocking(move |conn| seed::resolve_template_for(conn, &date))
    }

    /// Seeds an empty day from a template with the shell's locale strings.
    /// A day with a live entry is never seeded (`AlreadyExists`). A template
    /// not on this device yet throws `NotFound`; the shell retries later.
    pub fn seed_from_template(
        &self,
        date: String,
        template_id: String,
        strings: JournalTemplateStrings,
    ) -> Result<SeedOutcome, StorageError> {
        let device_id = self.device_id.clone();
        let formatted = JournalTemplateFormatted {
            long_date: strings.long_date,
            time: strings.time,
            day_of_week: strings.day_of_week,
        };
        self.db.call_blocking(move |conn| {
            seed::open_day_from_template(
                conn,
                &date,
                &template_id,
                &formatted,
                &device_id,
                now_ms(),
            )
        })
    }

    // MARK: - Settings (D9)

    /// `journal.defaultTemplate` and the seven weekday templates.
    pub fn settings(&self) -> Result<JournalSettingsRecord, StorageError> {
        self.db
            .call_blocking(|conn| settings::journal_settings(conn))
            .map(Into::into)
    }

    /// Sets or clears (explicit `null`) the default template.
    pub fn set_default_template(
        &self,
        template_id: Option<String>,
    ) -> Result<JournalSettingsRecord, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                settings::set_default_template(conn, template_id, &device_id, now_ms())
            })
            .map(Into::into)
    }

    /// Sets or clears the template of one absolute weekday (0 = Sunday).
    pub fn set_weekday_template(
        &self,
        weekday: u8,
        template_id: Option<String>,
    ) -> Result<JournalSettingsRecord, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                settings::set_weekday_template(conn, weekday, template_id, &device_id, now_ms())
            })
            .map(Into::into)
    }

    // MARK: - Reminders (D8)

    /// The day's reminders, every status, sorted by time.
    pub fn reminders(&self, date: String) -> Result<Vec<JournalReminder>, StorageError> {
        self.db
            .call_blocking(move |conn| reminders::journal::for_journal(conn, &date))
            .map(|list| list.into_iter().map(Into::into).collect())
    }

    /// Desktop's set-or-replace: moves the day's next active reminder to
    /// `remind_at` (with `note`), or creates one. Returns the reminder id.
    /// Never creates the day.
    pub fn set_reminder(
        &self,
        date: String,
        remind_at: String,
        note: Option<String>,
    ) -> Result<String, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::journal::set_or_replace_for_journal(
                conn,
                &date,
                &remind_at,
                note.as_deref(),
                &device_id,
                now_ms(),
            )
        })
    }

    /// Edits one reminder's time and note (`nil` clears the note).
    pub fn update_reminder(
        &self,
        id: String,
        remind_at: String,
        note: Option<String>,
    ) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::update(
                conn,
                &id,
                &ReminderUpdate {
                    remind_at: Some(&remind_at),
                    title: None,
                    note: Some(note.as_deref()),
                },
                &device_id,
                now_ms(),
            )
            .map(|durable| {
                durable.acknowledge();
            })
        })
    }

    pub fn snooze_reminder(&self, id: String, until: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::snooze(conn, &id, &until, &device_id, now_ms())?;
            Ok(())
        })
    }

    pub fn dismiss_reminder(&self, id: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::dismiss(conn, &id, &device_id, now_ms())?;
            Ok(())
        })
    }

    pub fn delete_reminder(&self, id: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::delete(conn, &id, &device_id, now_ms())?;
            Ok(())
        })
    }
}

/// The weekday of a calendar date, 0 = Sunday; `nil` for a date that does not
/// parse. The shell uses it to label a day and to bind weekday templates.
#[uniffi::export]
pub fn journal_weekday(date: String) -> Option<u8> {
    journal_rules::weekday_of(&date).map(|day| day as u8)
}

/// The one-line preview desktop shows for a body (`extractPreview`, 100).
#[uniffi::export]
pub fn journal_preview(text: String) -> String {
    journal_rules::extract_journal_preview(&text, journal_rules::JOURNAL_PREVIEW_LENGTH)
}

/// Desktop's word count (`countWords`).
#[uniffi::export]
pub fn journal_word_count(text: String) -> u64 {
    journal_rules::count_words(&text) as u64
}

/// Wall clock, in epoch milliseconds (data-model §A.6).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
