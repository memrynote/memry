//! `tags:merge`, `tags:delete` and `tags:remove-from-note` (`ipc/tags-handlers.ts`), each one
//! call of `NotesService` (`memry_desktop::notes::tag_retag`). Once the note index measured the
//! files they wrote and the days among them were told (`written_landed`), as a rename's
//! are, they send what Electron's handlers
//! send: a merge and a delete [`TagDeletedEvent`] for the tag that went, then
//! [`NoteTagsChangedEvent`], with their telemetry; a removal from one note
//! [`TagNotesChangedEvent`] (`removed`) and [`NoteTagsChangedEvent`], whether or not the note
//! carried it, as Electron's handler sends them.

use std::sync::Arc;

use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::tag_retag::{KeptNote, TagRetagged, tag_key};
use memry_desktop::session::Session;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::events::Metrics;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::CommandError;
use super::notes::service;
use super::tags::{open_vault, tag_change_failed};
use crate::events::{
    JournalExternalChange, JournalExternalChangeEvent, NoteTagsChangedEvent, TagDeletedEvent,
    TagNoteAction, TagNotesChangedEvent, broadcast,
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
    /// The notes and days that keep the source.
    pub failed_notes: Vec<KeptNoteView>,
    /// Merging again can finish every one of them; else some need their file fixed first.
    pub retry_finishes: bool,
}

/// `DeleteTagResponse` of a delete that ran: the notes and days that lost the tag.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTagView {
    pub affected_notes: u32,
    /// The notes and days that keep the tag.
    pub failed_notes: Vec<KeptNoteView>,
    /// Deleting again can finish every one of them; else some need their file fixed first.
    pub retry_finishes: bool,
}

/// A note or day a merge or delete could not write, named by its file's name.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct KeptNoteView {
    pub id: String,
    pub title: String,
}

/// `tags:merge`: `source` merged into `target` in every note, day and task.
#[tauri::command]
#[specta::specta]
pub async fn tags_merge<R: Runtime>(
    app: AppHandle<R>,
    input: MergeTagInput,
) -> Result<MergeTagView, CommandError> {
    blocking("tags_merge", move || {
        let open = open_vault(&app)?;
        let merged = service(&app)?
            .merge_tag(&open, &input.source, &input.target)
            .map_err(|error| tag_change_failed(&app, &error))?;
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
        let (failed_notes, retry_finishes) = kept(merged.failed);
        Ok(MergeTagView {
            affected_items: items,
            failed_notes,
            retry_finishes,
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
        let open = open_vault(&app)?;
        let deleted = service(&app)?
            .delete_tag(&open, &tag)
            .map_err(|error| tag_change_failed(&app, &error))?;
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
        let (failed_notes, retry_finishes) = kept(deleted.failed);
        Ok(DeleteTagView {
            affected_notes: notes,
            failed_notes,
            retry_finishes,
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
        let open = open_vault(&app)?;
        let removed = service(&app)?
            .remove_tag_from_note(&open, &input.note_id, &input.tag)
            .map_err(|error| tag_change_failed(&app, &error))?;
        if removed {
            written_landed(&app, std::slice::from_ref(&input.note_id));
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

/// The written files measured, so the tag list's refetch on the events reads their headers, and
/// the days among them told; the number of notes and days written.
fn landed<R: Runtime>(app: &AppHandle<R>, retagged: &TagRetagged) -> u32 {
    written_landed(app, &retagged.written);
    u32::try_from(retagged.written.len()).unwrap_or(u32::MAX)
}

/// The kept notes named, and whether asking again can finish all of them.
fn kept(failed: Vec<KeptNote>) -> (Vec<KeptNoteView>, bool) {
    let retry_finishes = failed.iter().all(|note| note.retry_finishes);
    let notes = failed
        .into_iter()
        .map(|note| KeptNoteView {
            id: note.id,
            title: note.title,
        })
        .collect();
    (notes, retry_finishes)
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
    let failed = !retagged.failed.is_empty();
    event.result = Some(if failed { "failed" } else { "success" }.to_owned());
    event.metrics = Some(Metrics {
        item_count: Some(f64::from(items)),
        ..Metrics::default()
    });
    telemetry.track_main_event(event);
}

/// The files a tag change wrote measured into their index rows, then each journal day among
/// them told its change (`journal:externalChange`): a day's change is its record alone (#3931),
/// which no file event reports, and a day page still holding the old tags would write them
/// back on its next tag edit. A file left to a pass lags the list until the pass writes it,
/// which sends [`NoteTagsChangedEvent`] again (`shell::journal_events::landed`).
pub(super) fn written_landed<R: Runtime>(app: &AppHandle<R>, written: &[String]) {
    match app.try_state::<Arc<NoteIndex>>() {
        Some(index) => measure(&index, written),
        None => tracing::warn!(
            scope = "TagsHandlers",
            "no note index: the tag list lags the tag change"
        ),
    }
    let Some(open) = app.state::<Session>().current() else {
        return;
    };
    for note_id in written {
        match open.search.note_stats(note_id) {
            Ok(Some(row)) => {
                if let Some(date) = row.date {
                    let kind = JournalExternalChange::Modified;
                    broadcast(app, JournalExternalChangeEvent { date, kind });
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                scope = "TagsHandlers",
                note_id,
                "a written day's date did not read: {error}"
            ),
        }
    }
}

fn measure(index: &NoteIndex, written: &[String]) {
    for note_id in written {
        match index.measure(note_id) {
            Ok(true) => {}
            Ok(false) => {
                tracing::debug!(scope = "TagsHandlers", note_id, "measured by a later pass")
            }
            Err(error) => {
                tracing::warn!(
                    scope = "TagsHandlers",
                    "the tag list lags the tag change: {error}"
                );
                return;
            }
        }
    }
}
