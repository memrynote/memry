//! The journal commands of Step 13m (`journal:getEntry`, `journal:createEntry`,
//! `journal:updateEntry`, `journal:deleteEntry`, the calendar's `getHeatmap`,
//! `getMonthEntries`, `getYearStats` and `getStreak`, the charts' `getPropertyRows` and the day
//! panel's `getDayContext` of `ipc/journal-handlers.ts`), each one call of
//! `memry_desktop::journal`. A create, an update and a delete send their journal event after
//! the write; a create and an update once the note index measured the day's file, so the
//! calendar's refetch on the event reads the saved counts (`shell::journal_events::measure`).

use std::sync::Arc;

use memry_desktop::journal::calendar::{
    self, HeatmapEntryView, MonthEntryView, MonthStatsView, StreakView,
};
use memry_desktop::journal::day_context::DayContextView;
use memry_desktop::journal::property_rows::PropertyRowsView;
use memry_desktop::journal::update::{DayUpdate, DayUpdated, InlineTags};
use memry_desktop::journal::write::NewDay;
use memry_desktop::journal::{self, JournalEntryView};
use memry_desktop::notes::error::NotesError;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::time::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::error::CommandError;
use super::folders::{Refused, settings_or_failed};
use super::{blocking, notes};
use crate::events::{
    JournalEntryCreatedEvent, JournalEntryDeletedEvent, JournalEntryUpdatedEvent, broadcast,
};
use crate::shell::journal_events;

/// `CreateEntryInputSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalCreateInput {
    pub date: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub properties: Option<Map<String, Value>>,
}

/// `UpdateEntryInputSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalUpdateInput {
    pub date: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub inline_tags: Option<JournalInlineTags>,
    #[serde(default)]
    pub properties: Option<Map<String, Value>>,
}

/// The `#tags` typed into or deleted from the body (`UpdateEntryInputSchema.inlineTags`).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct JournalInlineTags {
    #[serde(default)]
    pub add: Option<Vec<String>>,
    #[serde(default)]
    pub remove: Option<Vec<String>>,
}

/// `DeleteEntryOutputSchema`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct JournalDeleteOutput {
    pub success: bool,
}

fn failed(error: &NotesError) -> CommandError {
    CommandError::from_core(error)
}

