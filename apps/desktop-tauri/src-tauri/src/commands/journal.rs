//! The journal commands of Step 13m-2 (`journal:getEntry`, `journal:createEntry`,
//! `journal:deleteEntry` of `ipc/journal-handlers.ts`), each one call of `memry_desktop::journal`.
//! A create and a delete send their journal event after the write.

use std::sync::Arc;

use memry_desktop::journal::write::NewDay;
use memry_desktop::journal::{self, JournalEntryView};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::telemetry::Service;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::CommandError;
use crate::events::{JournalEntryCreatedEvent, JournalEntryDeletedEvent, broadcast};
use crate::shell::services;

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

/// `journal_opened`, as the Electron handler counts it.
fn track_opened(app: &AppHandle<Wry>) {
    if let Some(telemetry) = services::telemetry(app) {
        let mut event = Service::event("journal_opened", "journal", "opened");
        event.object_type = Some("journal".to_owned());
        event.result = Some("success".to_owned());
        telemetry.track_main_event(event);
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
        if entry.is_some() {
            track_opened(&app);
        }
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
        broadcast(
            &app,
            JournalEntryCreatedEvent {
                date: entry.date.clone(),
                entry: entry.clone(),
            },
        );
        Ok(entry)
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
        if success {
            broadcast(&app, JournalEntryDeletedEvent { date });
        }
        Ok(JournalDeleteOutput { success })
    })
    .await
}
