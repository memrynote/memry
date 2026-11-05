//! Relation chips (`properties:resolveRefs`, `ipc/relation-handlers.ts`; #3530 13q-2): each
//! `memry://<kind>/<id>` value a relation property holds, resolved to what its chip shows.
//!
//! The answer keeps the input's order and length. A malformed value or a missing target is
//! `exists: false`, never an error, so one bad ref cannot blank the property row; only a failed
//! read fails the call. Each kind is read through its owner's read, one per ref: a note's
//! listed record, a task, an event, an imported event (archived ones included, and through a
//! promotion to the native event), a canvas that is not deleted, and a journal day that has a
//! file (desktop reads the note index, which holds only days with one).

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use memry_core::domain::property_values::parse_relation_uri;
use serde::Serialize;

use super::super::error::{NotesError, SCOPE};
use super::super::service::NotesService;
use crate::session::OpenVault;

/// `RelationKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum RelationKind {
    Note,
    Task,
    Event,
    ExternalEvent,
    Canvas,
    Journal,
}

/// `ResolvedRelationRef`: a relation value and what its chip shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRelationRefView {
    pub uri: String,
    pub target_type: RelationKind,
    pub target_id: String,
    pub title: String,
    pub exists: bool,
    /// Note targets that are not markdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub file_type: Option<String>,
    /// Note targets with an icon; chips show it instead of the kind icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub emoji: Option<String>,
    /// Task targets in a project; scopes the tasks list when a chip navigates.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub project_id: Option<String>,
    /// Event targets: the calendar moves its range to it before it focuses the event.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub start_at: Option<String>,
    /// Event targets: the calendar item to focus.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub calendar_item_id: Option<String>,
    /// Journal targets: the day, which is also the target id.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub date: Option<String>,
}

impl ResolvedRelationRefView {
    fn missing(uri: &str, target_type: RelationKind, target_id: &str) -> Self {
        Self {
            uri: uri.to_owned(),
            target_type,
            target_id: target_id.to_owned(),
            title: String::new(),
            exists: false,
            file_type: None,
            emoji: None,
            project_id: None,
            start_at: None,
            calendar_item_id: None,
            date: None,
        }
    }

    fn found(uri: &str, target_type: RelationKind, target_id: &str, title: String) -> Self {
        Self {
            title,
            exists: true,
            ..Self::missing(uri, target_type, target_id)
        }
    }
}

impl NotesService {
    /// `resolveRefs`: `uris` resolved one to one, in order.
    pub fn resolve_refs(
        &self,
        open: &OpenVault,
        uris: &[String],
    ) -> Result<Vec<ResolvedRelationRefView>, NotesError> {
        uris.iter().map(|uri| self.resolve_ref(open, uri)).collect()
    }

    fn resolve_ref(
        &self,
        open: &OpenVault,
        uri: &str,
    ) -> Result<ResolvedRelationRefView, NotesError> {
        let Some((kind, id)) = parse_relation_uri(uri) else {
            tracing::warn!(scope = SCOPE, uri, "malformed relation URI");
            return Ok(ResolvedRelationRefView::missing(
                uri,
                RelationKind::Note,
                "",
            ));
        };
        let vault = &open.vault;
        let store = || self.store.clone();
        let view = match kind {
            "note" => match vault.note_files().listed_by_id(id)? {
                None => ResolvedRelationRefView::missing(uri, RelationKind::Note, id),
                Some(note) => ResolvedRelationRefView {
                    file_type: (note.file_type != "markdown").then_some(note.file_type),
                    emoji: note.emoji.filter(|emoji| !emoji.is_empty()),
                    ..ResolvedRelationRefView::found(uri, RelationKind::Note, id, note.title)
                },
            },
            "task" => match vault.tasks(store())?.get(id.to_owned())? {
                None => ResolvedRelationRefView::missing(uri, RelationKind::Task, id),
                Some(task) => ResolvedRelationRefView {
                    project_id: Some(task.project_id).filter(|project| !project.is_empty()),
                    ..ResolvedRelationRefView::found(uri, RelationKind::Task, id, task.title)
                },
            },
            "event" => match vault.calendar(store())?.event(id.to_owned())? {
                None => ResolvedRelationRefView::missing(uri, RelationKind::Event, id),
                Some(event) => ResolvedRelationRefView {
                    start_at: Some(event.start_at),
                    calendar_item_id: Some(id.to_owned()),
                    ..ResolvedRelationRefView::found(uri, RelationKind::Event, id, event.title)
                },
            },
            "external-event" => {
                let kind = RelationKind::ExternalEvent;
                let relation = match external_row_id(id) {
                    Some(row_id) => vault.calendar(store())?.external_relation(row_id)?,
                    None => None,
                };
                match relation {
                    None => ResolvedRelationRefView::missing(uri, kind, id),
                    Some(event) => ResolvedRelationRefView {
                        start_at: Some(event.start_at),
                        calendar_item_id: Some(event.calendar_item_id),
                        ..ResolvedRelationRefView::found(uri, kind, id, event.title)
                    },
                }
            }
            "canvas" => match vault.canvases(store())?.canvas(id.to_owned())? {
                None => ResolvedRelationRefView::missing(uri, RelationKind::Canvas, id),
                Some(canvas) => {
                    let title = canvas.title.unwrap_or_default();
                    ResolvedRelationRefView::found(uri, RelationKind::Canvas, id, title)
                }
            },
            _ => {
                let kind = RelationKind::Journal;
                let path = vault.journal(store())?.stamp(id)?.and_then(|day| day.path);
                match path {
                    None => ResolvedRelationRefView::missing(uri, kind, id),
                    // The day's title is its file's name; the date when that is empty.
                    Some(path) => {
                        let stem = Path::new(&path).file_stem().and_then(|stem| stem.to_str());
                        let title = stem.filter(|stem| !stem.is_empty()).unwrap_or(id);
                        ResolvedRelationRefView {
                            date: Some(id.to_owned()),
                            ..ResolvedRelationRefView::found(uri, kind, id, title.to_owned())
                        }
                    }
                }
            }
        };
        Ok(view)
    }
}

/// `decodeExternalEventRelationId`: the mirror row id a relation id names, in unpadded
/// base64url of UTF-8; `None` when it is not.
fn external_row_id(id: &str) -> Option<String> {
    String::from_utf8(URL_SAFE_NO_PAD.decode(id).ok()?).ok()
}