/// A journal command that landed, for [`announce`].
pub enum Landed<'a> {
    /// A read; `found` when the day has an entry.
    Read {
        found: bool,
    },
    Created(&'a JournalEntryView),
    /// An update; one that made the day lands as a create.
    Saved(&'a DayUpdated),
    /// `success` when the day had an entry to delete.
    Deleted {
        date: String,
        success: bool,
    },
}

/// What Electron's handlers send once the command landed: `journal_opened` for a read that
/// found the entry, `journal:entryCreated` and `journal:entryUpdated` with the entry, and
/// `journal:entryDeleted` only when an entry was deleted. An update that made the day sends
/// only `journal:entryCreated`, as Electron's does. Public for `tests/journal.rs`: a lib unit
/// test that links the Tauri runtime cannot load on Windows (see `build.rs`).
pub fn announce<R: Runtime>(app: &AppHandle<R>, landed: Landed<'_>) {
    match landed {
        Landed::Read { found: true } => {
            if let Some(telemetry) = app.try_state::<Arc<Service>>() {
                let mut event = Service::event("journal_opened", "journal", "opened");
                event.object_type = Some("journal".to_owned());
                event.result = Some("success".to_owned());
                telemetry.track_main_event(event);
            }
        }
        Landed::Created(entry) => broadcast(
            app,
            JournalEntryCreatedEvent {
                date: entry.date.clone(),
                entry: entry.clone(),
                source: None,
            },
        ),
        Landed::Saved(DayUpdated {
            entry,
            created: true,
        }) => announce(app, Landed::Created(entry)),
        Landed::Saved(DayUpdated {
            entry,
            created: false,
        }) => broadcast(
            app,
            JournalEntryUpdatedEvent {
                date: entry.date.clone(),
                entry: entry.clone(),
                source: None,
            },
        ),
        Landed::Deleted {
            date,
            success: true,
        } => broadcast(app, JournalEntryDeletedEvent { date, source: None }),
        Landed::Read { found: false } | Landed::Deleted { success: false, .. } => {}
    }
}

/// The day's entry, `null` when it has no file. Browsing never makes a day.
#[tauri::command]
#[specta::specta]
pub async fn journal_get_entry<R: Runtime>(
    app: AppHandle<R>,
    date: String,
) -> Result<Option<JournalEntryView>, CommandError> {
    blocking("journal_get_entry", move || {
        let open = notes::open_vault(&app)?;
        let day = notes::service(&app)?
            .journal(&open)
            .map_err(|error| failed(&error))?;
        let entry = journal::entry(&open, &day, &date).map_err(|error| failed(&error))?;
        let found = entry.is_some();
        announce(&app, Landed::Read { found });
        Ok(entry)
    })
    .await
}

/// The day made on its first write; a day that has a file is answered as it is.
#[tauri::command]
#[specta::specta]
pub async fn journal_create_entry<R: Runtime>(
    app: AppHandle<R>,
    input: JournalCreateInput,
) -> Result<JournalEntryView, CommandError> {
    blocking("journal_create_entry", move || {
        let open = notes::open_vault(&app)?;
        let day = NewDay {
            date: input.date,
            content: input.content.unwrap_or_default(),
            tags: input.tags.unwrap_or_default(),
            properties: input.properties.unwrap_or_default(),
        };
        let entry = notes::service(&app)?
            .create_day(&open, day)
            .map_err(|error| settings_or_failed(&app, &error, Refused::JournalDay))?;
        journal_events::measure(&app, &entry.id, &entry.date);
        announce(&app, Landed::Created(&entry));
        Ok(entry)
    })
    .await
}

/// The day edited: its text, tags or properties; a day with no file is made.
#[tauri::command]
#[specta::specta]
pub async fn journal_update_entry<R: Runtime>(
    app: AppHandle<R>,
    input: JournalUpdateInput,
) -> Result<JournalEntryView, CommandError> {
    blocking("journal_update_entry", move || {
        let open = notes::open_vault(&app)?;
        // A tags-only update writes the record alone: the file, and so its counts, stay.
        let rewrites_file = input.content.is_some() || input.properties.is_some();
        let update = DayUpdate {
            date: input.date,
            content: input.content,
            tags: input.tags,
            inline_tags: input.inline_tags.map(|tags| InlineTags {
                add: tags.add.unwrap_or_default(),
                remove: tags.remove.unwrap_or_default(),
            }),
            properties: input.properties,
        };
        let updated = notes::service(&app)?
            .update_day(&open, update)
            .map_err(|error| settings_or_failed(&app, &error, Refused::JournalDay))?;
        if rewrites_file || updated.created {
            journal_events::measure(&app, &updated.entry.id, &updated.entry.date);
        }
        announce(&app, Landed::Saved(&updated));
        Ok(updated.entry)
    })
    .await
}

/// `success` is whether the day had an entry to delete.
#[tauri::command]
#[specta::specta]
pub async fn journal_delete_entry<R: Runtime>(
    app: AppHandle<R>,
    date: String,
) -> Result<JournalDeleteOutput, CommandError> {
    blocking("journal_delete_entry", move || {
        let open = notes::open_vault(&app)?;
        let success = notes::service(&app)?
            .delete_day(&open, &date)
            .map_err(|error| failed(&error))?;
        announce(&app, Landed::Deleted { date, success });
        Ok(JournalDeleteOutput { success })
    })
    .await
}

/// The live days of the year the calendar shows (`journal:getHeatmap`), oldest first.
#[tauri::command]
#[specta::specta]
pub async fn journal_get_heatmap<R: Runtime>(
    app: AppHandle<R>,
    year: u32,
) -> Result<Vec<HeatmapEntryView>, CommandError> {
    blocking("journal_get_heatmap", move || {
        let open = notes::open_vault(&app)?;
        let journal = notes::service(&app)?
            .journal(&open)
            .map_err(|error| failed(&error))?;
        calendar::heatmap(&open, &journal, year).map_err(|error| failed(&error))
    })
    .await
}

/// The live days of a month (1-12) with their previews (`journal:getMonthEntries`), newest
/// first.
#[tauri::command]
#[specta::specta]
pub async fn journal_get_month_entries<R: Runtime>(
    app: AppHandle<R>,
    year: u32,
    month: u32,
) -> Result<Vec<MonthEntryView>, CommandError> {
    blocking("journal_get_month_entries", move || {
        let open = notes::open_vault(&app)?;
        let journal = notes::service(&app)?
            .journal(&open)
            .map_err(|error| failed(&error))?;
        calendar::month_entries(&open, &journal, year, month).map_err(|error| failed(&error))
    })
    .await
}

/// One row per month of the year that has a live day (`journal:getYearStats`).
#[tauri::command]
#[specta::specta]
pub async fn journal_get_year_stats<R: Runtime>(
    app: AppHandle<R>,
    year: u32,
) -> Result<Vec<MonthStatsView>, CommandError> {
    blocking("journal_get_year_stats", move || {
        let open = notes::open_vault(&app)?;
        let journal = notes::service(&app)?
            .journal(&open)
            .map_err(|error| failed(&error))?;
        calendar::year_stats(&open, &journal, year).map_err(|error| failed(&error))
    })
    .await
}

/// The current and longest runs of live days (`journal:getStreak`).
#[tauri::command]
#[specta::specta]
pub async fn journal_get_streak<R: Runtime>(app: AppHandle<R>) -> Result<StreakView, CommandError> {
    blocking("journal_get_streak", move || {
        let open = notes::open_vault(&app)?;
        let journal = notes::service(&app)?
            .journal(&open)
            .map_err(|error| failed(&error))?;
        calendar::streak(&journal, now_ms()).map_err(|error| failed(&error))
    })
    .await
}

/// The live days in `from..=to` with their property values, and every property in use
/// (`journal:getPropertyRows`).
#[tauri::command]
#[specta::specta]
pub async fn journal_get_property_rows<R: Runtime>(
    app: AppHandle<R>,
    from: String,
    to: String,
) -> Result<PropertyRowsView, CommandError> {
    blocking("journal_get_property_rows", move || {
        notes::service(&app)?
            .journal_property_rows(&notes::open_vault(&app)?, &from, &to)
            .map_err(|error| failed(&error))
    })
    .await
}

/// The tasks due on `date` and the count overdue before it (`journal:getDayContext`).
#[tauri::command]
#[specta::specta]
pub async fn journal_get_day_context<R: Runtime>(
    app: AppHandle<R>,
    date: String,
) -> Result<DayContextView, CommandError> {
    blocking("journal_get_day_context", move || {
        notes::service(&app)?
            .journal_day_context(&notes::open_vault(&app)?, &date)
            .map_err(|error| failed(&error))
    })
    .await
}
