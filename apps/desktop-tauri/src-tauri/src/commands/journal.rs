//! The journal commands of Step 13m (`journal:getEntry`, `journal:createEntry`,
//! `journal:updateEntry`, `journal:deleteEntry` of `ipc/journal-handlers.ts`), each one call of
//! `memry_desktop::journal`. A create, an update and a delete send their journal event after the
//! write.

use std::sync::Arc;

use memry_desktop::journal::update::{DayUpdate, InlineTags};
use memry_desktop::journal::write::NewDay;
use memry_desktop::journal::{self, JournalEntryView};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::telemetry::Service;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::CommandError;
use crate::events::{
    JournalEntryCreatedEvent, JournalEntryDeletedEvent, JournalEntryUpdatedEvent, broadcast,
};

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

fn service(app: &AppHandle<Wry>) -> Result<Arc<NotesService>, CommandError> {
    let service = app.try_state::<Arc<NotesService>>();
    service
        .map(|service| service.inner().clone())
        .ok_or_else(|| failed(&NotesError::Closed))
}

fn open_vault(app: &AppHandle<Wry>) -> Result<memry_desktop::session::OpenVault, CommandError> {
    app.state::<memry_desktop::session::Session>()
        .current()
        .ok_or_else(|| failed(&NotesError::Closed))
}

/// A journal command that landed, for [`announce`].
pub enum Landed<'a> {
    /// A read; `found` when the day has an entry.
    Read {
        found: bool,
    },
    Created(&'a JournalEntryView),
    Updated(&'a JournalEntryView),
    /// `success` when the day had an entry to delete.
    Deleted {
        date: String,
        success: bool,
    },
}

/// What Electron's handlers send once the command landed: `journal_opened` for a read that
/// found the entry, `journal:entryCreated` and `journal:entryUpdated` with the entry, and
/// `journal:entryDeleted` only when an entry was deleted. An update that made the day lands as
/// `Created`, as Electron's update sends only `journal:entryCreated` then. Public for `tests/journal.rs`: a lib unit test that links the Tauri
/// runtime cannot load on Windows (see `build.rs`).
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
            },
        ),
        Landed::Updated(entry) => broadcast(
            app,
            JournalEntryUpdatedEvent {
                date: entry.date.clone(),
                entry: entry.clone(),
            },
        ),
        Landed::Deleted {
            date,
            success: true,
        } => broadcast(app, JournalEntryDeletedEvent { date }),
        Landed::Read { found: false } | Landed::Deleted { success: false, .. } => {}
    }
}

/// The day's entry, `null` when it has no file. Browsing never makes a day.
#[tauri::command]
#[specta::specta]
pub async fn journal_get_entry(
    app: AppHandle<Wry>,
    date: String,
) -> Result<Option<JournalEntryView>, CommandError> {
    blocking("journal_get_entry", move || {
        let open = open_vault(&app)?;
        let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
        let day = open
            .vault
            .journal(store)
            .map_err(|error| failed(&error.into()))?;
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
pub async fn journal_create_entry(
    app: AppHandle<Wry>,
    input: JournalCreateInput,
) -> Result<JournalEntryView, CommandError> {
    blocking("journal_create_entry", move || {
        let open = open_vault(&app)?;
        let day = NewDay {
            date: input.date,
            content: input.content.unwrap_or_default(),
            tags: input.tags.unwrap_or_default(),
            properties: input.properties.unwrap_or_default(),
        };
        let entry = service(&app)?
            .create_day(&open, day)
            .map_err(|error| failed(&error))?;
        announce(&app, Landed::Created(&entry));
        Ok(entry)
    })
    .await
}

/// The day edited: its text, tags or properties; a day with no file is made.
#[tauri::command]
#[specta::specta]
pub async fn journal_update_entry(
    app: AppHandle<Wry>,
    input: JournalUpdateInput,
) -> Result<JournalEntryView, CommandError> {
    blocking("journal_update_entry", move || {
        let open = open_vault(&app)?;
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
        let updated = service(&app)?
            .update_day(&open, update)
            .map_err(|error| failed(&error))?;
        let landed = match updated.created {
            true => Landed::Created(&updated.entry),
            false => Landed::Updated(&updated.entry),
        };
        announce(&app, landed);
        Ok(updated.entry)
    })
    .await
}

/// `success` is whether the day had an entry to delete.
#[tauri::command]
#[specta::specta]
pub async fn journal_delete_entry(
    app: AppHandle<Wry>,
    date: String,
) -> Result<JournalDeleteOutput, CommandError> {
    blocking("journal_delete_entry", move || {
        let open = open_vault(&app)?;
        let success = service(&app)?
            .delete_day(&open, &date)
            .map_err(|error| failed(&error))?;
        announce(&app, Landed::Deleted { date, success });
        Ok(JournalDeleteOutput { success })
    })
    .await
}
