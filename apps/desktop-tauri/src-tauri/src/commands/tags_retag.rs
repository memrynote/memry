//! `tags:merge`, `tags:delete` and `tags:remove-from-note` (`ipc/tags-handlers.ts`), each one
//! call of `NotesService` (`memry_desktop::notes::tag_retag`). Once the note index measured the
//! files they wrote, as a rename's are (`tags::measure`), they send what Electron's handlers
//! send: a merge and a delete [`TagDeletedEvent`] for the tag that went, then
//! [`NoteTagsChangedEvent`], with their telemetry; a removal from one note
//! [`TagNotesChangedEvent`] (`removed`) and [`NoteTagsChangedEvent`], whether or not the note
//! carried it, as Electron's handler sends them.

use std::sync::Arc;

use memry_desktop::notes::tag_retag::{TagRetagged, tag_key};
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::events::Metrics;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::service;
use super::tags::{measure, open_vault, rename_failed};
use crate::events::{
    NoteTagsChangedEvent, TagDeletedEvent, TagNoteAction, TagNotesChangedEvent, broadcast,
};

/// `MergeTagSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MergeTagInput {
    pub source: String,
    pub target: String,
}

/// `RemoveTagFromNoteSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTagFromNoteInput {
    pub note_id: String,
    pub tag: String,
}

/// `MergeTagResponse` of a merge that ran: the notes, days and tasks that took the target.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeTagView {
    pub affected_items: u32,
    /// The notes and days that keep the source: merging again finishes them.
    pub failed_note_ids: Vec<String>,
}

/// `DeleteTagResponse` of a delete that ran: the notes and days that lost the tag.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTagView {
    pub affected_notes: u32,
    /// The notes and days that keep the tag: deleting again finishes them.
    pub failed_note_ids: Vec<String>,
}

/// `tags:merge`: `source` merged into `target` in every note, day and task.
#[tauri::command]
#[specta::specta]
pub async fn tags_merge<R: Runtime>(
    app: AppHandle<R>,
    input: MergeTagInput,
) -> Result<MergeTagView, CommandError> {
    blocking("tags_merge", move || {
        if input.source.is_empty() || input.target.is_empty() {
            return Err(invalid("a merge takes a source tag and a target tag"));
        }
        let open = open_vault(&app)?;
        let merged = service(&app)?
            .merge_tag(&open, &input.source, &input.target)
            .map_err(|error| rename_failed(&app, &error))?;
        let notes = landed(&app, &merged);
        broadcast(
            &app,
            TagDeletedEvent {
                tag: tag_key(&input.source),
                affected_notes: notes,
            },
        );
        broadcast(&app, NoteTagsChangedEvent);
        let items = notes.saturating_add(merged.tasks);
        track(&app, "tag_merged", "merged", &merged, items);
        Ok(MergeTagView {
            affected_items: items,
            failed_note_ids: merged.failed_note_ids,
        })
    })
    .await
}

/// `tags:delete`: the tag taken off every note, day and task, and its definition deleted.
#[tauri::command]
#[specta::specta]
pub async fn tags_delete<R: Runtime>(
    app: AppHandle<R>,
    tag: String,
) -> Result<DeleteTagView, CommandError> {
    blocking("tags_delete", move || {
        if tag.is_empty() {
            return Err(invalid("a delete takes a tag"));
        }
        let open = open_vault(&app)?;
        let deleted = service(&app)?
            .delete_tag(&open, &tag)
            .map_err(|error| rename_failed(&app, &error))?;
        let notes = landed(&app, &deleted);
        broadcast(
            &app,
            TagDeletedEvent {
                tag,
                affected_notes: notes,
            },
        );
        broadcast(&app, NoteTagsChangedEvent);
        track(&app, "tag_deleted", "deleted", &deleted, notes);
        Ok(DeleteTagView {
            affected_notes: notes,
            failed_note_ids: deleted.failed_note_ids,
        })
    })
    .await
}

/// `tags:remove-from-note`: the tag taken off one note or day.
#[tauri::command]
#[specta::specta]
pub async fn tags_remove_from_note<R: Runtime>(
    app: AppHandle<R>,
    input: RemoveTagFromNoteInput,
) -> Result<(), CommandError> {
    blocking("tags_remove_from_note", move || {
        if input.note_id.is_empty() || input.tag.is_empty() {
            return Err(invalid("a removal takes a note and a tag"));
        }
        let open = open_vault(&app)?;
        let removed = service(&app)?
            .remove_tag_from_note(&open, &input.note_id, &input.tag)
            .map_err(|error| rename_failed(&app, &error))?;
        if removed {
            measure(&app, std::slice::from_ref(&input.note_id));
        }
        broadcast(
            &app,
            TagNotesChangedEvent {
                tag: input.tag,
                note_id: input.note_id,
                action: TagNoteAction::Removed,
            },
        );
        broadcast(&app, NoteTagsChangedEvent);
        Ok(())
    })
    .await
}

/// The written files measured, so the tag list's refetch on the events reads their headers;
/// the number of notes and days written.
fn landed<R: Runtime>(app: &AppHandle<R>, retagged: &TagRetagged) -> u32 {
    measure(app, &retagged.written);
    u32::try_from(retagged.written.len()).unwrap_or(u32::MAX)
}

fn track<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    action: &str,
    retagged: &TagRetagged,
    items: u32,
) {
    let Some(telemetry) = app.try_state::<Arc<Service>>() else {
        return;
    };
    let mut event = Service::event(name, "tags", action);
    event.object_type = Some("tag".to_owned());
    let failed = !retagged.failed_note_ids.is_empty();
    event.result = Some(if failed { "failed" } else { "success" }.to_owned());
    event.metrics = Some(Metrics {
        item_count: Some(f64::from(items)),
        ..Metrics::default()
    });
    telemetry.track_main_event(event);
}

fn invalid(what: &str) -> CommandError {
    CommandError::new(ErrorKind::Invalid, "invalid", what)
}
